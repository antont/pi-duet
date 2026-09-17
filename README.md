# pi-duet

Two ways to run a supervisor/worker pair of pi agents on one repo:

- **mail mode** (`mail/`) — two real pi TUI windows that message each other.
  Native pi rendering, both agents interactive. Start here.
- **duet mode** (`duet.mjs`) — one terminal, orchestrated ping-pong, no TUI.
  Better when you want a forced protocol, a round limit and one merged log.

---

# mail mode

Each window is an ordinary `pi` with the `duet-mail` extension loaded. The
extension gives it a role, a mailbox directory, a `message` tool for the model
and a `/to` command for you. Incoming mail is injected with `triggerTurn`, so an
idle window wakes up and answers.

```bash
# window 1 — supervisor (no edit/write tools: delegation is the only way to change code)
cd ~/nestos.tests
~/pi-duet/bin/duet-sup

# window 2 — worker
cd ~/nestos.tests
~/pi-duet/bin/duet-wrk
```

On Windows use the PowerShell launchers — `bash ./bin/duet-sup` from PowerShell
resolves to **WSL's** bash, which then cannot find node:

```powershell
cd C:\Users\tonia\src\pi-duet
.\bin\duet-sup.ps1      # window 1
.\bin\duet-wrk.ps1      # window 2
```

Models are overridable per launch on either platform:
`DUET_WORKER_MODEL=github-copilot/claude-sonnet-5 ./bin/duet-wrk`, or
`$env:DUET_WORKER_MODEL="github-copilot/claude-sonnet-5"` before the `.ps1`.

The long form, if you would rather not use a launcher:

```bash
# window 1 — supervisor (no edit/write tools: delegation is the only way to change code)
cd ~/nestos.tests
DUET_ROLE=supervisor pi -e ~/pi-duet/mail/index.ts \
  --exclude-tools edit,write \
  --model github-copilot/gpt-5.6-sol --thinking high \
  --append-system-prompt ~/pi-duet/roles/supervisor-mail.md

# window 2 — worker
cd ~/nestos.tests
DUET_ROLE=worker pi -e ~/pi-duet/mail/index.ts \
  --model github-copilot/claude-opus-5 \
  --append-system-prompt ~/pi-duet/roles/worker-mail.md
```

Then type your goal into the supervisor window. It messages the worker, the
worker window wakes, implements, and messages back.

| | |
|---|---|
| `/to worker <text>` | send mail yourself, from either window |
| `/inbox` | role, inbox path, pending mail, hop count |
| `message` tool | how the models reach each other |

| var | default | purpose |
|---|---|---|
| `DUET_ROLE` | `agent` | this window's mailbox name |
| `DUET_MAIL_DIR` | `~/.duet-mail` | where mailboxes live |
| `DUET_MAX_HOPS` | `24` | runaway ping-pong guard; a human `/to` resets the chain |

Notes:

- Mail is delivered as `followUp`, so it never cuts into a turn mid-flight.
- Delivery is a 1s directory poll, not `fs.watch` — watch is unreliable on WSL.
- Writes are atomic (tmp + rename), so a reader never sees half a message.
- Both windows share one working tree. The supervisor has no `edit`/`write`
  tools, so the worker is the only writer — but `bash` can still modify files,
  so the role prompt forbids `sed -i`/heredoc writes too.

---

# duet mode

Two long-lived `pi` agents — a **supervisor** (plans + reviews) and a **worker**
(implements) — driven from a single terminal. No tmux, no panes: one plain
stdout stream with native scrollback and copy-paste.

Both agents are persistent `pi --mode rpc` processes sharing one working tree.
Each keeps its own session file, so context survives across rounds *and* across
duet restarts (`--fresh` starts new sessions instead).

## Run

```bash
node C:/Users/tonia/src/pi-duet/duet.mjs --cwd C:/Users/tonia/src/nestos.tests
```

Defaults: supervisor `github-copilot/gpt-5.6-sol` (thinking high), worker
`github-copilot/claude-opus-5` (thinking medium).

```
--cwd DIR                 working tree both agents operate on (default: cwd)
--fresh                   ignore saved sessions, start both agents clean
--rounds N                max worker rounds per cycle (default 3)
--only S|W                keep only that agent in THIS window (both still stream to files)
--supervisor-model P/M    e.g. github-copilot/gpt-5.6-sol
--worker-model P/M        e.g. github-copilot/claude-opus-5
--supervisor-thinking L   off|minimal|low|medium|high|xhigh|max
--worker-thinking L
--supervisor-prompt FILE  role prompt (default roles/supervisor.md)
--worker-prompt FILE      role prompt (default roles/worker.md)
```

## Interaction

| input | effect |
|---|---|
| `<text>` | start a supervised cycle: supervisor plans → worker implements → supervisor reviews → repeat until a verdict or the round limit |
| `/s <text>` | talk to the supervisor only (planning, questions, review of something you did) |
| `/w <text>` | talk to the worker only (no review round) |
| `/rounds N` | change the per-cycle round limit |
| `/abort` | abort whichever agent is running (also Ctrl+C) |
| `/state` | models, session files, transcript path |
| `/quit` | stop both agents |

**While a round is running**, anything you type is delivered to the active agent
as a *steering* message at its next turn boundary — `/s …` / `/w …` steer a
specific agent instead. That is the human-in-the-loop path: you can correct a
worker mid-implementation without killing the round.

## The protocol

The supervisor must end every message with either a task block:

```
<<<TASK
what to do, which files, what "done" means, what not to touch
TASK>>>
```

or a terminal verdict: `VERDICT: APPROVED` / `BLOCKED` / `HUMAN`. duet extracts
the task, hands it to the worker, then feeds the worker's report plus
`git status --short` and `git diff --stat HEAD` back to the supervisor. A cycle
never ends on an unreviewed worker round — hitting the round limit forces one
last verdict-only review.

Role prompts are plain markdown in `roles/`; edit them to taste. The reviewer
lens in `roles/supervisor.md` is tuned to catch dead scaffolding, tests that
assert their own mocks, unverifiable "matches X" claims, and scope creep.

## Watching one agent separately

Every agent is streamed to its own file as well as to the merged view, so a
second terminal can follow just one of them:

```bash
tail -f ~/pi-duet/runs/latest-W.log     # worker only
tail -f ~/pi-duet/runs/latest-S.log     # supervisor only
```

`latest-*.log` is a symlink to the current run (on Windows without developer
mode, `latest-*.path` holds the filename instead). Add `--only S` to keep the
other agent out of the main window, so the two views don't duplicate.

After duet exits you can also take either agent's context into a normal pi TUI,
since they are ordinary pi sessions:

```bash
pi --session <path from /state>    # or: pi -r  and pick it from the list
```

Don't do that *while* duet is running — two processes writing one session file
will corrupt it.

## Files

```
duet.mjs            the orchestrator
roles/*.md          appended to each agent's system prompt
state/<repo>.json   session files to resume per working tree
runs/*.md           full plain-text transcript of every run
runs/*-S.log        supervisor-only stream (latest-S.log points at the current run)
runs/*-W.log        worker-only stream
```

Set `PI_DUET_CLI` if the pi bundle can't be auto-located.
