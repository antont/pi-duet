/**
 * duet-mail - message passing between two (or more) pi windows.
 *
 * Each window takes a role (DUET_ROLE, e.g. "supervisor" / "worker") and gets a
 * mailbox directory. Incoming mail is injected into that session and triggers a
 * turn, so a message from another window reads like a user message and the
 * window renders it natively - no orchestrator, no reimplemented TUI.
 *
 * Usage:
 *   # window 1
 *   DUET_ROLE=supervisor pi -e ~/pi-duet/mail/index.ts --model github-copilot/gpt-5.6-sol
 *   # window 2
 *   DUET_ROLE=worker     pi -e ~/pi-duet/mail/index.ts --model github-copilot/claude-opus-5
 *
 * The model sends mail with the `message` tool; you send mail with `/to`:
 *   /to worker start with a survey of features/mission_flight
 *   /inbox                      show pending mail and hop count
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { Type } from "typebox";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ROLE = process.env.DUET_ROLE?.trim() || "agent";

// Mailboxes are scoped per working tree, so two projects running duet at the
// same time cannot deliver into each other's windows.
function defaultMailDir(): string {
	let key = process.cwd();
	try {
		key = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim() || key;
	} catch {}
	return path.join(os.homedir(), ".duet-mail", key.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, ""));
}
const MAIL_DIR = process.env.DUET_MAIL_DIR?.trim() || defaultMailDir();
// Runaway ping-pong guard: a chain of messages that never involves a human dies
// here instead of burning tokens all night.
const MAX_HOPS = Number(process.env.DUET_MAX_HOPS || 24);
const POLL_MS = 1000;

// Who may talk to the remote. The worker commits locally; only the supervisor
// pushes, pulls, fetches or touches gh. Override with DUET_REMOTE=allow|deny.
const REMOTE_POLICY = (process.env.DUET_REMOTE?.trim() || (ROLE === "worker" ? "deny" : "allow")).toLowerCase();

const DENIED_COMMANDS: Array<{ re: RegExp; what: string }> = [
	{ re: /^gh(\s|$)/, what: "gh (the GitHub CLI)" },
	{ re: /^git\s+push(\s|$)/, what: "git push" },
	{ re: /^git\s+pull(\s|$)/, what: "git pull" },
	{ re: /^git\s+fetch(\s|$)/, what: "git fetch" },
	{ re: /^git\s+clone(\s|$)/, what: "git clone" },
	{ re: /^git\s+remote\s+(add|set-url|rename|remove|rm|prune)(\s|$)/, what: "git remote mutation" },
	{ re: /^git\s+submodule\s+(add|update)(\s|$)/, what: "git submodule fetch" },
];

/** The denied operation in a compound command, or null if all segments are fine. */
function deniedOperation(command: string): string | null {
	// Check each segment of a pipeline/chain, not the whole string: substring
	// matching would both miss `a && git push` and trip on `echo "git push"`.
	for (const raw of command.split(/\n|\|\||&&|;|\||\$\(|`/)) {
		const segment = raw
			.trim()
			.replace(/^[({\s]+/, "")
			.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, "") // FOO=bar git push
			.replace(/^(?:sudo|command|env|nohup|time|xargs)\s+/, "");
		for (const rule of DENIED_COMMANDS) {
			if (rule.re.test(segment)) return rule.what;
		}
	}
	return null;
}

// Where the write/edit tools may operate. Defaults to the working tree; extra
// roots can be added with DUET_WRITE_ALLOW=/path/one:/path/two, and the whole
// check is lifted with DUET_WRITE_SCOPE=any.
const WRITE_SCOPE = (process.env.DUET_WRITE_SCOPE?.trim() || "cwd").toLowerCase();
const WRITE_ROOTS = [
	process.cwd(),
	...(process.env.DUET_WRITE_ALLOW?.split(path.delimiter).filter(Boolean) ?? []),
].map((root) => {
	try {
		return fs.realpathSync(root);
	} catch {
		return path.resolve(root);
	}
});

/** Resolve through symlinks using the nearest existing ancestor of `target`. */
function resolveIntent(target: string): string {
	const absolute = path.resolve(process.cwd(), target);
	let existing = absolute;
	while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
		existing = path.dirname(existing);
	}
	try {
		return path.join(fs.realpathSync(existing), path.relative(existing, absolute));
	} catch {
		return absolute;
	}
}

function outsideWriteScope(target: string): boolean {
	const resolved = resolveIntent(target);
	return !WRITE_ROOTS.some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

interface Mail {
	from: string;
	to: string;
	text: string;
	hops: number;
	sentAt: string;
}

const inboxOf = (role: string) => path.join(MAIL_DIR, role);

function deliver(mail: Mail): void {
	const dir = inboxOf(mail.to);
	fs.mkdirSync(dir, { recursive: true });
	const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
	const tmp = path.join(dir, `.${name}.tmp`);
	fs.writeFileSync(tmp, JSON.stringify(mail, null, 2));
	fs.renameSync(tmp, path.join(dir, name)); // atomic: a reader never sees half a message
}

function collect(role: string): Mail[] {
	const dir = inboxOf(role);
	let names: string[] = [];
	try {
		names = fs.readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith("."));
	} catch {
		return [];
	}
	const mail: Mail[] = [];
	for (const name of names.sort()) {
		const file = path.join(dir, name);
		try {
			mail.push(JSON.parse(fs.readFileSync(file, "utf-8")) as Mail);
			fs.unlinkSync(file);
		} catch {
			try {
				fs.unlinkSync(file);
			} catch {}
		}
	}
	return mail;
}

export default function (pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	let timer: NodeJS.Timeout | undefined;
	let lastHops = 0;

	const inject = (mail: Mail) => {
		lastHops = mail.hops;
		if (mail.hops > MAX_HOPS) {
			ctx?.ui.notify(`duet-mail: dropped message from ${mail.from} (hop limit ${MAX_HOPS} reached)`, "warning");
			return;
		}
		pi.sendMessage(
			{
				customType: "duet-mail",
				content: `Message from ${mail.from} (hop ${mail.hops}/${MAX_HOPS}):\n\n${mail.text}`,
				display: true,
				details: { from: mail.from, hops: mail.hops, sentAt: mail.sentAt },
			},
			// followUp: never cut into a turn mid-flight. triggerTurn: if this
			// window is idle, wake it up and let it answer.
			{ deliverAs: "followUp", triggerTurn: true },
		);
	};

	pi.on("session_start", async (_event, sessionCtx) => {
		ctx = sessionCtx;
		fs.mkdirSync(inboxOf(ROLE), { recursive: true });

		// Poll rather than fs.watch: watch is unreliable on WSL/9p and network
		// shares, and a 1s poll of a near-empty directory costs nothing.
		timer = setInterval(() => {
			for (const mail of collect(ROLE)) inject(mail);
		}, POLL_MS);

		try {
			pi.setStatus?.(`duet:${ROLE}`);
		} catch {}
		if (sessionCtx.hasUI) {
			sessionCtx.ui.notify(`duet-mail: role "${ROLE}", inbox ${inboxOf(ROLE)}`, "info");
		}
	});

	pi.on("session_shutdown", async () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	});

	// A human prompt means the human is back in the loop, so the runaway-chain
	// counter starts over. Without this, a long session eventually wedges: the
	// hop limit is reached and delegation is refused until restart.
	pi.on("input", async (event) => {
		if (event.source !== "extension" && lastHops !== 0) lastHops = 0;
		return { action: "continue" as const };
	});

	// Tool-level enforcement of the role split. `--tools` is per tool, and bash is
	// one tool, so "commit yes, push no" has to be decided per command.
	pi.on("tool_call", async (event) => {
		if (WRITE_SCOPE !== "any") {
			// write/edit go through Node, not the shell, so an OS sandbox on bash
			// does not cover them. Keep them inside the working tree.
			const target = isToolCallEventType("write", event)
				? event.input.path
				: isToolCallEventType("edit", event)
					? event.input.path
					: undefined;
			if (target && outsideWriteScope(target)) {
				return {
					block: true,
					reason:
						`duet: ${event.toolName} refused - ${target} is outside the working tree ` +
						`(${WRITE_ROOTS.join(", ")}). Work inside the repository; if the task really ` +
						`requires touching something outside it, message the supervisor and explain why.`,
				};
			}
		}

		if (REMOTE_POLICY !== "deny") return;
		if (!isToolCallEventType("bash", event)) return;
		const denied = deniedOperation(event.input.command);
		if (!denied) return;
		return {
			block: true,
			reason:
				`duet: the ${ROLE} may not run ${denied}. Local commits are yours; the remote belongs to ` +
				`the supervisor. If you need something from the remote, use the message tool to ask for it ` +
				`and wait for the reply.`,
		};
	});

	pi.registerTool({
		name: "message",
		label: "Message",
		description:
			"Send a message to another agent working in the same repository, in its own window. " +
			"Use this to delegate a task, report results, or ask a question. The recipient " +
			"receives it as a message and will reply through the same channel.",
		promptSnippet: "Delegate work to, or report back to, the other agent by role name",
		promptGuidelines: [
			"Use message to delegate any work the human asked for; do not do that work yourself.",
			"Use message to report results back to whoever delegated the current task.",
		],
		parameters: Type.Object({
			to: Type.String({ description: 'Recipient role, e.g. "worker" or "supervisor"' }),
			text: Type.String({
				description: "The full message. Be explicit; the recipient cannot see your context.",
			}),
		}),
		async execute(_toolCallId: string, params: { to: string; text: string }) {
			const to = params.to.trim();
			if (to === ROLE) {
				return { content: [{ type: "text" as const, text: `Refused: ${ROLE} cannot message itself.` }] };
			}
			const hops = lastHops + 1;
			if (hops > MAX_HOPS) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Refused: hop limit ${MAX_HOPS} reached. Stop and report to the human instead.`,
						},
					],
				};
			}
			deliver({ from: ROLE, to, text: params.text, hops, sentAt: new Date().toISOString() });
			return {
				content: [{ type: "text" as const, text: `Sent to ${to} (hop ${hops}/${MAX_HOPS}).` }],
				details: { to, hops },
			};
		},
	});

	pi.registerCommand("to", {
		description: "Send a message to another agent window: /to <role> <text>",
		handler: async (args, commandCtx) => {
			const match = args.trim().match(/^(\S+)\s+([\s\S]+)$/);
			if (!match) {
				commandCtx.ui.notify("usage: /to <role> <message>", "warning");
				return;
			}
			// A human-initiated message resets the hop chain.
			lastHops = 0;
			deliver({ from: `${ROLE}:human`, to: match[1], text: match[2], hops: 1, sentAt: new Date().toISOString() });
			commandCtx.ui.notify(`sent to ${match[1]}`, "info");
		},
	});

	pi.registerCommand("hops", {
		description: "Show or reset the agent-to-agent hop counter: /hops [n]",
		handler: async (args, commandCtx) => {
			const argument = args.trim();
			if (argument) {
				const value = Number(argument);
				if (!Number.isFinite(value) || value < 0) {
					commandCtx.ui.notify("usage: /hops [n]   (no argument shows the counter)", "warning");
					return;
				}
				lastHops = value;
			}
			commandCtx.ui.notify(`hop counter: ${lastHops}/${MAX_HOPS}`, "info");
		},
	});

	pi.registerCommand("inbox", {
		description: "Show this window's duet-mail role, inbox path and pending mail",
		handler: async (_args, commandCtx) => {
			let pending = 0;
			try {
				pending = fs.readdirSync(inboxOf(ROLE)).filter((n) => n.endsWith(".json")).length;
			} catch {}
			commandCtx.ui.notify(
				`role ${ROLE} · inbox ${inboxOf(ROLE)} · pending ${pending} · last hop ${lastHops}/${MAX_HOPS}`,
				"info",
			);
		},
	});
}
