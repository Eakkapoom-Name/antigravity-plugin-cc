---
description: Show the stored final output of a finished background agy delegation
argument-hint: "[agent-or-task-id]"
allowed-tools: ListAgents, TaskOutput
---

Show the final output of a finished background agy delegation from this session.

Argument: `$ARGUMENTS`

Target selection:

- If an agent or task id was given, use that run.
- If no argument was given, use the most recently finished `agy:agy-rescue` background run in this session.
- If the target is still running, say so and point to `/agy:status`; do not wait or poll.
- If no finished run exists, say so.

Presentation:

- Retrieve the stored result (TaskOutput, or the task notification already received this session).
- Present it per the `agy-result-handling` skill: the full agy `response` verbatim, no summarizing or condensing, file paths and line numbers exactly as reported, and the `conversation_id` on its own line at the end, labeled as resumable via `/agy:rescue --resume`.
- If the run failed, report the failure verbatim with the most actionable error line and stop. Do not turn a failed agy run into a Claude-side implementation attempt.
