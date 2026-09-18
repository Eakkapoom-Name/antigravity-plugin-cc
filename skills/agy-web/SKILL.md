---
name: agy-web
description: When Claude Code should reach past its own WebSearch and WebFetch to /agy:search, and what that command's search and fetch modes return
user-invocable: false
---

# Web lookups through agy

Claude Code's own WebSearch and WebFetch run first for any web lookup.
`/agy:search <query or URL>` runs a web search, or fetches one page, through
the Antigravity CLI, and sits **second** in the web tool order:

1. Claude Code's own WebSearch and WebFetch first.
2. `/agy:search` when they fail: a 403, a bot challenge, a truncated summary, a
   raw text file that WebFetch will not render, or a page that needs a model
   to extract the content.
3. Tavily (`tvly`), then ddg-search, after that.

## What comes back

- Search mode returns a grounded answer with a `Sources:` list of full URLs.
  It is an answer, not a results list; there is no ranking to page through.
- Fetch mode returns the page as model-extracted markdown with a `Links:`
  list. It is extracted text, not raw bytes; exact byte-level content (a
  checksum, a binary, a script to run) still needs WebFetch or a download.

## Rules

- Every answer must carry source URLs. Refuse to cite an `/agy:search` result
  that has none; rerun with the question rephrased or fall through to the
  next tier.
- Fetch mode refuses local, private, and link-local targets, non-http
  schemes, and URLs with credentials. That is not a transient error; do not
  retry the same URL.
- One question per run. A follow-up goes through `/agy:continue <id>`.
- agy spends the user's Antigravity quota; the built-in tools do not. That is
  why the built-ins come first.
