# Webhook routine: Pi task completion

This Grok Bot routine handles completion notifications containing only
`{source, id, owner, state, exit_code}`. Read disk state to determine what happened:
verify/report/ack your own tasks, route other Bots' tasks to them, and flag
unowned tasks without acknowledging them.

## Setup

1. Create a webhook-triggered routine in the Bot's routine interface.
2. Give it a name such as “Pi task completion”.
3. Paste the template below, replacing YOUR_AGENT_ID with the receiving Bot's ID.
4. Supply the webhook URL and raw Bearer token through secure input as
   PI_NOTIFY_URL and PI_NOTIFY_SECRET. Never put them in files, prompts or a repo.
5. Enable the routine. Both environment variables are required; PI_NOTIFY_OFF=1
   temporarily suppresses notifications.
6. Run an authorized small task and check its notify event and the verified
   report. See [end-to-end setup](../docs/setup-guide.md#5-end-to-end-check).

## Routine instructions

```text
You handle Pi completion notifications. Communicate with the user in their
preferred language, regardless of the language of these instructions.

1. Run ~/tools/pi-call/pi-task pending to list all completed but unreported
   tasks. Each line includes owner=<id|->. If empty, finish with no user-facing
   notification; use "No pending reports" only if an internal reply is required.
2. Handle ownership without overstepping:
   a. Your owner ID is YOUR_AGENT_ID. For your tasks, run status ID, read
      ~/.pi/tasks/ID/result.md when present, and inspect events/logs as needed.
      Read status.json for exit_code if needed; do not edit it.
      Independently verify claimed changes using git diff, tests or artifact reads.
   b. For another Bot's task, do not inspect its result, ack it or report it to
      the user. Use SendToAgent with priority=true to forward ID, owner and state
      to the owner and ask it to verify, report and ack. If the routine cannot
      send messages, return the routing details to the main Bot for forwarding
      from a normal conversation; do not bypass that restriction.
   c. If owner is "-" (unassigned), tell the user the task lacks an owner.
      Do not verify or ack it.
3. Report and ack only your own tasks. Include ID, state
   (done/failed/cancelled/interrupted), a short conclusion, verification evidence
   and artifact paths. For failure or timeout, explain the cause and ask whether
   to retry; never automatically rerun. After reporting:
   ~/tools/pi-call/pi-task ack ID --owner YOUR_AGENT_ID
   If verification fails, leave the task pending and explain the blocker.
   Owner mismatch refusal (exit 1) is expected; do not bypass it.
4. Do not manually modify task-store files; use pi-task ack for acknowledgment.
   Do not read secrets or auth.json. Do not push, deploy or send external messages
   on the user's behalf as part of completion handling.
```

The Bot ID is available from its profile path, for example
/home/box/agent-data/agents/YOUR_AGENT_ID/profile.json.

## Recovery notes

- Delivery failures, restarts and routine scheduling can delay or lose wakeups.
  When the Bot next wakes and has dispatched work, check pending again.
- Always acknowledge with your own owner filter. An unfiltered ack does not
  enforce ownership. Forwarded tasks remain the dispatching Bot's responsibility.
- A notify event records the delivery outcome, such as http 200 or error.
  Notification failure does not invalidate disk results.
- Do not rerun a task simply because no notification arrived.
