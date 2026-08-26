---
description: Check whether the local Antigravity CLI (agy) is installed, authenticated, and ready, and toggle the stop-review gate
argument-hint: "[gate on|off|status]"
allowed-tools: Bash(agy:*), Bash(which:*), Read, Write, Edit
---

If $ARGUMENTS starts with `gate`, manage the stop-review gate and skip the readiness check:

- The gate is a Stop hook that hands the previous Claude turn to a read-only agy review before the session is allowed to end. It is off by default and per project.
- The toggle lives in `.claude/agy.local.md` in the project root, as `stop_review_gate: true` (or `false`) in the YAML frontmatter. Create the file if missing:

```markdown
---
stop_review_gate: true
---

Local agy plugin settings for this project. Not meant to be committed.
```

- `gate on`: set `stop_review_gate: true`. Warn the user that ending a turn can now take up to the agy review round-trip, and that the review only blocks when the previous turn made code changes with unresolved issues.
- `gate off`: set `stop_review_gate: false`.
- `gate status` (or bare `gate`): report the current value, or "off (no settings file)".

Otherwise check agy readiness:

1. Run `which agy && agy --version`. If agy is not on PATH, tell the user to install the Antigravity CLI and stop. Do not guess an install command; point them to the official Antigravity documentation.
2. Run a tiny probe:

```bash
agy -p "Reply with exactly: OK" --output-format json --print-timeout 2m
```

3. If the probe fails with an authentication or login error, tell the user to run `agy` once interactively in a terminal (suggest typing `! agy` in the prompt) to complete authentication, then rerun `/agy:setup`.
4. If the probe succeeded, run a second probe that exercises a tool, because headless runs auto-deny any tool not covered by agy's own permission settings and the first probe cannot detect that:

```bash
agy -p "Use your terminal command tool to run 'pwd' and reply with exactly its output." --output-format json --print-timeout 2m
```

5. Judge the tool probe: it passes only when `response` is non-empty and contains the working directory. It fails on an empty `response` (regardless of `status`, which has been observed as both `SUCCESS` and `CANCELED` in this situation) or a stderr line starting with `jetski: no output produced` saying a tool permission was auto-denied. On failure, report that delegation will not work headlessly until agy's permission settings allow tools: the user must either add allow-rules under `permissions.allow` in `~/.gemini/antigravity-cli/settings.json` (agy's denial message shows the exact rule syntax, for example `command(<target>)`) or use a permissive `toolPermission` setting there. Quote the decisive stderr line.
6. If both probes pass, report: agy version, probe round-trip time (`duration_seconds`), that delegation via `/agy:rescue` is ready, and the current stop-review gate state.
7. Report any other failure verbatim, including the decisive stderr line.
