---
description: Generate an image with Antigravity (agy) and optionally copy it into the project
argument-hint: "[--allow-secret <regex>]... [--model <name>] [--effort <low|medium|high>] [--out <path>] <description>"
allowed-tools: Bash(node:*)
---

Generate an image through agy. Use a Bash `timeout` of `420000` ms; the companion caps agy at a 5 minute print timeout and gives the call a 6 minute spawn timeout, leaving margin under this Bash timeout.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" image "$ARGUMENTS"
```

On success report `imagePath` (where agy saved the file, under its own artifacts directory) and, when `--out` was given, `outPath` (the copy inside the workspace). If `warning` is present, say so: the copied file's bytes did not match the extension `--out` named, or `--out` named an extension that is no image format (png, jpg, jpeg or webp), but the copy was made anyway under the name given. Report `result.conversation_id` on its own line. If `effortDropped` is true, say the model rejected `--effort` and the run repeated without it. `low|medium|high` is the hint, not a promise: not every model accepts every level, and the script reruns once without `--effort` when the model refuses it, unless too little of the run's time budget is left, reported as `effortRetry.skipped` (see the `agy-result-handling` skill).

If the JSON has `failure: "secrets"`, the run did not start and there is no `error` field to report. List each `hits[]` entry as `<line> <kind> (<sample>)`, since the argument is scanned as plain text and a hit has no file. Say nothing left the machine, and give both ways forward: redact the credential from the argument and rerun, or `--allow-secret <regex>` for a known false positive. Do not retry on your own.

If `failure` is `no-image`, agy answered without naming a file it wrote under its artifacts directory; quote `result.response` and stop, do not retry. `--out` follows the same rules as `/agy:research`: inside the workspace, parent must exist, never overwrites. If `outError` is present, say the image was produced but could not be copied into the workspace, and quote `outError`. If the text returned is not JSON and contains `denied by the Claude Code auto mode classifier`, agy never ran; follow the `agy-result-handling` skill.
