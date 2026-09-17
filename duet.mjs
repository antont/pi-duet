#!/usr/bin/env node
// duet - two long-lived pi agents (supervisor + worker) in one terminal.
//
// Each agent is a persistent `pi --mode rpc` process with its own session file,
// so context is retained across rounds and across duet restarts. Everything is
// rendered into this single stdout stream: no tmux, no panes, native scrollback
// and copy-paste.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const STATE_DIR = path.join(HERE, 'state')
const RUNS_DIR = path.join(HERE, 'runs')

// ---------------------------------------------------------------- cli options
const argv = process.argv.slice(2)
const opt = (name, fallback) => {
	const i = argv.indexOf(`--${name}`)
	return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const flag = (name) => argv.includes(`--${name}`)

const CWD = path.resolve(opt('cwd', process.cwd()))
const SUPERVISOR_MODEL = opt('supervisor-model', 'github-copilot/gpt-5.6-sol')
const WORKER_MODEL = opt('worker-model', 'github-copilot/claude-opus-5')
const SUPERVISOR_THINKING = opt('supervisor-thinking', 'high')
const WORKER_THINKING = opt('worker-thinking', 'medium')
const SUPERVISOR_PROMPT = path.resolve(opt('supervisor-prompt', path.join(HERE, 'roles', 'supervisor.md')))
const WORKER_PROMPT = path.resolve(opt('worker-prompt', path.join(HERE, 'roles', 'worker.md')))
const FRESH = flag('fresh')
const ONLY = (opt('only', 'both') || 'both').toUpperCase() // merged-window filter: S, W or BOTH
let MAX_ROUNDS = Number(opt('rounds', '3'))

if (flag('help')) {
	console.log(`duet - supervisor/worker pi agents in one terminal

  node duet.mjs [--cwd DIR] [--fresh] [--rounds N] [--only S|W]
                [--supervisor-model P/M] [--worker-model P/M]
                [--supervisor-thinking L] [--worker-thinking L]
                [--supervisor-prompt FILE] [--worker-prompt FILE]

Each agent is also streamed to its own file, so you can watch one of them in a
separate window while the merged view stays here:

  tail -f ~/pi-duet/runs/latest-W.log     # worker only
  tail -f ~/pi-duet/runs/latest-S.log     # supervisor only

Use --only S (or --only W) to keep the other agent out of THIS window.

In-session commands:
  <text>          start a supervised cycle for that goal
  /s <text>       talk to the supervisor only (no worker dispatch)
  /w <text>       talk to the worker only (no review)
  /rounds N       max worker rounds per cycle (current: ${MAX_ROUNDS})
  /abort          abort whatever is currently running
  /state          show models, session files, transcript path
  /quit           stop both agents and exit

While a round is running, anything you type is delivered to the active agent as
a steering message at its next turn boundary.`)
	process.exit(0)
}

// ------------------------------------------------------------------- plumbing
function piCli() {
	if (process.env.PI_DUET_CLI) return process.env.PI_DUET_CLI
	const candidates = []

	// 1. Follow `pi` on PATH. npm's global bin entry is a symlink straight to the
	//    bundle on POSIX, which covers nvm/fnm/volta/custom prefixes for free.
	const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : ['']
	for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
		// WSL appends the Windows PATH, so a Windows pi install shows up here. It
		// cannot be run by the Linux node, so never consider it.
		if (process.platform !== 'win32' && dir.startsWith('/mnt/')) continue
		for (const ext of exts) {
			const binary = path.join(dir, `pi${ext}`)
			if (!fs.existsSync(binary)) continue
			try {
				const real = fs.realpathSync(binary)
				if (real.endsWith('.js')) candidates.push(real)
				candidates.push(path.join(path.dirname(real), '..', 'dist', 'bundle', 'cli.js'))
			} catch {}
		}
	}

	// 2. Ask npm where global modules live (slow-ish, so only after the PATH scan).
	try {
		const root = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim()
		if (root) candidates.push(path.join(root, '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'))
	} catch {}

	// 3. Local resolution and well-known prefixes.
	try {
		candidates.push(createRequire(import.meta.url).resolve('@earendil-works/pi-coding-agent/dist/bundle/cli.js'))
	} catch {}
	const pkg = path.join('@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js')
	candidates.push(
		path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', pkg),
		path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', pkg),
		path.join('/usr/local/lib/node_modules', pkg),
		path.join('/usr/lib/node_modules', pkg),
	)

	const found = candidates.find((c) => c && fs.existsSync(c))
	if (!found) {
		console.error('duet: cannot locate the pi CLI bundle; set PI_DUET_CLI to dist/bundle/cli.js')
		console.error('duet: looked at:\n  ' + candidates.filter(Boolean).join('\n  '))
		process.exit(1)
	}
	return found
}
const PI_CLI = piCli()

