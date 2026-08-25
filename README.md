# antigravity-plugin-cc

Use Google's Antigravity CLI (`agy`) from inside Claude Code: delegate tasks to a second model, resume agy conversations, and get independent code reviews.

## Requirements

- Antigravity CLI (`agy`) installed and authenticated (tested against agy 1.1.20)
- Claude Code with plugin support

## Commands

- `/agy:delegate [flags] <task>`: hand a task to agy through the `agy-rescue` subagent.
  - `--background` / `--wait`: Claude-side execution mode (default foreground)
  - `--resume` / `--fresh`: continue the last agy conversation, or start a new one
  - `--model <name>`, `--effort <low|medium|high>`: passed through to agy
- `/agy:review [staged|branch|<base-ref>] [focus]`: read-only agy review of the current git diff.
- `/agy:setup`: check that agy is installed and authenticated.

## Design

Thin by design: no broker process, no job files. Every delegation is one `agy -p … --output-format json` call. Write-capable runs use `--mode accept-edits`; reviews run read-only. Foreground runs are capped near 9 minutes by the Bash tool ceiling; split longer work or use `--background`.

## Layout

```
.claude-plugin/plugin.json   manifest (plugin name: agy)
agents/agy-rescue.md         forwarding subagent
commands/                    delegate, review, setup
skills/agy-cli-runtime/      CLI call contract
skills/agy-result-handling/  output presentation rules
```

## Install

```bash
claude plugin marketplace add Eakkapoom-Name/antigravity-plugin-cc
claude plugin install agy@antigravity-plugin-cc
```

Restart Claude Code, then run `/agy:setup`.
