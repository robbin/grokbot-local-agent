# pi-telegram-monitor

One-way, real-time push of Pi Agent sessions to a Telegram private chat, so you
can watch what Pi is doing without opening the Bot's computer. It only sends;
it never reads updates or accepts commands.

## What it watches

Polled every 1.5 s (`PI_HOME` defaults to `~/.pi`):
- `$PI_HOME/agent/sessions/bot/*.jsonl` (pi-run sessions)
- `$PI_HOME/agent/sessions/tasks/*.jsonl` (pi-task sessions)
- `$PI_HOME/tasks/<ID>/events.jsonl` (pi-task events, one message per task)

At startup it records the current size of existing files and does **not** push
history. Later appends to an old file are pushed from that point on.

## What you see

Each session gets one progress message, updated in place with `editMessageText`:

```
[pi-run] my-session — running / replied, waiting / done
tokens≈12345
👤 instruction: … (first 200 chars)
🔧 bash: ls -la /tmp
⚠️ bash error: …
🤖 first 300 chars of the reply…
```

When the assistant finishes a reply (text only, `stopReason=stop`), a separate
**📋 result** message carries the full reply text, split into `(1/N)` parts above
about 3500 characters. Progress messages roll over to a “continued” message past
about 3900 characters or 25 steps.

A session is marked done after 30 s without updates following a final reply, or
stale after 10 minutes without any update. Edits are throttled to at least 2 s
apart; HTTP 429 is retried using `retry_after`, network errors with backoff.

Thinking content and tool output bodies are never sent—only tool names, argument
summaries and error summaries.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy
   its token.
2. Send any message to your new bot, then find your numeric chat ID (for example
   with a chat-ID helper bot, or once via
   `https://api.telegram.org/bot<TOKEN>/getUpdates` in your own browser).
3. Store both as environment variables available to the Bot's shell, using the
   host's secure input facility—not in files or prompts:

| Variable | Required | Meaning |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes | Bot token, read only from the environment |
| `TELEGRAM_CHAT_ID` | yes | Chat to post to; the script exits if missing |
| `PI_HOME` | no | Pi data directory, default `~/.pi` |
| `PI_TG_IDLE_DONE_MS` | no | Idle time after a final reply before “done”, default 30000 |
| `PI_TG_IDLE_STALE_MS` | no | Idle time before “stale”, default 600000 |

4. Start it:

```bash
./start.sh   # setsid nohup in background; log to monitor.log, PID in monitor.pid; no-op if running
./stop.sh
tail -f monitor.log
```

## Keeping it alive

`start.sh` is idempotent, so the simplest keepalive is to call it from an
existing periodic routine or startup check that runs in a shell where the two
variables are present, for example:

```bash
[ -n "$TELEGRAM_BOT_TOKEN" ] && bash ~/tools/pi-telegram-monitor/start.sh
```

If the calling environment does not carry the token, skip rather than writing
the token to a file. Recovery after a crash then waits for the next call.

## Security

- The token comes only from `process.env`; it is never printed, logged or written.
  Logs contain method names, message IDs and error codes only.
- Only `sendMessage` and `editMessageText` are called. No `getUpdates`, no command
  handling.
- Before sending, regexes mask likely secrets: `sk-…`, `ghp_/gho_/github_pat_…`,
  `xox*/AKIA/AIza/re_…`, `Bearer/Basic/token <value>`, `api_key=/password=/secret=`
  assignments, JWTs, `digits:string` Telegram bot tokens, 32+ char hex and 40+
  char alphanumeric base64-like strings. Masking is best-effort: unusual formats
  may slip through and some long hashes or paths may be masked.
- It never reads `~/.pi/agent/auth.json` or other credential files—only session
  and event JSONL.
- Telegram is a third-party service: anything Pi writes in a reply (file contents,
  paths, data) ends up in your chat. Do not enable it for sessions handling
  material you would not put in Telegram.

## Limitations

- Polling, not inotify: up to ~1.5 s delay.
- “Done” is inferred from idle time; a long-running tool may show as waiting.
- A pi-task session file and its events.jsonl are separate messages.
- After a restart, old messages are not edited again; active sessions get a new one.
