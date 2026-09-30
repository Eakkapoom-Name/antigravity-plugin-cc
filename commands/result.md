---
description: Show the stored final output of a finished background agy delegation
argument-hint: "[agent-or-task-id]"
allowed-tools: ListAgents, TaskOutput, Read, Grep
---

Show the final output of a finished background agy delegation from this session.

Argument: `$ARGUMENTS`

Target selection:

- If an agent or task id was given, use that run.
- If no argument was given, use the most recently finished background agy run in this session. That may be an `agy:agy-rescue` subagent or a backgrounded companion review from `/agy:adversarial-review --background`; both count.
- A companion run returns the script's JSON, so read `result` out of it and present that. A subagent run returns an `AGY_RESCUE_SUMMARY` line whose `result_file` names the file holding agy's JSON; check and read that file per the `agy-result-handling` skill (its `response_file`, in pages, when the response is large) and present its contents. Older subagent runs returned agy's JSON directly.
- If the target is still running, say so and point to `/agy:status`; do not wait or poll.
- If no finished run exists, say so.

Presentation:

- Retrieve the stored result (TaskOutput, or the task notification already received this session).
- Present it per the `agy-result-handling` skill: the full agy `response` verbatim, no summarizing or condensing, file paths and line numbers exactly as reported, and the `conversation_id` on its own line at the end. Label it as resumable via `/agy:rescue --resume` only for a subagent run (`/agy:rescue` or `/agy:continue`). For a companion review say there is no safe continue path for it: `--resume` and `/agy:continue` would reopen that read-only, isolated conversation write-capable in the repository, so the follow-up is to rerun the review.
- If the run failed, report the failure verbatim with the most actionable error line and stop. Do not turn a failed agy run into a Claude-side implementation attempt.
