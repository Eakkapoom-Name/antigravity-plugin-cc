---
description: Ask Antigravity (agy) a one-shot question with no repository context
argument-hint: "[--model <name>] [--effort <low|medium|high>] <prompt>"
allowed-tools: Bash(node:*)
---

Send a one-shot prompt to agy and return its answer. Use a Bash `timeout` of `200000` ms; the companion caps agy at a 3 minute print timeout.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" whisper "$ARGUMENTS"
```

Present `result.response` as-is. Report `result.conversation_id` on its own line as resumable via `/agy:continue`. If `effortDropped` is true, say in one line that the chosen model rejected `--effort` and the run repeated without it. If `ok` is false, report `error` or `failure` and the last stderr line verbatim, per the `agy-result-handling` skill.

If the text returned by the Bash call is not JSON and contains `denied by the Claude Code auto mode classifier`, agy never ran; follow the `agy-result-handling` skill's host-denial section.
