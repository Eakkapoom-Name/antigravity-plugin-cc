---
description: Delegate a web-grounded investigation to Antigravity (agy) and get a structured report with sources
argument-hint: "[--model <name>] [--effort <low|medium|high>] [--out <path>] <topic>"
allowed-tools: Bash(node:*)
---

Run a structured research report through agy. Use a Bash `timeout` of `590000` ms; the companion caps agy at a 9 minute print timeout.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" research "$ARGUMENTS"
```

Present `result.response` as-is; the section order (Summary, Key findings, Disagreements and thin evidence, Caveats, Sources) is the contract, keep it. Report `result.conversation_id` on its own line as resumable via `/agy:continue`. If `outPath` is present, say the report was also written there. If `outError` is present, say the report was produced but could not be written to disk, and quote `outError`. If `effortDropped` is true, say the model rejected `--effort` and the run repeated without it.

`--out <path>` is resolved inside the workspace, its parent must exist, and it never overwrites: if `ok` is false and `error` mentions `--out`, the run did not start; relay the reason. If the text returned is not JSON and contains `denied by the Claude Code auto mode classifier`, agy never ran; follow the `agy-result-handling` skill.
