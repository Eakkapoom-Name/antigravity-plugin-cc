# Antigravity plugin for Claude Code

Use Google's Antigravity CLI (`agy`) from inside Claude Code: delegate tasks to a second model, resume agy conversations, and get independent code reviews.

## What You Get

- `/agy:review` for standard read-only code review
- `/agy:adversarial-review` for challenge-based review
- `/agy:rescue`, `/agy:status`, `/agy:result`, and `/agy:cancel` for task delegation and job management
- `/agy:continue` to follow up in an existing agy conversation
- `/agy:quota` to check remaining Antigravity model quota
- `/agy:transfer` to hand the current session over to a resumable agy conversation
- `/agy:setup` for installation and authentication checks, and the stop-review gate toggle
- An optional stop-review gate: a Stop hook that has agy review the previous turn before the session can end

## Requirements

- Antigravity CLI (`agy`) installed and authenticated (tested against agy 1.1.20)
- Claude Code with plugin support

## Install

```bash
claude plugin marketplace add Eakkapoom-Name/antigravity-plugin-cc
claude plugin install agy@antigravity-plugin-cc
```

Restart Claude Code, then run `/agy:setup`.

## Usage

### `/agy:rescue [flags] <task>`

Hands a task to agy through the `agy-rescue` subagent.

- `--background` / `--wait`: Claude-side execution mode (default foreground)
- `--resume` / `--fresh`: continue the last agy conversation, or start a new one
- `--model <name>`, `--effort <low|medium|high>`: passed through to agy

### `/agy:continue [conversation-id] [flags] <follow-up>`

Sends a follow-up into an existing agy conversation instead of starting a new one. With no id, continues the most recent conversation from this session. Same `--background`/`--wait`, `--model`, `--effort` flags as `/agy:rescue`.

### `/agy:quota`

Shows remaining Antigravity model quota per bucket (Gemini and third-party groups, 5-hour and weekly windows) with reset times. Instant and quota-free (`agy -p "/usage"` print-mode command).

### `/agy:review [staged|branch|<base-ref>] [focus]`

Read-only agy review of the current git diff.

### `/agy:adversarial-review [--wait|--background] [scope] [focus]`

Challenge review that questions the approach, design choices, and assumptions; structured verdict and findings (see `schemas/review-output.schema.json`).

### `/agy:status [id]`

Shows active and recent background agy delegations in this session.

### `/agy:result [id]`

Shows the stored final output of a finished background delegation.

### `/agy:cancel [id]`

Stops a running background delegation (the agy conversation stays resumable).

### `/agy:transfer [--model <model>] [extra context]`

Seeds a fresh agy conversation with a handoff brief of the current session (goal, state, decisions, open items). Returns the `conversation_id` and both resume paths: `agy --conversation <id>` in a terminal, or `/agy:rescue --resume` from Claude Code.

### `/agy:setup [gate on|off|status]`

Checks that agy is installed and authenticated. With a `gate` argument, toggles the stop-review gate for the current project.

## Stop-Review Gate

Off by default. When enabled, a Stop hook runs a read-only `agy -p` review of the previous Claude turn before the session is allowed to end. The reviewer answers `ALLOW:` or `BLOCK:` on its first line; a block keeps the session open with the reviewer's reason. Turns without code changes are allowed through immediately.

- Toggle per project with `/agy:setup gate on` / `gate off`; state lives in `.claude/agy.local.md` (`stop_review_gate: true`).
- If agy is missing, the gate skips with a note instead of blocking.
- Review failures and timeouts block with guidance to run `/agy:review` manually or turn the gate off.

## Typical Flows

**Review before shipping:** `/agy:review`

**Hand a problem to agy:** `/agy:rescue investigate why the build is failing in CI`

**Long-running tasks:** use `--background`, then check with `/agy:status` and `/agy:result`

**Move to agy entirely:** `/agy:transfer`, then continue in a terminal with `agy --conversation <id>`

## Design

Thin by design: no broker process, no job files. Every delegation is one `agy -p … --output-format json` call. Write-capable runs use `--mode accept-edits`; reviews run read-only. Foreground runs are capped near 9 minutes by the Bash tool ceiling; split longer work or use `--background`.

Job control stays thin too: `/agy:status`, `/agy:result`, and `/agy:cancel` read Claude Code's own background task tracking instead of a job store, so they cover the current session only. Cross-session continuity lives agy-side via `conversation_id` and `/agy:rescue --resume`.

## Layout

```
.claude-plugin/plugin.json   manifest (plugin name: agy)
agents/agy-rescue.md         forwarding subagent
commands/                    rescue, review, adversarial-review, status, result, cancel, transfer, setup
hooks/hooks.json             Stop hook wiring for the stop-review gate
scripts/                     stop-review-gate-hook.mjs (dependency-free node)
schemas/                     adversarial review output shape
skills/agy-cli-runtime/      CLI call contract
skills/agy-result-handling/  output presentation rules
```
