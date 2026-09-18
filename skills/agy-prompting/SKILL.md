---
name: agy-prompting
description: Internal contract for composing the prompts this plugin sends to the Antigravity CLI (agy), for coding, review, research, and one-shot tasks
user-invocable: false
---

# Antigravity Prompting

Use this when composing a prompt for agy: the rescue agent's task text, and the
templates under `prompts/`. Prompt agy like an operator, not a collaborator:
compact, block-structured, one task per run, with the end state and the output
shape stated rather than implied.

## Blocks

Wrap each part in an XML tag so the prompt has a stable internal structure.
Include the blocks the task needs; leave the rest out.

- `<task>`: the concrete job and the repository or failure context. One task
  per run. Split unrelated asks into separate runs.
- `<output_contract>`: exact shape, ordering, and brevity. Name the sections
  and their order when the answer is a report; say "one line" when it is one
  line.
- `<done_state>`: what finished looks like. agy does not infer it. For a fix:
  the named tests pass. For a review: every hunk considered. For research: the
  question answered with sources.
- `<verification_loop>`: required for fixes and implementation. Run the tests
  the change touches, report the command and its result, and do not claim a
  pass you did not observe.
- `<grounding_rules>`: required for review and research. No claim without a
  source URL or an inspected artifact. Say when sources disagree. Say when
  evidence is thin rather than filling the gap.
- `<action_safety>`: for write-capable runs. Stay inside the named files,
  make no unrelated refactors, change no dependencies unless asked, and stop
  to ask when the task turns out to need a decision the prompt did not make.

## Which blocks, by task

- Fix or implementation: `task`, `done_state`, `verification_loop`,
  `action_safety`.
- Review: `task`, `output_contract`, `grounding_rules`. The review templates
  already carry this contract.
- Research or search: `task`, `output_contract`, `grounding_rules`.
- One-shot question (`whisper`): `task`, `output_contract`.

## Rules

- One clear task per run. A follow-up on the same conversation
  (`/agy:continue`) sends only the delta.
- State the output contract instead of raising effort or adding prose.
- Do not ask agy to skip its own confirmations or permissions; that wording is
  refused by the host classifier and by agy's own settings.
- Keep the prompt free of secrets. The companion blocks a diff or brief that
  carries a credential shape before it is sent.
