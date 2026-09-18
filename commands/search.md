---
description: Web search, or a single page fetch, through Antigravity (agy) instead of the built-in web tools
argument-hint: "[--model <name>] <query or URL>"
allowed-tools: Bash(node:*)
---

Run a web search, or fetch one page, through agy. Use a Bash `timeout` of `200000` ms; the companion caps agy at a 3 minute print timeout.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" search "$ARGUMENTS"
```

One argument, two modes: a single `http://` or `https://` URL fetches that page as markdown; anything else is a search question answered with a `Sources:` list. `mode` in the JSON says which ran.

Present `result.response` as-is, keeping the `Sources:` or `Links:` list intact; those URLs are the evidence. Report `result.conversation_id` on its own line as resumable via `/agy:continue`.

If `failure` is `url-blocked`, agy did not run: a URL in the argument (the whole argument in fetch mode, or a URL-shaped word inside a search query; `mode` says which) pointed at a local or reserved address, used a scheme other than http or https, or carried credentials. Quote `error` and stop. If the text returned is not JSON and contains `denied by the Claude Code auto mode classifier`, agy never ran; follow the `agy-result-handling` skill.
