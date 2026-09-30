---
description: Web search, or a single page fetch, through Antigravity (agy) instead of the built-in web tools
argument-hint: "[--allow-secret <regex>]... [--model <name>] <query or URL>"
allowed-tools: Bash(node:*)
---

Run a web search, or fetch one page, through agy. Use a Bash `timeout` of `300000` ms; the companion caps agy at a 3 minute print timeout and gives the call a 4 minute spawn timeout, leaving margin under this Bash timeout.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" search "$ARGUMENTS"
```

One argument, two modes: a single `http://` or `https://` URL fetches that page as markdown; anything else is a search question answered with a `Sources:` list. `mode` in the JSON says which ran.

If the JSON has `failure: "agy-error"`, agy ended on a model or agent error (exit code 3, or an `AGY_ERROR:` line on stderr): report it as a failure and quote `agyError`; if `result.response` has text, present it labelled as a partial answer, never as a finished result.

Present `result.response` as-is, keeping the `Sources:` or `Links:` list intact; those URLs are the evidence. Report `result.conversation_id` on its own line as resumable via `/agy:continue`.

If the JSON has `failure: "secrets"`, the run did not start and there is no `error` field to report: the query or URL text carries what looks like a credential. List each `hits[]` entry as `<line> <kind> (<sample>)`, since the argument is scanned as plain text and a hit has no file. Say nothing left the machine, and give both ways forward: redact the credential from the argument and rerun, or `--allow-secret <regex>` for a known false positive. Do not retry on your own.

If `failure` is `url-blocked`, agy did not run: a URL in the argument (the whole argument in fetch mode, or a URL-shaped word inside a search query; `mode` says which) pointed at a local or reserved address, used a scheme other than http or https, or carried credentials. Quote `error` and stop. If the text returned is not JSON and contains `denied by the Claude Code auto mode classifier`, agy never ran; follow the `agy-result-handling` skill.