const C = {
	sup: '\u001b[36m', // cyan
	wrk: '\u001b[32m', // green
	sys: '\u001b[33m', // yellow
	dim: '\u001b[2m',
	err: '\u001b[31m',
	off: '\u001b[0m',
}

fs.mkdirSync(STATE_DIR, { recursive: true })
fs.mkdirSync(RUNS_DIR, { recursive: true })
const slug = CWD.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(-60)
const STATE_FILE = path.join(STATE_DIR, `${slug}.json`)
const TRANSCRIPT = path.join(RUNS_DIR, `${slug}-${new Date().toISOString().replace(/[:.]/g, '-')}.md`)

const loadState = () => {
	if (FRESH) return {}
	try {
		return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
	} catch {
		return {}
	}
}
const saveState = (state) => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n')
const state = loadState()

const transcript = (line) => fs.appendFileSync(TRANSCRIPT, line)

// Per-agent streams, so a second terminal can `tail -f` one agent in isolation
// while this window keeps the merged view.
const STREAMS = {
	S: path.join(RUNS_DIR, `${slug}-${new Date().toISOString().replace(/[:.]/g, '-')}-S.log`),
	W: path.join(RUNS_DIR, `${slug}-${new Date().toISOString().replace(/[:.]/g, '-')}-W.log`),
}
for (const [tag, file] of Object.entries(STREAMS)) {
	fs.writeFileSync(file, '')
	const stable = path.join(RUNS_DIR, `latest-${tag}.log`)
	try {
		if (fs.existsSync(stable) || fs.lstatSync(stable, { throwIfNoEntry: false })) fs.unlinkSync(stable)
	} catch {}
	try {
		fs.symlinkSync(file, stable)
	} catch {
		// Windows without developer mode: no symlinks. Leave a pointer instead.
		try {
			fs.writeFileSync(path.join(RUNS_DIR, `latest-${tag}.path`), file + '\n')
		} catch {}
	}
}
const streamWrite = (tag, text) => {
	const file = STREAMS[tag]
	if (file) fs.appendFileSync(file, text)
}

