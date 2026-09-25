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
  the change is made, and when a `<verification_loop>` names tests, they pass.
  For an image: the file exists at the path the output contract named.
- `<verification_loop>`: only when tests are relevant to the request: a fix or
  implementation in code that tests cover, or a request that asks for tests.
  Leave it out for docs, comments, config, and read-only runs. When it is
  included, name the test command and the directory to run it from (for
  example `npm test`, from the repository root), taken from the request or the
  context given with it; when neither names a command, leave the block out
  rather than inventing one. Run it in one-shot mode (no watch mode), report
  the command and its result, and do not claim a pass you did not observe.
  Wait for or stop anything agy moved to the background before replying: since
  agy 1.2.9 a leftover background task holds the finished answer until the
  print timeout.
- `<grounding_rules>`: required for review and research. No claim without a
  source URL or an inspected artifact. Say when sources disagree. Say when
  evidence is thin rather than filling the gap.
- `<action_safety>`: for write-capable runs. Stay inside the named files or
  output location, make no unrelated refactors, and change no dependencies
  unless asked. Routine choices inside that scope, such as naming, placement,
  and the small restructuring a fix needs, are agy's to make; it lists them in
  its reply. End the run on a question only when the task needs a choice the
  request did not make that changes scope, public behaviour, or dependencies,
  and then say what is undecided. Leave no server or other process you started
  running; stop it by its PID or job id, never by name or port (no pkill,
  killall, `kill -1`, or `kill 0`). If the user asked for a process to stay
  up, start it detached (nohup or setsid, output to a file) and report its
  PID; agy waits on anything else and kills it at exit.

## Which blocks, by task

- Fix or implementation: `task`, `done_state`, `action_safety`, and
  `verification_loop` only when tests are relevant and a test command is
  known (see the block above).
- Review: `task`, `output_contract`, `grounding_rules`. Both `prompts/review.md`
  and `prompts/adversarial-review.md` use these tags directly.
- Research or search (`research`, `search`): `task`, `output_contract`,
  `grounding_rules`.
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
