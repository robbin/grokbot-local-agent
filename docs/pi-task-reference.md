# pi-task reference

pi-task wraps the `pi --mode rpc` calls used by bin/pi-call.mjs in tracked,
resumable, cancellable tasks. Each task gets a directory containing status,
events, prompts and the final reply. The process stays in the foreground until
finished; the Bot launches it using its Shell tool's background mode.

- Node 22+, no third-party dependencies.
- Default: deepseek/deepseek-flash, thinking high, read/write/exec and web tools.
- IDs: `<session>-<YYYYMMDD-HHMMSS>`; the session name is also the Pi session ID.
- Owner identifies the dispatching Bot; pending/list/ack support owner filters.
- The wrapper does not read authentication files; Pi handles model authentication.

## Usage

Commands below assume pi-task is installed on PATH; otherwise use
`~/tools/pi-call/pi-task`. Angle-bracket arguments are placeholders to replace.

```text
pi-task run <cwd> "<prompt>" --session <name> --owner <agent-id> [--timeout sec]
            [--model provider/model] [--thinking off|low|medium|high] [--no-write] [--no-web]
pi-task reply <ID> "<prompt>" [--timeout sec]
pi-task status <ID>
pi-task list [--all] [--owner <id>|none]
pi-task log <ID> [-n 30]
pi-task cancel <ID>
pi-task pending [--owner <id>|none]
pi-task ack <ID> [<ID>...] [--owner <id>|none]
```

Timeout defaults to 300 seconds; 0 disables it. Session-name whitespace and path
separators are normalized to hyphens. Reply reuses the original session, working
directory, owner and options; it does not accept --owner.

If failure/cancellation happens before any assistant text, result.md is absent.

```bash
PI_TASK_DIR=/tmp/tasks ~/tools/pi-call/pi-task run ~/repo \
  "Fix typos in README" --session docs --owner YOUR_AGENT_ID
# TASK docs-20261018-151601
# STATE done
# RESULT /tmp/tasks/docs-20261018-151601/result.md

PI_TASK_DIR=/tmp/tasks ~/tools/pi-call/pi-task reply docs-20261018-151601 \
  "Also add a usage example"
```

For long jobs, launch run in the host's background mode, retain TASK ID, and later:

```bash
~/tools/pi-call/pi-task pending --owner YOUR_AGENT_ID
~/tools/pi-call/pi-task status TASK_ID
# Read result.md and verify artifacts/diff/tests; report to the user first.
~/tools/pi-call/pi-task ack TASK_ID --owner YOUR_AGENT_ID
```

## Ownership

Owner is the dispatching Bot's agent ID, obtainable from its profile location,
for example `/home/box/agent-data/agents/YOUR_AGENT_ID/profile.json`.

- run --owner records a string in status.json.
- Without the flag, run reads PI_TASK_OWNER. Without either, owner is null and
  stderr warns: `pi-task: warning: --owner was not specified; completion cannot be routed to the dispatching Bot`.
- Invalid/empty owner arguments are rejected; run rejects whitespace in an owner.
- reply cannot change owner.
- For filtering, `--owner none` selects null/missing owners. Do not use the literal
  string none as a Bot ID.

| Command | No owner filter | --owner ID | --owner none |
| --- | --- | --- | --- |
| pending | All terminal, unreported tasks | Matching owner only | Unowned tasks only |
| list | All running/recent tasks | Matching owner only | Unowned tasks only |
| ack | Acknowledges all supplied IDs without an ownership check | Refuses mismatched owners | Refuses non-null owners |

Old records lacking owner are treated as unowned. For a multi-ID ack, matched
records are still acknowledged even if others are refused; any refusal yields
exit code 1. Always use your owner filter when acting as a Bot. Ownership is
routing discipline, not an operating-system security boundary.

List/pending output includes `owner=<id|->`; a hyphen means unowned:

```text
news-i18n-20261018-152233  owner=YOUR_AGENT_ID  done  runs=1  created=21m ago
```

When notification variables are configured, the completion payload is:

```json
{"source":"pi-task","id":"docs-20261018-151601","owner":"YOUR_AGENT_ID","state":"done","exit_code":0}
```

