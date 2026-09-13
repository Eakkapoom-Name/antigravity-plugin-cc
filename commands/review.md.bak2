---
description: Ask Antigravity (agy) for an independent read-only review of the current changes
argument-hint: "[staged|branch|<base-ref>] [extra focus instructions]"
allowed-tools: Bash(agy:*), Bash(git:*)
---

Run a read-only agy code review of the current git changes.

Scope selection from $ARGUMENTS:

- `staged`: review `git diff --cached`.
- `branch` or a base ref like `main`: review `git diff <base>...HEAD` (default base: the repository default branch).
- No scope argument: review `git diff HEAD` (unstaged plus staged working tree changes).
- Any remaining argument text is extra reviewer focus instructions.

Steps:

1. Collect the diff with the appropriate `git diff` command. If it is empty, say so and stop.
2. Write the diff to a temp file under the session scratchpad directory.
3. Run exactly one review call, read-only (no `--mode` flag):

```bash
agy -p "You are a strict code reviewer. Review the following unified diff for bugs, security issues, and logic errors. Report findings ordered by severity as 'file:line severity: problem. fix.' one per line. If there are no findings, say 'No findings.' Extra focus: <focus or none>. Diff follows:

$(cat <diff-file>)" --output-format json --print-timeout 9m
```

4. Present the findings using the `agy-result-handling` skill, ordered by severity, file paths verbatim.
5. CRITICAL: After presenting findings, STOP. Do not change any code. Ask the user which findings, if any, they want fixed before touching a single file.
6. Delete the temp diff file.
