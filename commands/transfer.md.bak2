---
description: Transfer the current Claude Code session into a resumable agy conversation
argument-hint: "[--model <model>] [extra context or focus]"
allowed-tools: Bash(agy:*)
---

Hand the current session's context to Antigravity (agy) so work can continue there, in a fresh agy conversation seeded with a handoff brief.

Raw arguments:
$ARGUMENTS

Steps:

1. Compose a handoff brief from this conversation. Plain markdown, sections in this order:
   - **Goal**: what the user is trying to achieve, one or two sentences.
   - **State**: what has been done so far, with concrete file paths and repo location.
   - **Decisions**: choices already made and their reasons. Do not reopen them.
   - **Open items**: what remains, most important first.
   - Append any extra context or focus text from $ARGUMENTS.
   Keep the brief factual and self-contained; agy sees none of the original conversation.
2. Write the brief to a temp file under the session scratchpad directory (quotes, `$`, and backticks in the brief must never hit the shell unescaped).
3. Run exactly one seeding call, read-only (no `--mode` flag), per the `agy-cli-runtime` skill. Pass `--model` through only if given:

```bash
agy -p "You are taking over an ongoing task from another assistant. Read this handoff brief, then reply with: (a) your one-paragraph understanding of the goal and current state, (b) the first action you would take. Do not start working yet.

$(cat <brief-file>)" --output-format json --print-timeout 9m
```

4. Present agy's reply per the `agy-result-handling` skill. Then show, verbatim, both resume paths:
   - In a terminal: `agy --conversation <conversation_id>`
   - From Claude Code: `/agy:rescue --resume <follow-up task>`
5. If agy's stated understanding contradicts the brief, say so plainly next to the reply; do not silently correct it.
6. If the call fails, report the failure per `agy-result-handling` and point to `/agy:setup`. Do not retry.
7. Delete the temp brief file.
