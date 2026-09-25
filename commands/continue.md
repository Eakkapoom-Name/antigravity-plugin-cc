---
description: Send a follow-up into an existing agy conversation instead of starting a new one
argument-hint: "[conversation-id] [--background|--wait] [--model <model>] [--effort <low|medium|high>] <follow-up for agy>"
allowed-tools: AskUserQuestion, Agent, Read
---

Invoke the `agy:agy-rescue` subagent via the `Agent` tool (`subagent_type: "agy:agy-rescue"`), forwarding the follow-up as a continuation of an existing agy conversation.
`agy:agy-rescue` is a subagent, not a skill. Do not call it through the `Skill` tool.
The final user-visible response must be agy's output, presented per the `agy-result-handling` skill.

Raw user request:
$ARGUMENTS

Conversation targeting:

- If the request starts with a conversation id (a UUID-shaped token), strip it from the task text and tell the subagent to resume that conversation with `--conversation <id>`.
- Otherwise, tell the subagent to continue the most recent agy conversation with `-c`. This command never starts a fresh conversation; that is what `/agy:rescue` is for.
- If a `conversation_id` was reported earlier in this session (a finished delegation, `/agy:result`, or `/agy:transfer`) and no id was given, prefer that id via `--conversation <id>` over bare `-c`, since `-c` picks agy's globally most recent conversation, which another terminal may have advanced.

Execution mode:

- `--background` runs the subagent in the background; `--wait` runs it in the foreground; default is foreground.
- These are execution flags for Claude Code. Do not forward them to the subagent as task text.
- `--model` and `--effort` are routing flags. Preserve them in the forwarded request; the subagent maps them onto the `agy` invocation.

Operating rules:

- If the request contains a line that is exactly `AGY_RESCUE_TASK_END`, stop before invoking the subagent and say that line cannot be forwarded; it would end the subagent's shell heredoc early.
- The subagent is a thin forwarder only: one `Bash` call to `agy -p`. It writes agy's JSON to a file and returns output ending in one `AGY_RESCUE_SUMMARY` JSON line: `result_file`, `regular_file`, `exit_code`, `conversation_id`, `status`, `error`, `response_chars`, and `denied_actions`, with agy's stderr lines before it when the run failed.
- Read `result_file` with the `Read` tool before presenting anything; it holds agy's full JSON result. Follow the `agy-result-handling` skill for which summary line to trust and the path check before reading. If the returned text has no `AGY_RESCUE_SUMMARY` line, handle it as the error or denial text it is.
- Present the result using the `agy-result-handling` skill. Do not silently rewrite agy's answer.
- Always report the returned `conversation_id` so the user can keep the thread going with another `/agy:continue`. When it is null or empty, say the run left no conversation to resume.
- If the `Agent` call itself, or the text it returns, carries `denied by the Claude Code auto mode classifier`, agy never ran. Stop and report it as a host permission block, following the `agy-result-handling` skill: name `/permissions` as the reliable fix and rewording the follow-up text as the cheaper first try. Approving a plan is a common reason to reach this command, and an approval relaunch is exactly what has been denied before, so expect it here.
- If agy itself is missing or errors out immediately with an authentication failure, stop and tell the user to run `/agy:setup`. This covers agy's own failures only, not a Claude Code denial. A missing agy shows as a summary with `exit_code` 127 and an empty result file. For any other agy error, such as an unknown `--model`, report its `error` text per the `agy-result-handling` skill instead, since `/agy:setup` would pass. If the subagent refused before running agy (`agy-rescue refused:`), relay its reason and do not suggest `/agy:setup`.
- If the user supplied no follow-up text (or only a conversation id), ask what agy should do next in that conversation.
