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

Flag contract (verified against agy 1.2.2):

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

Flags that exist on 1.2.2 and are worth knowing:

- `--input-format <text|stream-json>`: `stream-json` reads one NDJSON message per line from stdin and requires `--output-format stream-json`. The input line is `{"event":"user","message":{"role":"user","content":"..."}}`; the `event` key is required and a `type` key is rejected. This is how the companion script sends prompts, because argv is capped (2097152 bytes on a typical Linux box) and a branch diff can exceed it. `-p` still needs an argument in this mode, so it is passed as `-p=`.
- `--json-schema <string or path>`: enforces structured output. For stream-json it applies to the final result. `/agy:adversarial-review` uses it so its review object is enforced rather than merely requested in prose.
- `--mode <accept-edits|plan>`: `plan` is a second mode next to `accept-edits`. Unexplored here; it may be the supported way to ask for a plan without edits, instead of detecting a plan-shaped answer afterwards.
- `--sandbox`: runs agy with terminal restrictions enabled. A plausible source of the environment failure `/agy:setup` classifies as `environment`.
- `--disable-slash-commands`: turns off slash command and skill expansion in print mode. `/agy:quota` depends on that expansion, so this flag breaks it.

Constraint worth remembering: slash commands are answered by the CLI itself and are **unavailable** under `--input-format stream-json`. agy says so explicitly. Anything needing `/usage` or another slash command must use the argv form with `--output-format json`.

Result JSON shape (verified on agy 1.2.2). Under `--output-format stream-json` the terminal `{"event":"result","result":{...}}` carries this same object, plus an `error` field when it failed, which is why both transports feed the same result handling:

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

Print-mode slash commands (verified on agy 1.2.2): `agy -p "/usage" --output-format json` (also `/help`, `/changelog`, `/permissions`, `/hooks`, `/config`) answers instantly with a structured payload under a top-level `command` object, spends no quota, and leaves no conversation behind. Detect support by checking that `command.name` matches the requested command; older agy versions treat the text as a normal prompt.

Rules:

- One `agy` invocation per handoff. No retries without being asked.
- Run from the repository root the task concerns.
- Escape the task text safely; prefer a single-quoted heredoc into a shell variable when the text contains quotes.
- Known limit: foreground runs are capped near 9 minutes by the Bash tool ceiling. Report a timeout as a timeout; do not silently retry.
