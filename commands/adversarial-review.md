---
description: Run an agy review that challenges the implementation approach and design choices
argument-hint: "[--wait|--background] [staged|branch|<base-ref>] [focus ...]"
allowed-tools: Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an adversarial agy review of the current git changes. Position it as a challenge review: does the chosen approach hold up, what assumptions does it depend on, where do the design and tradeoffs fail under real-world conditions. It is not just a stricter pass over implementation defects.

Raw arguments: `$ARGUMENTS`

Core constraint:

- This command is review-only and the agy run is read-only: the script passes no `--mode`, so agy cannot edit. Do not fix issues, apply patches, or suggest you are about to make changes.
- After presenting findings, STOP. Ask the user which findings, if any, they want fixed before touching a single file.

Execution mode:

- `--wait`: run in the foreground. `--background`: run as a Claude background task. Strip either flag before passing the rest to the script.
- If neither flag is present, estimate the size first with `git diff --shortstat` for the chosen scope, treating untracked files as reviewable work even when the diff stat is empty. Then ask once with AskUserQuestion, two options, recommended first with the `(Recommended)` suffix: `Wait for results` and `Run in background`. Recommend waiting only for a clearly tiny scope, roughly 1 or 2 files; otherwise recommend background.

Foreground flow:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" adversarial-review "<scope and focus>"
```

Set the Bash tool timeout to 590000 ms.

Background flow:

- Run the same command with `run_in_background: true`. This is a Claude Code background *task*, not an `agy:agy-rescue` subagent, and the two are tracked differently.
- Do not route the background path through the `agy:agy-rescue` subagent to make it look like a delegation. That subagent passes its task text as an argument, which is exactly the size limit this command avoids by letting the companion stream the diff on stdin.
- Then tell the user: "agy adversarial review started in the background. Its output returns to this session when it finishes; `/agy:status` lists it alongside any subagent delegations." Do not wait or poll in this turn.

The script collects the diff, renders the prompt, and passes the diff to agy on stdin, so size is not a constraint. It also passes `--json-schema` pointing at `schemas/review-output.schema.json`, so the structured shape is enforced by agy rather than only requested in the prompt.

Reading the JSON the script prints:

- `ok: false` with an `error`: report it and stop.
- `empty: true`: say there is nothing to review in that scope, quoting `scope`, and list `untrackedFiles` if any.
- Otherwise parse the review object out of `result.response` and render: verdict line, summary, then findings ordered by severity, each as `file:line_start-line_end severity (confidence): title. body. recommendation.`, then next steps. Keep agy's wording; do not soften or editorialize.
- If `result.response` is not valid JSON, present it verbatim and say the structured format was not followed.
- Report `result.conversation_id` on its own line at the end, resumable via `/agy:rescue --resume`.
