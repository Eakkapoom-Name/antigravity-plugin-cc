# antigravity-plugin-cc

Use Google's Antigravity CLI (`agy`) from inside Claude Code: delegate tasks to a second model, resume agy conversations, and get independent code reviews.

## Requirements

- Antigravity CLI (`agy`) installed and authenticated (tested against agy 1.1.20)
- Claude Code with plugin support

## Commands

- `/agy:rescue [flags] <task>`: hand a task to agy through the `agy-rescue` subagent.
  - `--background` / `--wait`: Claude-side execution mode (default foreground)
  - `--resume` / `--fresh`: continue the last agy conversation, or start a new one
  - `--model <name>`, `--effort <low|medium|high>`: passed through to agy
- `/agy:review [staged|branch|<base-ref>] [focus]`: read-only agy review of the current git diff.
- `/agy:adversarial-review [--wait|--background] [scope] [focus]`: challenge review that questions the approach, design choices, and assumptions; structured verdict and findings (see `schemas/review-output.schema.json`).
- `/agy:status [id]`: show active and recent background agy delegations in this session.
- `/agy:result [id]`: show the stored final output of a finished background delegation.
- `/agy:cancel [id]`: stop a running background delegation (the agy conversation stays resumable).
- `/agy:setup`: check that agy is installed and authenticated.

## Design

Thin by design: no broker process, no job files. Every delegation is one `agy -p … --output-format json` call. Write-capable runs use `--mode accept-edits`; reviews run read-only. Foreground runs are capped near 9 minutes by the Bash tool ceiling; split longer work or use `--background`.

Job control stays thin too: `/agy:status`, `/agy:result`, and `/agy:cancel` read Claude Code's own background task tracking instead of a job store, so they cover the current session only. Cross-session continuity lives agy-side via `conversation_id` and `/agy:rescue --resume`.

## Layout

```
.claude-plugin/plugin.json   manifest (plugin name: agy)
agents/agy-rescue.md         forwarding subagent
commands/                    rescue, review, adversarial-review, status, result, cancel, setup
schemas/                     adversarial review output shape
skills/agy-cli-runtime/      CLI call contract
skills/agy-result-handling/  output presentation rules
```

## Install

```bash
claude plugin marketplace add Eakkapoom-Name/antigravity-plugin-cc
claude plugin install agy@antigravity-plugin-cc
```

Restart Claude Code, then run `/agy:setup`.
