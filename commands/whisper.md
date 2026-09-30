---
description: Ask Antigravity (agy) a one-shot question with no repository context
argument-hint: "[--allow-secret <regex>]... [--model <name>] [--effort <low|medium|high>] <prompt>"
allowed-tools: Bash(node:*)
---

Send a one-shot prompt to agy and return its answer. Use a Bash `timeout` of `300000` ms; the companion caps agy at a 3 minute print timeout and gives the call a 4 minute spawn timeout, leaving margin under this Bash timeout.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" whisper "$ARGUMENTS"
```

Present `result.response` as-is. Report `result.conversation_id` on its own line as resumable via `/agy:continue`. If `effortDropped` is true, say in one line that the chosen model rejected `--effort` and the run repeated without it. `low|medium|high` is the hint, not a promise: not every model accepts every level, and the script reruns once without `--effort` when the model refuses it. If `ok` is false, report `error` or `failure` and the last stderr line verbatim, per the `agy-result-handling` skill.

If the JSON has `failure: "secrets"`, the run did not start and there is no `error` field to report. List each `hits[]` entry as `<line> <kind> (<sample>)`, since the argument is scanned as plain text and a hit has no file. Say nothing left the machine, and give both ways forward: redact the credential from the argument and rerun, or `--allow-secret <regex>` for a known false positive. Do not retry on your own.

If the text returned by the Bash call is not JSON and contains `denied by the Claude Code auto mode classifier`, agy never ran; follow the `agy-result-handling` skill's host-denial section.
