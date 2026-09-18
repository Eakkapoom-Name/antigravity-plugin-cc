---
description: Transfer the current Claude Code session into a resumable agy conversation
argument-hint: "[--model <model>] [--effort <low|medium|high>] [extra context or focus]"
allowed-tools: Write, Bash(node:*)
---

Hand the current session's context to Antigravity (agy) so work can continue there, in a fresh agy conversation seeded with a handoff brief.

Raw arguments:
$ARGUMENTS

1. Compose a handoff brief from this conversation. Plain markdown, sections in this order:
   - **Goal**: what the user is trying to achieve, one or two sentences.
   - **State**: what has been done so far, with concrete file paths and repo location.
   - **Decisions**: choices already made and their reasons. Do not reopen them.
   - **Open items**: what remains, most important first.
   - Append any extra context or focus text from $ARGUMENTS.
   Keep the brief factual and self-contained; agy sees none of the original conversation.

2. Write the brief to a file in the session scratchpad directory with the `Write` tool. This is the one part the script cannot do, because it summarizes a conversation the script cannot see.

3. Pass the script the **path**, never the brief text:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" transfer "<path to the brief file>" [--model <model>] [--effort <low|medium|high>]
```

Pass `--model` or `--effort` through only if the user supplied them; strip them from the text you fold into the brief so they are not mistaken for context.

Set the Bash tool timeout to 590000 ms. The script reads the brief, sends it to agy on stdin, and deletes the file afterwards, so the brief never passes through a command line whatever its length.

4. Present `result` per the `agy-result-handling` skill. Then show, verbatim, both resume paths:
   - In a terminal: `agy --conversation <conversation_id>`
   - From Claude Code: `/agy:rescue --resume <follow-up task>`

5. If agy's stated understanding contradicts the brief, say so plainly next to the reply; do not silently correct it.

6. On `ok: false`, report the `error` and stop. If agy is missing, point at `/agy:setup`. Do not retry.

If the JSON has `failure: "secrets"`, the handoff did not run and there is no `error` field to report. List each `hits[]` entry as `<line> <kind> (<sample>)`, say nothing left the machine, and say the way forward: edit the brief to remove or redact the credential, then rerun. There is no `--allow-secret` flag on this command. Do not retry on your own.
