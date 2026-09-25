---
description: Delegate investigation, an explicit fix request, or follow-up work to the Antigravity (agy) rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model>] [--effort <low|medium|high>] [what agy should investigate, solve, or continue]"
allowed-tools: AskUserQuestion, Agent, Read
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

- If the request contains a line that is exactly `AGY_RESCUE_TASK_END`, stop before invoking the subagent and say that line cannot be forwarded; it would end the subagent's shell heredoc early.
- The subagent is a thin forwarder only: one `Bash` call to `agy -p`. It writes agy's JSON to a file and returns output ending in one `AGY_RESCUE_SUMMARY` JSON line: `result_file`, `regular_file`, `exit_code`, `conversation_id`, `status`, `error`, `response_chars`, and `denied_actions`, with agy's stderr lines before it when the run failed.
- Read `result_file` with the `Read` tool before presenting anything; it holds agy's full JSON result. Follow the `agy-result-handling` skill for which summary line to trust and the path check before reading. If the returned text has no `AGY_RESCUE_SUMMARY` line, handle it as the error or denial text it is.
- Present the result using the `agy-result-handling` skill. Do not silently rewrite agy's answer.
- Always report the returned `conversation_id` so the user can resume with `--resume`. When it is null or empty, say the run left no conversation to resume.
- If the `Agent` call itself, or the text it returns, carries `denied by the Claude Code auto mode classifier`, agy never ran. Stop and report it as a host permission block, following the `agy-result-handling` skill: name `/permissions` as the reliable fix and rewording the task text as the cheaper first try. Do not send the user to `/agy:setup` for this, and do not relaunch the subagent, which is denied again.
- If the JSON carries a non-empty `denied_actions` array, the run did nothing, whatever `status` and `response` say. Report it as a permission failure per the `agy-result-handling` skill, naming each denied action and the rule for it (`read_file(*)` for a denied read, `command(...)` for a denied command). The settings edit is the user's manual step outside the session; do not attempt it and do not relaunch.
- If the response is a plan ending in a question and no files were touched, say the run made no edits and give the user the `/agy:continue <conversation_id> Yes, proceed.` follow-up, per the `agy-result-handling` skill.
- If agy itself is missing or errors out immediately with an authentication failure, stop and tell the user to run `/agy:setup`. This covers agy's own failures only, not a Claude Code denial. A missing agy shows as a summary with `exit_code` 127 and an empty result file. For any other agy error, such as an unknown `--model`, report its `error` text per the `agy-result-handling` skill instead, since `/agy:setup` would pass. If the subagent refused before running agy (`agy-rescue refused:`), relay its reason and do not suggest `/agy:setup`.
- If the user did not supply a request, ask what agy should investigate or fix.
