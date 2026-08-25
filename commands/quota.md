---
description: Show remaining Antigravity model quota per bucket, with reset times
allowed-tools: Bash(agy:*)
---

Show the user's remaining Antigravity (agy) model quota.

Run exactly one command:

```bash
agy -p "/usage" --output-format json
```

This is a print-mode slash command: it answers instantly, spends no quota, and leaves no conversation behind (verified on agy 1.1.20).

Parsing:

- The payload is a single JSON object. The quota data lives under `command.data.groups[]`, each group having `name` (for example "Gemini Models", "Claude and GPT models") and `buckets[]` with `id`, `window` (`5h` or `weekly`), `remaining_fraction` (float, 1 = fully available), and `reset_time` (ISO-8601 UTC).
- Ignore the top-level `response` field (a tab-separated rendering of the same data); the structured `command.data` object is the source of truth.

Presentation:

- One compact table: group, window, remaining % (`remaining_fraction * 100`, one decimal), and reset time converted to the user's local timezone.
- After the table, flag any bucket below 20% remaining with a one-line warning naming the bucket and its reset time.
- Do not add advice, interpretation, or filler beyond the table and any warnings.

Failure handling:

- If `agy` is not installed or the call fails immediately, stop and tell the user to run `/agy:setup`.
- If the result has no `command` object or `command.name` is not `usage`, this agy version predates print-mode `/usage`: say so and suggest `agy update`. Do not retry, and do not fall back to running `/usage` as an agent prompt, which would spend quota.
