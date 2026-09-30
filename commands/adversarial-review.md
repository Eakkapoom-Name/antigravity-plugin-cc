---
description: Run an agy review that challenges the implementation approach and design choices
argument-hint: "[--allow-secret <regex>]... [--wait|--background] [staged|branch|<base-ref>] [focus ...]"
allowed-tools: Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an adversarial agy review of the current git changes. Position it as a challenge review: does the chosen approach hold up, what assumptions does it depend on, where do the design and tradeoffs fail under real-world conditions. It is not just a stricter pass over implementation defects.

Raw arguments: `$ARGUMENTS`

Core constraint:

- This command is review-only and the agy run is read-only: the script passes no `--mode`, so agy cannot edit. Do not fix issues, apply patches, or suggest you are about to make changes.
- After presenting findings, STOP. Ask the user which findings, if any, they want fixed before touching a single file.

Execution mode:

- `--wait`: run in the foreground. `--background`: run as a Claude background task. Strip only those two flags; forward everything else to the script as-is, including any `--allow-secret <regex>` the user gave, which is the only way a known-fixture false positive gets past the secret scan below.
- The first word of what remains is read as a scope only when it is `staged`, `branch`, or a branch, tag, or commit name (letters, digits, `.`, `_`, `/`, `-`) that git resolves (a commit id needs at least 7 hex digits); anything else is read as focus text, with the scope defaulting to the working tree. A branch that shares its name with the first focus word wins, so to keep that word as focus, put the focus after `staged`, `branch`, or a ref.
- If neither flag is present, estimate the size first with `git diff --shortstat` for the chosen scope, treating untracked files as reviewable work even when the diff stat is empty. Then ask once with AskUserQuestion, two options, recommended first with the `(Recommended)` suffix: `Wait for results` and `Run in background`. Recommend waiting only for a clearly tiny scope, roughly 1 or 2 files; otherwise recommend background.

Foreground flow:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" adversarial-review "<any --allow-secret <regex> flags, then scope and focus>"
```

Set the Bash tool timeout to 590000 ms.

Background flow:

- Run the same command with `run_in_background: true`. This is a Claude Code background *task*, not an `agy:agy-rescue` subagent, and the two are tracked differently.
- Do not route the background path through the `agy:agy-rescue` subagent to make it look like a delegation. That subagent passes its task text as an argument, which is exactly the size limit this command avoids by letting the companion stream the diff on stdin.
- Then tell the user: "agy adversarial review started in the background. Its output returns to this session when it finishes; `/agy:status` lists it alongside any subagent delegations." Do not wait or poll in this turn.

The script collects the diff, renders the prompt, and passes the diff to agy on stdin, so size is not a constraint. It also passes `--json-schema` pointing at `schemas/review-output.schema.json`, so the structured shape is enforced by agy rather than only requested in the prompt. The review itself runs isolated: agy runs from a temp directory, never the repository, and is handed only the diff. That is a working-directory change, not a sandbox: whether agy can still reach paths outside that directory depends on agy's own `toolPermission` setting (under `always-proceed` it can read a file by absolute path).

If the JSON has `failure: "secrets"`, the review did not run. List each `hits[]` entry as `<file>:<line> <kind> (<sample>)`, or just `<line> <kind> (<sample>)` when `file` is missing. A hit whose `side` is `removed` sits on a line the change deletes: say so, since its `line` is in the old version of the file, not the working tree. A hit whose `side` is `hunk-header` sits in the text git copies from the file into a hunk header, after its closing `@@`: say it is in a hunk header, copied from a line at or above line `line` in the old version of the file, possibly well above it (git copies the nearest earlier line that starts with a letter, `_` or `$`). A hit whose `side` is `header` or `unrecognized` sits on a diff line that is not file content, and its `line` counts lines of the raw diff text: say so. Say nothing left the machine, and give both ways forward: redact and rerun, or `--allow-secret <regex>` for a known false positive. Do not retry on your own.

Reading the JSON the script prints:

- `scopeNote`: the first word looked like a ref but git does not resolve it, so it was kept in the focus and the working tree was reviewed. Relay it to the user in one line, alongside whatever else the payload reports.
- `failure: "unmerged"`: the review did not run, because the diff is missing at least one file: an unresolved merge leaves conflicted paths out of `git diff --cached`. Report the `error`, name each entry of `paths`, say nothing left the machine, and tell the user to resolve the merge (fix the conflict markers and stage the result) before rerunning. Do not review the rest and do not retry.
- `failure: "diff-shape"`: the review did not run, because git's output did not have the shape the secret scanner reads. Report the `error`, say nothing left the machine, and stop.
- `ok: false` with an `error`: report it and stop.
- `empty: true`: say there is nothing to review in that scope, quoting `scope`, and list `untrackedFiles` if any.
- `failure: "agy-error"`: agy ended on a model or agent error (exit code 3, or an `AGY_ERROR:` line on stderr). Report it as a failure and quote `agyError`; if `result.response` has text, present it labelled as a partial answer, never as a finished result.
- Otherwise parse the review object out of `result.response` and render: verdict line, summary, then findings ordered by severity, each as `file:line_start-line_end severity (confidence): title. body. recommendation.`, then next steps. Keep agy's wording; do not soften or editorialize.
- If `result.response` is not valid JSON, present it verbatim and say the structured format was not followed.
- Report `result.conversation_id` on its own line at the end, resumable via `/agy:rescue --resume`.
