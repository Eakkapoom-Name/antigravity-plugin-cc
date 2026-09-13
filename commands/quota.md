---
description: Show remaining Antigravity model quota per bucket, with reset times
allowed-tools: Bash(node:*)
---

Show the user's remaining Antigravity (agy) model quota.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" quota
```

The script runs `agy -p "/usage" --output-format json` and reduces the payload. That is a print-mode slash command: it answers instantly, spends no quota, and leaves no conversation behind (verified on agy 1.2.2). It keeps the classic argv form deliberately, because slash commands are answered by the CLI itself and are unavailable under `--input-format stream-json`.

Presentation:

- `buckets` is a flat list, each entry carrying `group`, `window`, `remainingPercent`, `resetTime`, and `low`.
- Render one compact table: group, window, remaining percent, and `resetTime` converted to the user's local timezone.
- After the table, flag every entry with `low: true` in a one-line warning naming the bucket and its reset time.
- Do not add advice, interpretation, or filler beyond the table and any warnings.

Failure handling:

- On `ok: false`, report the `error` and stop. If it says agy is not installed, point at `/agy:setup`.
- If the error says this agy version predates print-mode `/usage`, relay that and the `agy update` suggestion. Do not retry, and do not fall back to running `/usage` as an agent prompt, which would spend quota.
