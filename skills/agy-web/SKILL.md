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
  retry the same URL. Search mode applies the same refusal to a URL-shaped
  word inside the query, so a blocked address is refused whether it arrives
  as the whole argument or in the middle of a sentence.
- That refusal is a check on the URL given, made once before agy runs. It
  does not follow redirects, so a public URL that redirects to a blocked one
  is not caught here, and it cannot see a DNS answer that changes between the
  check and agy's own connection (rebinding). agy performs the actual fetch
  in its own process afterward, outside what this guard can observe. Treat a
  pass as "the URL given was not local," not as a guarantee about where the
  connection ends up.
- The check is `/agy:search`'s alone. `/agy:whisper`, `/agy:research` and
  `/agy:image` hand their text to the same web-capable agy with no URL check,
  so nothing refuses a local-network address named in one of those prompts.
- One question per run. A follow-up goes through `/agy:continue <id>`.
- agy spends the user's Antigravity quota; the built-in tools do not. That is
  why the built-ins come first.
