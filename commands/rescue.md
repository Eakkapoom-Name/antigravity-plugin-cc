---
description: Delegate investigation, an explicit fix request, or follow-up work to the Antigravity (agy) rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model>] [--effort <low|medium|high>] [what agy should investigate, solve, or continue]"
allowed-tools: Bash(agy:*), AskUserQuestion, Agent
---

Invoke the `agy:agy-rescue` subagent via the `Agent` tool (`subagent_type: "agy:agy-rescue"`), forwarding the raw user request as the prompt.
`agy:agy-rescue` is a subagent, not a skill. Do not call it through the `Skill` tool.
The final user-visible response must be agy's output, presented per the `agy-result-handling` skill.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the subagent in the background.
- If the request includes `--wait`, run the subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to the subagent as task text.
- `--model`, `--effort`, `--resume`, and `--fresh` are routing flags. Preserve them in the forwarded request; the subagent maps them onto the `agy` invocation.

Operating rules:

- The subagent is a thin forwarder only: one `Bash` call to `agy -p`, stdout returned as-is.
- Present the result using the `agy-result-handling` skill. Do not silently rewrite agy's answer.
- Always report the returned `conversation_id` so the user can resume with `--resume`.
- If the `Agent` call itself, or the text it returns, carries `denied by the Claude Code auto mode classifier`, agy never ran. Stop and report it as a host permission block, following the `agy-result-handling` skill: name `/permissions` as the reliable fix and rewording the task text as the cheaper first try. Do not send the user to `/agy:setup` for this, and do not relaunch the subagent, which is denied again.
- If the response is a plan ending in a question and no files were touched, say the run made no edits and give the user the `/agy:continue <conversation_id> Yes, proceed.` follow-up, per the `agy-result-handling` skill.
- If agy itself is missing or errors out immediately, stop and tell the user to run `/agy:setup`. This covers agy's own failures only, not a Claude Code denial.
- If the user did not supply a request, ask what agy should investigate or fix.
