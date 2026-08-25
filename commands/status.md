---
description: Show active and recent background agy delegations in this session
argument-hint: "[agent-or-task-id]"
allowed-tools: ListAgents, TaskOutput
---

Report the status of background agy work launched from this session. This plugin has no broker or job files by design: background delegations are Claude Code background subagents, so status comes from the session's own task tracking (ListAgents plus the task notifications already received this session).

Argument: `$ARGUMENTS`

If no argument was given:

- List every `agy:agy-rescue` background run from this session, running and finished.
- Render one compact Markdown table: agent name/id, status (running, completed, failed), one-line task summary, `conversation_id` when the result is already known, and the follow-up command (`/agy:result <id>` or `/agy:cancel <id>`).
- No progress blocks, no extra prose outside the table.
- If there are none, say so and point to `/agy:delegate --background <task>`.

If an agent or task id was given:

- Report that run only, in full: status, task text, and the complete stored result if finished (present it per the `agy-result-handling` skill, including `conversation_id`).
- If it is still running, say so; do not poll or wait.

Never invent a status. If a run is unknown to this session, say that plainly; job state does not persist across sessions (resume agy-side work with `/agy:delegate --resume` instead).