let atLineStart = true
function out(color, tag, text, { raw = false } = {}) {
	if (!text) return
	// Agent output always reaches its own stream, even when filtered out here.
	if (!raw) streamWrite(tag.replace('!', ''), text)
	if (ONLY !== 'BOTH' && (tag === 'S' || tag === 'W') && tag !== ONLY) {
		if (!raw) transcript(text)
		return
	}
	const prefix = `${color}[${tag}]${C.off} `
	let chunk = ''
	for (const ch of text) {
		if (atLineStart) {
			chunk += prefix
			atLineStart = false
		}
		chunk += ch
		if (ch === '\n') atLineStart = true
	}
	process.stdout.write(chunk)
	if (!raw) transcript(text.replace(/\u001b\[[0-9;]*m/g, ''))
}
function line(color, tag, text) {
	if (!atLineStart) {
		process.stdout.write('\n')
		atLineStart = true
	}
	out(color, tag, text.endsWith('\n') ? text : text + '\n')
}
const sysline = (text) => line(C.sys, 'duet', text)

// ---------------------------------------------------------------- agent class
class Agent {
	constructor({ tag, color, model, thinking, promptFile, sessionFile }) {
		this.tag = tag
		this.color = color
		this.model = model
		this.thinking = thinking
		this.promptFile = promptFile
		this.sessionFile = sessionFile
		this.nextId = 1
		this.pending = new Map()
		this.settleWaiters = []
		this.busy = false
		this.buffer = ''
	}

	start() {
		const args = ['--mode', 'rpc', '--model', this.model, '--thinking', this.thinking, '--append-system-prompt', this.promptFile, '--approve']
		if (this.sessionFile && fs.existsSync(this.sessionFile)) args.push('--session', this.sessionFile)
		this.proc = spawn(process.execPath, [PI_CLI, ...args], { cwd: CWD, shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
		this.proc.stdout.on('data', (chunk) => this._onStdout(chunk))
		this.proc.stderr.on('data', (chunk) => {
			const text = chunk.toString().trim()
			if (text) line(C.dim, this.tag + '!', text)
		})
		this.proc.on('exit', (code) => {
			if (!shuttingDown) sysline(`${this.tag} exited with code ${code}`)
		})
	}

	_onStdout(chunk) {
		this.buffer += chunk.toString('utf8')
		while (true) {
			const nl = this.buffer.indexOf('\n')
			if (nl === -1) break
			let raw = this.buffer.slice(0, nl)
			this.buffer = this.buffer.slice(nl + 1)
			if (raw.endsWith('\r')) raw = raw.slice(0, -1)
			if (!raw.trim()) continue
			let event
			try {
				event = JSON.parse(raw)
			} catch {
				continue
			}
			this._onEvent(event)
		}
	}

	_onEvent(event) {
		if (event.type === 'response') {
			const resolve = this.pending.get(event.id)
			if (resolve) {
				this.pending.delete(event.id)
				resolve(event)
			}
			return
		}
		switch (event.type) {
			case 'agent_start':
				this.busy = true
				break
			case 'message_update': {
				const delta = event.assistantMessageEvent
				if (delta?.type === 'text_delta') out(this.color, this.tag, delta.delta)
				else if (delta?.type === 'thinking_start') line(C.dim, this.tag, '· thinking…')
				break
			}
			case 'tool_execution_start':
				line(C.dim, this.tag, `· ${describeTool(event.toolName, event.args)}`)
				break
			case 'tool_execution_end':
				if (event.isError) line(C.err, this.tag, `· ${event.toolName} failed`)
				break
			case 'agent_settled': {
				this.busy = false
				const waiters = this.settleWaiters
				this.settleWaiters = []
				for (const w of waiters) w()
				break
			}
		}
	}

	request(command) {
		const id = `duet-${this.tag}-${this.nextId++}`
		return new Promise((resolve) => {
			this.pending.set(id, resolve)
			this.proc.stdin.write(JSON.stringify({ ...command, id }) + '\n')
		})
	}

	settled() {
		return new Promise((resolve) => this.settleWaiters.push(resolve))
	}

	async ask(message) {
		const settle = this.settled()
		line(C.dim, this.tag, `· prompt (${message.length} chars)`)
		const response = await this.request({ type: 'prompt', message })
		if (!response.success) {
			line(C.err, this.tag, `prompt rejected: ${response.error ?? 'unknown error'}`)
			return ''
		}
		await settle
		if (!atLineStart) process.stdout.write('\n'), (atLineStart = true)
		const last = await this.request({ type: 'get_last_assistant_text' })
		return last.data?.text ?? ''
	}

	steer(message) {
		this.proc.stdin.write(JSON.stringify({ type: 'steer', message }) + '\n')
	}

	abort() {
		this.proc.stdin.write(JSON.stringify({ type: 'abort' }) + '\n')
	}

	async captureSessionFile() {
		const response = await this.request({ type: 'get_state' })
		this.sessionFile = response.data?.sessionFile
		return this.sessionFile
	}

	stop() {
		try {
			this.proc.stdin.end()
		} catch {}
		this.proc.kill()
	}
}

function describeTool(name, args = {}) {
	if (name === 'bash') return `$ ${truncate(args.command ?? '', 120)}`
	if (name === 'read') return `read ${args.path ?? ''}`
	if (name === 'edit') return `edit ${args.path ?? ''}`
	if (name === 'write') return `write ${args.path ?? ''}`
	const first = Object.values(args)[0]
	return `${name} ${typeof first === 'string' ? truncate(first, 80) : ''}`.trim()
}
const truncate = (text, max) => (text.length > max ? text.slice(0, max) + '…' : text)

// ------------------------------------------------------------------ the agents
const supervisor = new Agent({
	tag: 'S',
	color: C.sup,
	model: SUPERVISOR_MODEL,
	thinking: SUPERVISOR_THINKING,
	promptFile: SUPERVISOR_PROMPT,
	sessionFile: state.supervisorSession,
})
const worker = new Agent({
	tag: 'W',
	color: C.wrk,
	model: WORKER_MODEL,
	thinking: WORKER_THINKING,
	promptFile: WORKER_PROMPT,
	sessionFile: state.workerSession,
})

// ------------------------------------------------------------------ the cycle
const TASK_RE = /<<<TASK\s*([\s\S]*?)\s*TASK>>>/
const VERDICT_RE = /^\s*VERDICT:\s*(APPROVED|REVISE|BLOCKED|HUMAN)\b/im

function worktreeSummary() {
	const run = (args) => {
		try {
			return execFileSync('git', args, { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
		} catch {
			return ''
		}
	}
	const status = run(['status', '--short'])
	const stat = run(['diff', '--stat', 'HEAD'])
	return truncate(`git status --short:\n${status || '(clean)'}\n\ngit diff --stat HEAD:\n${stat || '(no changes)'}`, 4000)
}

let busy = false
let active = null

async function cycle(goal) {
	busy = true
	try {
		let message = `GOAL FROM HUMAN:\n${goal}\n\nDecide the next slice and emit exactly one <<<TASK ... TASK>>> block for the worker, or a VERDICT line if no work should be dispatched.`
		for (let round = 1; round <= MAX_ROUNDS; round++) {
			active = supervisor
			const supervisorText = await supervisor.ask(message)
			const verdict = supervisorText.match(VERDICT_RE)?.[1]?.toUpperCase()
			const task = supervisorText.match(TASK_RE)?.[1]

			if (verdict === 'APPROVED' || verdict === 'BLOCKED' || verdict === 'HUMAN') {
				sysline(`cycle finished: ${verdict} (round ${round})`)
				return
			}
			if (!task) {
				sysline('supervisor emitted no TASK block and no terminal verdict — back to you')
				return
			}

			active = worker
			const workerText = await worker.ask(`TASK FROM SUPERVISOR (round ${round}/${MAX_ROUNDS}):\n${task}`)

			message = `WORKER REPORT (round ${round}/${MAX_ROUNDS}):\n${workerText}\n\nWORKING TREE:\n${worktreeSummary()}\n\nReview the actual changes on disk, not just the report. Then either emit VERDICT: APPROVED / BLOCKED / HUMAN, or a single <<<TASK ... TASK>>> block with the revisions.`
		}
		// Never end on an unreviewed worker round: force a final verdict.
		active = supervisor
		await supervisor.ask(`${message}\n\nROUND LIMIT (${MAX_ROUNDS}) REACHED: do not emit a TASK block. Emit a verdict line and, if it is not APPROVED, state exactly what remains.`)
		sysline(`round limit (${MAX_ROUNDS}) reached — back to you`)
	} finally {
		busy = false
		active = null
	}
}

async function soloAsk(agent, message) {
	busy = true
	active = agent
	try {
		await agent.ask(message)
	} finally {
		busy = false
		active = null
	}
}

// ------------------------------------------------------------------- the shell
let shuttingDown = false

async function main() {
	sysline(`cwd        ${CWD}`)
	sysline(`supervisor ${SUPERVISOR_MODEL} (thinking: ${SUPERVISOR_THINKING})`)
	sysline(`worker     ${WORKER_MODEL} (thinking: ${WORKER_THINKING})`)
	supervisor.start()
	worker.start()
	const [supervisorSession, workerSession] = await Promise.all([supervisor.captureSessionFile(), worker.captureSessionFile()])
	saveState({ supervisorSession, workerSession })
	sysline(`sessions   ${state.supervisorSession ? 'resumed' : 'new'} · ${path.basename(supervisorSession ?? '?')} / ${path.basename(workerSession ?? '?')}`)
	sysline(`transcript ${TRANSCRIPT}`)
	sysline(`stream S   tail -f ${path.join(RUNS_DIR, 'latest-S.log')}`)
	sysline(`stream W   tail -f ${path.join(RUNS_DIR, 'latest-W.log')}`)
	if (ONLY !== 'BOTH') sysline(`merged view filtered to ${ONLY} (--only)`)
	sysline('type a goal, or /s /w /rounds /abort /state /quit')

	const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false })
	rl.on('line', (input) => {
		const text = input.trim()
		if (!text) return
		transcript(`\n[you] ${text}\n`)

		if (text === '/quit' || text === '/exit') return shutdown(0)
		if (text === '/abort') {
			active?.abort()
			sysline(active ? `abort sent to ${active.tag}` : 'nothing running')
			return
		}
		if (text === '/state') {
			sysline(`supervisor ${SUPERVISOR_MODEL} · ${supervisor.sessionFile}`)
			sysline(`worker     ${WORKER_MODEL} · ${worker.sessionFile}`)
			sysline(`rounds ${MAX_ROUNDS} · busy ${busy ? active?.tag : 'no'} · transcript ${TRANSCRIPT}`)
			return
		}
		const rounds = text.match(/^\/rounds\s+(\d+)$/)
		if (rounds) {
			MAX_ROUNDS = Number(rounds[1])
			sysline(`max rounds per cycle: ${MAX_ROUNDS}`)
			return
		}

		if (busy) {
			const target = text.startsWith('/s ') ? supervisor : text.startsWith('/w ') ? worker : active
			const body = text.replace(/^\/[sw]\s+/, '')
			target?.steer(body)
			sysline(`steering ${target?.tag} at its next turn boundary`)
			return
		}

		if (text.startsWith('/s ')) return void soloAsk(supervisor, text.slice(3))
		if (text.startsWith('/w ')) return void soloAsk(worker, text.slice(3))
		if (text.startsWith('/')) return sysline(`unknown command: ${text.split(' ')[0]}`)
		void cycle(text)
	})
	rl.on('close', () => {
		// With piped stdin the reader closes immediately; let any in-flight work finish.
		const waitForIdle = () => (busy ? setTimeout(waitForIdle, 200) : shutdown(0))
		waitForIdle()
	})
}

function shutdown(code) {
	if (shuttingDown) return
	shuttingDown = true
	sysline('stopping agents…')
	supervisor.stop()
	worker.stop()
	setTimeout(() => process.exit(code), 200)
}

process.on('SIGINT', () => {
	if (busy && active) {
		active.abort()
		sysline(`abort sent to ${active.tag} (Ctrl+C again to quit)`)
		return
	}
	shutdown(0)
})

main().catch((error) => {
	console.error(error)
	shutdown(1)
})
