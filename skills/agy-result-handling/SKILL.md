---
name: agy-result-handling
description: Internal guidance for presenting Antigravity (agy) output back to the user
user-invocable: false
---

# Antigravity Result Handling

When an `/agy:*` command or the `agy:agy-rescue` subagent returns agy JSON output:

- Parse the JSON and present the `response` field as the primary content. Preserve its structure: verdicts, findings, file paths, line numbers, and section ordering stay as agy wrote them.
- Always report the `conversation_id` on its own line at the end, labeled as resumable via `/agy:delegate --resume`.
- If `status` is not `SUCCESS`, report the failure verbatim with the most actionable error line, and stop. Do not turn a failed agy run into a Claude-side implementation attempt.
- If agy was never successfully invoked, do not generate a substitute answer.
- If agy made edits, say so explicitly and list touched files when the response names them.
- Preserve evidence boundaries: keep agy's inferences, uncertainties, and open questions marked as such.
- For review output: findings first, ordered by severity. If there are none, say so explicitly.
- CRITICAL for reviews: after presenting findings, STOP. Ask the user which findings to fix before changing any file.
- If the failure is missing binary or authentication, direct the user to `/agy:setup`. Do not improvise alternate auth flows.
