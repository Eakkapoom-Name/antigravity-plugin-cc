---
description: Delegate a web-grounded investigation to Antigravity (agy) and get a structured report with sources
argument-hint: "[--allow-secret <regex>]... [--model <name>] [--effort <low|medium|high>] [--out <path>] <topic>"
allowed-tools: Bash(node:*)
---

Run a structured research report through agy. Use a Bash `timeout` of `590000` ms; the companion caps agy at an 8 minute print timeout.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" research "$ARGUMENTS"
```

If the JSON has `failure: "agy-error"`, agy ended on a model or agent error (exit code 3, or an `AGY_ERROR:` line on stderr): report it as a failure and quote `agyError`; if `result.response` has text, present it labelled as a partial answer, never as a finished report.

Present `result.response` as-is; the section order (Summary, Key findings, Disagreements and thin evidence, Caveats, Sources) is the contract, keep it. Report `result.conversation_id` on its own line, and say there is no safe continue path for it: `/agy:continue` resumes through the rescue subagent in `--mode accept-edits` with the repository added, so it would make this conversation, which holds untrusted page content, write-capable in the repository. For a follow-up, tell the user to rerun `/agy:research` with the refined request. If `outPath` is present, say the report was also written there. If `outError` is present, say the report was produced but could not be written to disk, and quote `outError`; if `outError` says the response was empty, say instead that nothing was written because agy returned no report. If `effortDropped` is true, say the model rejected `--effort` and the run repeated without it. `low|medium|high` is the hint, not a promise: not every model accepts every level, and the script reruns once without `--effort` when the model refuses it, unless too little of the run's time budget is left, reported as `effortRetry.skipped` (see the `agy-result-handling` skill).

If the JSON has `failure: "secrets"`, the run did not start and there is no `error` field to report. List each `hits[]` entry as `<line> <kind> (<sample>)`, since the argument is scanned as plain text and a hit has no file. Say nothing left the machine, and give both ways forward: redact the credential from the argument and rerun, or `--allow-secret <regex>` for a known false positive. Do not retry on your own.

`--out <path>` is resolved inside the workspace, its parent must exist, and it never overwrites: if `ok` is false and `error` mentions `--out`, the run did not start; relay the reason. If the text returned is not JSON and contains `denied by the Claude Code auto mode classifier`, agy never ran; follow the `agy-result-handling` skill.
