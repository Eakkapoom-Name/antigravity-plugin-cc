---
description: Ask Antigravity (agy) for an independent read-only review of the current changes
argument-hint: "[--allow-secret <regex>]... [staged|branch|<base-ref>] [extra focus instructions]"
allowed-tools: Bash(node:*)
---

Run a read-only agy code review of the current git changes.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" review "$ARGUMENTS"
```

Set the Bash tool timeout to 590000 ms; the script allows agy up to 8 minutes.

The script does all of it: scope selection, diff collection, prompt construction, and the agy call. The diff goes to agy on stdin, so there is no size limit to work around and nothing for you to write to a temp file. The review itself runs isolated: agy runs from a temp directory, never the repository, and is handed only the diff. That is a working-directory change, not a sandbox: whether agy can still reach paths outside that directory depends on agy's own `toolPermission` setting (under `always-proceed` it can read a file by absolute path).

If the JSON has `failure: "secrets"`, the review did not run. List each `hits[]` entry as `<file>:<line> <kind> (<sample>)`, or just `<line> <kind> (<sample>)` when `file` is missing. A hit whose `side` is `removed` sits on a line the change deletes: say so, since its `line` is in the old version of the file, not the working tree. A hit whose `side` is `hunk-header` sits in the text git copies from the file into a hunk header, after its closing `@@`: say it is in a hunk header, copied from a line at or above line `line` in the old version of the file, possibly well above it (git copies the nearest earlier line that starts with a letter, `_` or `$`). A hit whose `side` is `header` or `unrecognized` sits on a diff line that is not file content, and its `line` counts lines of the raw diff text: say so. Say nothing left the machine, and give both ways forward: redact and rerun, or `--allow-secret <regex>` for a known false positive. Do not retry on your own.

Core constraint:

- This command is review-only. Do not fix issues, apply patches, or suggest you are about to make changes.
- After presenting findings, STOP. Ask the user which findings, if any, they want fixed before touching a single file.

Reading the JSON the script prints:

- `failure: "diff-shape"`: the review did not run, because git's output did not have the shape the secret scanner reads. Report the `error`, say nothing left the machine, and stop.
- `ok: false` with an `error`: report the error and stop. If it says agy is not installed, point at `/agy:setup`.
- `empty: true`: say there is nothing to review in that scope, quoting `scope`. If `untrackedFiles` is non-empty, list them and say a diff review does not cover untracked files.
- Otherwise present `result` per the `agy-result-handling` skill: findings first, ordered by severity, file paths and line numbers verbatim, then the `conversation_id` on its own line.

`scope` names what was actually reviewed. Report it, rather than assuming which scope the user's argument selected.
