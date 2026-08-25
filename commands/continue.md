---
description: Send a follow-up into an existing agy conversation instead of starting a new one
argument-hint: "[conversation-id] [--background|--wait] [--model <model>] [--effort <low|medium|high>] <follow-up for agy>"
allowed-tools: Bash(agy:*), AskUserQuestion, Agent
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

- The subagent is a thin forwarder only: one `Bash` call to `agy -p`, stdout returned as-is.
- Present the result using the `agy-result-handling` skill. Do not silently rewrite agy's answer.
- Always report the returned `conversation_id` so the user can keep the thread going with another `/agy:continue`.
- If agy is missing or errors out immediately, stop and tell the user to run `/agy:setup`.
- If the user supplied no follow-up text (or only a conversation id), ask what agy should do next in that conversation.
