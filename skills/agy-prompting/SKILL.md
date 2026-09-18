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
  question answered with sources. For an image: the file exists at the path
  the output contract named.
- `<verification_loop>`: required for fixes and implementation. Run the tests
  the change touches, report the command and its result, and do not claim a
  pass you did not observe.
- `<grounding_rules>`: required for review and research. No claim without a
  source URL or an inspected artifact. Say when sources disagree. Say when
  evidence is thin rather than filling the gap.
- `<action_safety>`: for write-capable runs. Stay inside the named files or
  output location, make no unrelated refactors, change no dependencies unless
  asked, and stop to ask when the task turns out to need a decision the
  prompt did not make.

## Which blocks, by task

- Fix or implementation: `task`, `done_state`, `verification_loop`,
  `action_safety`.
- Review: `task`, `output_contract`, `grounding_rules`. The review templates
  carry this contract in prose today; they predate the tagged block form, so
  read them for the substance, not as a worked example of the tags. New
  templates use the tags directly.
- Research or search (`search`): `task`, `output_contract`, `grounding_rules`.
- Fetch a single URL (`fetch`): `task`, `output_contract`. It renders one page
  into readable text, the second half of `/agy:search`; there is no claim to
  ground, so `grounding_rules` does not apply.
- One-shot question (`whisper`): `task`, `output_contract`.
- Generate an image (`image`): `task`, `output_contract`, `done_state`,
  `action_safety`. The output contract names the file path agy must return;
  `action_safety` scopes where it may write, and `done_state` is that file
  existing at the named path.

## Rules

- One clear task per run. A follow-up on the same conversation
  (`/agy:continue`) sends only the delta.
- State the output contract instead of raising effort or adding prose.
- Do not ask agy to skip its own confirmations or permissions; that wording is
  refused by the host classifier and by agy's own settings.
- Keep the prompt free of secrets. The companion blocks a diff or brief that
  carries a credential shape before it is sent.
