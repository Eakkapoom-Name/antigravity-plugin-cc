---
description: Run an agy review that challenges the implementation approach and design choices
argument-hint: "[--wait|--background] [staged|branch|<base-ref>] [focus ...]"
allowed-tools: Read, Bash(agy:*), Bash(git:*), AskUserQuestion, Agent
---

Run an adversarial agy review of the current git changes. Position it as a challenge review: does the chosen approach hold up, what assumptions does it depend on, where do the design and tradeoffs fail under real-world conditions. It is not just a stricter pass over implementation defects.

Raw arguments: `$ARGUMENTS`

Core constraint:

- This command is review-only. Do not fix issues, apply patches, or suggest you are about to make changes.
- Your only job is to run the review and present agy's output.
- After presenting findings, STOP. Ask the user which findings, if any, they want fixed before touching a single file.

Scope selection from the arguments (same as `/agy:review`):

- `staged`: review `git diff --cached`.
- `branch` or a base ref like `main`: review `git diff <base>...HEAD` (default base: the repository default branch).
- No scope argument: review `git diff HEAD` (unstaged plus staged working tree changes).
- Remaining argument text after flags and scope is extra reviewer focus.

Execution mode:

- `--wait`: run in the foreground. `--background`: run as a Claude background task. Do not forward either flag to agy as task text.
- If neither flag is present, estimate the review size first (`git diff --shortstat` for the chosen scope; treat untracked files as reviewable work even when the diff stat is empty). Then ask once with AskUserQuestion, two options, recommended first with the `(Recommended)` suffix: `Wait for results` and `Run in background`. Recommend waiting only for a clearly tiny scope, roughly 1 or 2 files; otherwise recommend background.
- Only conclude there is nothing to review when the chosen scope is actually empty. When in doubt, run the review.

Building the review prompt:

1. Collect the diff with the appropriate `git diff` command. If the scope is empty, say so and stop.
2. Write the diff to a temp file under the session scratchpad directory.
3. Construct this task text (fill in focus, or `none`):

> You are an adversarial code reviewer. This is a read-only review; make no edits. Challenge the implementation approach in the following unified diff: question the chosen design, its tradeoffs, and the assumptions it depends on, and identify where it fails under real-world conditions. Do not limit yourself to surface defects. Respond with a single JSON object and nothing else, shaped as: {"verdict": "approve" | "needs-attention", "summary": "...", "findings": [{"severity": "critical" | "high" | "medium" | "low", "title": "...", "body": "...", "file": "...", "line_start": N, "line_end": N, "confidence": 0.0-1.0, "recommendation": "..."}], "next_steps": ["..."]}. An empty findings array with verdict "approve" is a valid answer. Extra focus: `<focus>`. Diff follows:

followed by the diff contents (the canonical schema for that object lives at `schemas/review-output.schema.json` in this plugin).

Foreground flow:

- Run exactly one read-only agy call (no `--mode` flag) per the `agy-cli-runtime` skill:

```bash
agy -p "<task text with diff>" --output-format json --print-timeout 9m
```

Background flow:

- Forward the exact same task text to the `agy:agy-rescue` subagent via the `Agent` tool, run in the background. State in the forwarded text that this is a read-only review so the subagent omits `--mode accept-edits`.
- After launching, tell the user: "agy adversarial review started in the background. Check `/agy:status` for progress, `/agy:result` for the output." Do not wait or poll in this turn.

Presenting the result (per the `agy-result-handling` skill):

- Parse the review JSON out of agy's `response`. Render: verdict line, summary, then findings ordered by severity, each as `file:line_start-line_end severity (confidence): title. body. recommendation.`, then next steps. Keep agy's wording; do not soften or editorialize.
- If the response is not valid JSON, present it verbatim and say the structured format was not followed.
- Report the `conversation_id` on its own line at the end, resumable via `/agy:delegate --resume`.
- Delete the temp diff file.
