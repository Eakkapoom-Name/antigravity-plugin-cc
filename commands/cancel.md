---
description: Cancel a running background agy delegation in this session
argument-hint: "[agent-or-task-id]"
allowed-tools: ListAgents, TaskStop
---

Cancel a running background agy delegation.

Argument: `$ARGUMENTS`

- If an agent or task id was given, stop that run with TaskStop and confirm the outcome to the user.
- If no argument was given and exactly one `agy:agy-rescue` background run is active, stop that one.
- If several are active, list them (name/id plus one-line task summary) and ask which to cancel. If none are active, say so.
- Note in the confirmation: cancelling the Claude-side task does not delete the agy conversation; any `conversation_id` already returned stays resumable via `/agy:rescue --resume`.
- Do not restart, retry, or take over the cancelled task yourself.
