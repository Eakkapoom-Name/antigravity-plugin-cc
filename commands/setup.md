---
description: Check whether the local Antigravity CLI (agy) is installed, authenticated, and ready
allowed-tools: Bash(agy:*), Bash(which:*)
---

Check agy readiness:

1. Run `which agy && agy --version`. If agy is not on PATH, tell the user to install the Antigravity CLI and stop. Do not guess an install command; point them to the official Antigravity documentation.
2. Run a tiny probe:

```bash
agy -p "Reply with exactly: OK" --output-format json --print-timeout 2m
```

3. If the probe returns JSON with `"status":"SUCCESS"`, report: agy version, probe round-trip time (`duration_seconds`), and that delegation via `/agy:delegate` is ready.
4. If the probe fails with an authentication or login error, tell the user to run `agy` once interactively in a terminal (suggest typing `! agy` in the prompt) to complete authentication, then rerun `/agy:setup`.
5. Report any other failure verbatim, including the decisive stderr line.
