---
name: agy-cli-runtime
description: Internal helper contract for calling the Antigravity CLI (agy) from Claude Code
user-invocable: false
---

# Antigravity CLI Runtime

Use this skill only inside the `agy:agy-rescue` subagent or the `/agy:*` commands.

Base invocation:

```bash
agy -p "<task text>" --output-format json --print-timeout 9m
```

Flag contract (verified against agy 1.1.20):

- `-p` / `--print`: run one prompt non-interactively and print the response.
- `--output-format json`: single JSON result object on stdout.
- `--print-timeout <dur>`: agy-side wait limit. Default is 5m; use 9m and pair it with a 590000 ms Bash tool timeout so Bash does not kill agy first.
- `--mode accept-edits`: auto-approve file edits. Add for write-capable runs. Omit for read-only runs (review, diagnosis, research).
- `-c` / `--continue`: continue the most recent agy conversation. `--conversation <id>`: resume a specific one.
- `--model <name>`: only when the user asked for a specific model. List with `agy models`; do not hardcode model names.
- `--effort <low|medium|high>`: only when the user asked for a specific effort.
- `--add-dir <path>`: add extra directories to the agy workspace. Repeatable.
- `--agent <name>`: select an agy-side agent. List with `agy agents`. Leave unset by default.
- Never pass `--dangerously-skip-permissions` unless the user explicitly asked for it in this session.

Result JSON shape (verified on agy 1.1.20):

```json
{
  "conversation_id": "…",
  "status": "SUCCESS",
  "response": "…",
  "duration_seconds": 3.9,
  "num_turns": 1,
  "usage": {"input_tokens": 0, "output_tokens": 0, "thinking_tokens": 0, "cache_read_tokens": 0, "total_tokens": 0}
}
```

Rules:

- One `agy` invocation per handoff. No retries without being asked.
- Run from the repository root the task concerns.
- Escape the task text safely; prefer a single-quoted heredoc into a shell variable when the text contains quotes.
- Known limit: foreground runs are capped near 9 minutes by the Bash tool ceiling. Report a timeout as a timeout; do not silently retry.
