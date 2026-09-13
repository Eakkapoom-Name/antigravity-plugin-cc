---
description: Show active and recent background agy delegations in this session
argument-hint: "[agent-or-task-id]"
allowed-tools: ListAgents, TaskOutput
---

Report the status of background agy work launched from this session. This plugin has no broker or job files by design, so status comes from the session's own task tracking.

Two kinds of background work exist and both belong in the report:

- **Subagent delegations**: `/agy:rescue --background` and `/agy:continue --background` run the `agy:agy-rescue` subagent. Find these with `ListAgents`.
- **Companion runs**: `/agy:adversarial-review --background` runs the companion script as a background Bash task, not a subagent. `ListAgents` will not list it. Use the background task output already available in this session.

Reporting only the first kind means a backgrounded review looks like it never started.

Argument: `$ARGUMENTS`

If no argument was given:

- List every background agy run from this session, running and finished: both `agy:agy-rescue` subagents and backgrounded companion reviews.
- Render one compact Markdown table: name or id, kind (subagent or companion run), status (running, completed, failed), one-line task summary, `conversation_id` when the result is already known, and the follow-up command (`/agy:result <id>` or `/agy:cancel <id>`).
- No progress blocks, no extra prose outside the table.
- If there are none, say so and point to `/agy:rescue --background <task>`.

If an agent or task id was given:

- Report that run only, in full: status, task text, and the complete stored result if finished (present it per the `agy-result-handling` skill, including `conversation_id`).
- If it is still running, say so; do not poll or wait.

Never invent a status. If a run is unknown to this session, say that plainly; job state does not persist across sessions (resume agy-side work with `/agy:rescue --resume` instead).
