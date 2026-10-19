---
name: pi-agent
description: >-
  Use when the user asks Pi to do, review or inspect work, requests another model's
  second opinion, or needs batch file processing, coding, long research, web search
  or a substantial draft. Delegate these heavier tasks to Pi on the Bot's own
  computer using RPC and named sessions, then verify and report the results.
---
# Delegate to Pi on the Bot's computer

Pi is a CLI coding agent on the same machine as the Bot, not the user's laptop.
The defaults are deepseek/deepseek-flash and high thinking. Scripts live at
~/tools/pi-call/ (the source repository's bin/ directory). For installation,
read docs/setup-guide.md in the source checkout.

Use the user's preferred language for conversation and task outputs unless they
request another language. English skill instructions do not impose English replies.

## Division of work

Pi uses the user's separate model account; delegate heavier work to it while the
Bot orchestrates and checks the result.

Delegate:
- Batch edits, data cleanup and format conversion.
- Small programs, scripts, tests and debugging.
- Long research, web search and initial document/report/article drafts.
- Explicit requests for Pi or a second model's opinion.

Keep with the Bot:
- Short questions and lightweight conversation.
- Connector actions such as Gmail, X and GitHub; Pi does not inherit those connections.
- Approval before sending, publishing, pushing or deploying, plus user reporting.

Keep prompts short but self-contained: goal, constraints, input paths, output
paths and acceptance criteria. Give long source material as file paths.
Have Pi write the deliverable directly; verify it instead of rewriting it yourself.
Record important conclusions in appropriate documents or memory only within
the host's applicable storage and permission rules.

## Workflow

1. Choose the narrow working directory needed for the task: a repository or
   /tmp/task-name, not / or the entire home directory. A cwd is not a sandbox.
2. Choose a short English kebab-case session name. Reuse it for follow-up work;
   choose another name for a fresh session.
3. Choose output paths. Use /tmp/pi-out/SESSION/ when no better location exists;
   durable outputs should go to the appropriate authorized project/document location.
4. Write a prompt with necessary background: Pi does not see the Bot's conversation.
   Ask for the files changed and a short conclusion.
5. Use tracked tasks for work that may take more than a minute or two:

   ```text
   ~/tools/pi-call/pi-task run <cwd> "<prompt>" --session <name> --owner YOUR_AGENT_ID [--timeout sec] [--no-write] [--no-web]
   ```

   Always identify the dispatching owner. Its ID appears in its profile location,
   for example /home/box/agent-data/agents/YOUR_AGENT_ID/profile.json.
   PI_TASK_OWNER can supply a fallback, but an explicit flag is safer.
   Without either, the task runs with owner=null and a warning; automatic routing
   cannot identify the dispatching Bot.

   Use the Shell tool's native background mode, not nohup, & or setsid.
   Retain the first stdout line, TASK ID. Completion prints STATE and RESULT.
   Exit codes: 0 done, 1 failed/refused, 2 usage error, 124 timeout, 130 cancelled.

   Commands:
   - status ID: state, owner, timing and recent events. Read status.json for exit_code.
   - log ID [-n 30], list [--all] [--owner ID|none], cancel ID.
   - pending [--owner ID|none]: terminal tasks not yet reported.
   - ack ID [--owner ID|none]: mark reported; a filter refuses mismatched owners.

   Records live under ~/.pi/tasks/ID/: status.json, events.jsonl, result.md and
   prompt-N.txt. Operational commands mark a running task interrupted if its
   recorded process no longer exists, including after restarts. Ask before rerunning.

   With PI_NOTIFY_URL and PI_NOTIFY_SECRET supplied securely through the environment,
   completed tasks send {source,id,owner,state,exit_code}, not task content.
   The routine verifies, reports and acknowledges its own tasks. Other tasks are
   routed through SendToAgent (priority=true); if routine messaging is unavailable,
   return routing details to the main Bot. Unowned tasks are flagged, not acked.
   Missing configuration skips notification; PI_NOTIFY_OFF=1 disables it.
   Delivery outcomes appear as notify events.

   Fallback on every wakeup when you have delegated work:
   run pending --owner YOUR_AGENT_ID, verify and report completed tasks, then
   ack ID --owner YOUR_AGENT_ID. Never bypass a mismatch by removing the filter.

   For short synchronous work:

   ```text
   ~/tools/pi-call/pi-run <cwd> "<prompt>" --session <name> [--timeout sec]
   ```

   For a model override or read-only tool set:

   ```text
   ~/tools/pi-call/pi-call.mjs <cwd> deepseek/deepseek-flash "<prompt>" --thinking high [--allow-write] [--no-web] [--session <name>] [--timeout sec]
   ```

   pi-run/pi-call print only the final assistant reply to stdout. Default timeout
   is 300 seconds; exit codes are 0 success, 1 error, 124 timeout, 127 Pi not found.
   pi-run and pi-task enable read/write/exec tools by default. pi-call without
   --allow-write selects read-only tools. These are tool settings, not hard isolation.
6. Verify: an assistant reply is a claim, not evidence. Inspect diff, tests or
   artifacts before presenting findings as facts.
7. Follow up with pi-task reply ID "<changes>". It retains session, directory,
   owner and original options; a running task rejects reply. For pi-run, reuse
   --session. Their default session stores are separate; do not mix continuation.

## Boundaries

- Use model/search quotas purposefully; avoid empty or repetitive calls.
- Do not delegate pushes, deployment, DNS/production changes, external messages
  or email, or deletion of important files. The Bot handles those only after
  the user's approval.
- Do not let the agent inspect or disclose ~/.pi/agent/auth.json, secret files or
  keys in environment variables. Runtime authentication is handled internally.
- Never acknowledge another Bot's task. Ownership filters are required in Bot use.
- Tell the user what Pi did and what you independently verified.

## Troubleshooting

- Pi not found: check PATH, for example
  export PATH=$HOME/.local/bin:$HOME/.node22/bin:$PATH.
- Model unavailable/authentication failure: the user must select an available
  model or use Pi's interactive /login flow; the Bot must not log in for them.
- Timeout: split work or increase --timeout.
- Error or wrong result: inspect exit code and task logs (or pi-call --verbose).
  For a correction, continue the same session with explicit feedback, subject to
  the user's retry approval. Limit retries to one or two; otherwise take over and
  explain the limitation rather than looping.
