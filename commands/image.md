---
description: Generate an image with Antigravity (agy) and optionally copy it into the project
argument-hint: "[--model <name>] [--effort <low|medium|high>] [--out <path>] <description>"
allowed-tools: Bash(node:*)
---

Generate an image through agy. Use a Bash `timeout` of `320000` ms; the companion caps agy at a 5 minute print timeout.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" image "$ARGUMENTS"
```

On success report `imagePath` (where agy saved the file, under its own artifacts directory) and, when `--out` was given, `outPath` (the copy inside the workspace). Report `result.conversation_id` on its own line. If `effortDropped` is true, say the model rejected `--effort` and the run repeated without it.

If `failure` is `no-image`, agy answered without naming a file it wrote under its artifacts directory; quote `result.response` and stop, do not retry. `--out` follows the same rules as `/agy:research`: inside the workspace, parent must exist, never overwrites. If `outError` is present, say the image was produced but could not be copied into the workspace, and quote `outError`. If the text returned is not JSON and contains `denied by the Claude Code auto mode classifier`, agy never ran; follow the `agy-result-handling` skill.