It contains neither prompt nor result. The receiver verifies/reports/acks only
its own tasks, forwarding other tasks to their owner according to the routine.

## Storage

Root: `$PI_TASK_DIR`, default `~/.pi/tasks`. Each task has its own `<ID>/` directory.

| File | Contents |
| --- | --- |
| status.json | State, written atomically using a temporary file and rename |
| events.jsonl | Events with ts/type/tool/text; text is normalized to one line and truncated to 500 characters |
| result.md | Last assistant text, absent if no text was produced |
| prompt-N.txt | Prompt for turn N |

Example status:

```json
{
  "id": "docs-20261018-151601",
  "session": "docs",
  "owner": "YOUR_AGENT_ID",
  "cwd": "/home/me/repo",
  "model": "deepseek/deepseek-flash",
  "state": "done",
  "pid": null,
  "created_at": "2026-10-18T07:16:01.650Z",
  "started_at": "2026-10-18T07:16:01.652Z",
  "ended_at": "2026-10-18T07:16:03.541Z",
  "exit_code": 0,
  "error": null,
  "reported": false,
  "runs": [
    {"n": 1, "prompt": "Fix typos in README",
     "started_at": "...", "ended_at": "...", "exit_code": 0}
  ],
  "options": {"thinking": "high", "write": true, "web": true}
}
```

Reply reuses options from the first run. Storage timestamps are ISO UTC; displayed
timestamps and ID generation use the host process's local timezone, not a fixed
language-dependent timezone. status prints a human-readable summary, not every
JSON field; inspect status.json to see exit_code directly.

## States and exit codes

States: queued, running, done, failed, cancelled, interrupted.

| Exit code | Meaning |
| --- | --- |
| 0 | done |
| 1 | failed, refusal, or command error; task failures record error |
| 2 | Usage error, such as missing arguments or invalid timeout |
| 124 | Timeout: failed with error="timeout" |
| 130 | cancelled |

On timeout or SIGTERM/SIGINT, the runner sends abort to Pi, allows up to five
seconds, then records the outcome and exits. A second signal ends immediately.

Operational subcommands perform an orphan check: a task recorded as running
whose PID no longer exists is marked interrupted, with an orphan_detected event.
This handles, for example, a runner killed with SIGKILL or lost during restart.

Cancel signals status.pid (the pi-task runner, not the Pi child). If it has not
finished after 12 seconds, cancel sends SIGKILL and records forced cancellation.

Only one running task is allowed per session. Run with an occupied session and
reply to a running task are refused with exit code 1.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| PI_TASK_DIR | ~/.pi/tasks | Task store |
| PI_TASK_SESSION_DIR | ~/.pi/agent/sessions/tasks | Pi session storage; changing it prevents finding old sessions |
| PI_TASK_OWNER | Empty | Default owner for run |
| PI_NOTIFY_URL | Empty | Completion webhook endpoint |
| PI_NOTIFY_SECRET | Empty | Raw notification Bearer token, supplied through environment |
| PI_NOTIFY_OFF | Empty | Set to 1 to disable notifications temporarily |
| PI_BIN | pi | Pi executable |

Both notification variables must be present to send. Use secure input, not files
or command-line arguments, for credentials. Notification credentials are removed
from the delegated Pi child's environment; the separate notifier receives them.

## Compared with pi-call

- pi-call.mjs prints the last reply from a one-shot call. pi-task adds persistent
  records, follow-up, cancellation and report acknowledgment.
- pi-task defaults to ~/.pi/agent/sessions/tasks. pi-run uses a separate session
  location; do not assume their sessions can be resumed interchangeably.
- RPC uses --mode rpc, --session-dir, --session-id, --name, --provider, --model,
  --thinking and --tools. Events are split only on LF; extension UI requests are
  automatically cancelled because these clients are noninteractive.
- pi-task and pi-run enable write/exec tools by default. pi-call requires
  --allow-write for that tool set. Tool selection is not a filesystem sandbox.

For setup and notification checks, see [the setup guide](setup-guide.md).
