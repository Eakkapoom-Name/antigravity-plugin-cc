# Antigravity plugin for Claude Code

Use Google's Antigravity CLI (`agy`) from inside Claude Code: delegate tasks to a second model, resume agy conversations, and get independent code reviews.

This plugin is for Claude Code users who want an easy way to start using Antigravity from the workflow they already have.

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

- **Google account for Antigravity sign-in.**
  - Delegations contribute to your Antigravity usage limits. Check them anytime with `/agy:quota`.
- **Node.js 18 or later**

## Install

Install the plugin with one command:

```bash
npx agy-plugin-cc
```

Or do the same steps manually inside Claude Code. Add the marketplace:

```bash
/plugin marketplace add Eakkapoom-Name/antigravity-plugin-cc
```

Install the plugin:

```bash
/plugin install agy@antigravity-plugin-cc
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/agy:setup
```

`/agy:setup` will tell you whether agy is ready. If the Antigravity CLI is missing, install it with the official installer (macOS and Linux):

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

On Windows (PowerShell):

```powershell
irm https://antigravity.google/cli/install.ps1 | iex
```

If agy is installed but not signed in yet, run it once interactively:

```bash
!agy
```

After install, you should see:

- the slash commands listed below
- the `agy:agy-rescue` subagent in `/agents`

One simple first run is:

```bash
/agy:adversarial-review --background
/agy:status
/agy:result
```

## Usage

### `/agy:review`

Runs a read-only agy review of your current git diff.

Use it when you want:

- a review of your current uncommitted changes
- a review of your staged changes only
- a review of your branch compared to a base ref like `main`

Findings come back ordered by severity, one per line. You can add focus text after the target.

Examples:

```bash
/agy:review
/agy:review staged
/agy:review main
/agy:review branch pay extra attention to error handling
```

This command is read-only and will not perform any changes.

### `/agy:adversarial-review`

Runs a **steerable** challenge review that questions the chosen implementation and design, with a structured verdict and findings (see `schemas/review-output.schema.json`).

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, and hidden assumptions
- pressure-testing around specific risk areas like auth, data loss, or race conditions

It supports `--wait` and `--background`, and takes extra focus text after the flags.

Examples:

```bash
/agy:adversarial-review
/agy:adversarial-review --background question whether this caching design is safe
```

This command is read-only. It does not fix code.

### `/agy:rescue`

Hands a task to agy through the `agy:agy-rescue` subagent.

Use it when you want agy to:

- investigate a bug
- try a fix
- continue a previous agy task
- take an independent second pass on a problem

It supports `--background`, `--wait`, `--resume`, and `--fresh`, plus `--model <name>` and `--effort <low|medium|high>` passed through to agy.

Examples:

```bash
/agy:rescue investigate why the tests started failing
/agy:rescue fix the failing test with the smallest safe patch
/agy:rescue --resume apply the top fix from the last run
/agy:rescue --background investigate the regression
/agy:rescue --effort high dig into the race condition in the job queue
```

**Notes:**

- if you do not pass `--model` or `--effort`, agy chooses its own defaults
- write-capable runs use `--mode accept-edits` on the agy side; review and diagnosis runs stay read-only
- follow-up rescue requests can continue the latest agy conversation

### `/agy:continue`

Sends a follow-up into an existing agy conversation instead of starting a new one. With no id, continues the most recent conversation from this session. Same `--background`/`--wait`, `--model`, `--effort` flags as `/agy:rescue`.

Examples:

```bash
/agy:continue now apply the fix you proposed
/agy:continue 4f3062ab-b0d9-4874-b319-e42e9701e643 summarize what you changed
```

### `/agy:quota`

Shows remaining Antigravity model quota per bucket (Gemini and third-party groups, 5-hour and weekly windows) with reset times. Instant and quota-free.

Examples:

```bash
/agy:quota
```

### `/agy:transfer`

Seeds a fresh agy conversation with a handoff brief of the current session (goal, state, decisions, open items) and returns the `conversation_id` with both resume paths.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in Antigravity.

Examples:

```bash
/agy:transfer
/agy:transfer --model <model> include the open questions from this session
```

Afterwards, continue in a terminal with `agy --conversation <id>`, or from Claude Code with `/agy:rescue --resume`.

### `/agy:status`

Shows active and recent background agy delegations in this session.

Examples:

```bash
/agy:status
/agy:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/agy:result`

Shows the stored final output of a finished background delegation, including the `conversation_id` so you can reopen that run with `/agy:continue` or `agy --conversation <id>`.

Examples:

```bash
/agy:result
/agy:result task-abc123
```

### `/agy:cancel`

Stops a running background delegation (the agy conversation stays resumable).

Examples:

```bash
/agy:cancel
/agy:cancel task-abc123
```

### `/agy:setup`

Checks agy readiness through a companion script (`scripts/agy-setup.mjs`) that runs every check itself (agy on PATH, auth probe, tool-exercising probe for headless permission denial, stop-review gate state) and prints a single JSON report with `ready`, per-check sections, and `nextSteps`.

You can also use `/agy:setup` to manage the optional stop-review gate.

#### Enabling the stop-review gate

```bash
/agy:setup gate on
/agy:setup gate off
/agy:setup gate status
```

When the gate is enabled, the plugin uses a `Stop` hook to run a read-only agy review of the previous Claude turn before the session is allowed to end. If that review finds issues in code changes from that turn, the stop is blocked so Claude can address them first.

> [!WARNING]
> The gate adds an agy review round-trip to ending a turn and spends Antigravity quota. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/agy:review
```

### Hand A Problem To agy

```bash
/agy:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/agy:adversarial-review --background
/agy:rescue --background investigate the flaky test
```

Then check in with:

```bash
/agy:status
/agy:result
```

### Move The Work Over To Antigravity

```bash
/agy:transfer
```

Then continue in a terminal with:

```bash
agy --conversation <id>
```

## How to Delegate

There are two ways to hand work to agy.

### Via command

Use `/agy:rescue` for a new task, or `/agy:continue` to follow up in an existing conversation:

```bash
/agy:rescue investigate why the login endpoint returns 500 under load
/agy:rescue --background refactor the retry logic to use exponential backoff
/agy:continue now add tests for the fix
```

### Via prompt

You can also just ask in plain language. The `agy:agy-rescue` subagent triggers proactively when a task should go to a second model:

```text
Ask agy to redesign the database connection handling to be more resilient.
```

```text
Hand this bug off to Antigravity and report back what it finds.
```

```text
Get a second opinion from agy on this migration plan.
```

Either way, the result comes back with a `conversation_id`, so the thread stays resumable from Claude Code (`/agy:continue`) or a terminal (`agy --conversation <id>`).

## Stop-Review Gate

Off by default. When enabled, a Stop hook runs a read-only `agy -p` review of the previous Claude turn before the session is allowed to end. The reviewer answers `ALLOW:` or `BLOCK:` on its first line; a block keeps the session open with the reviewer's reason. Turns without code changes are allowed through immediately.

- Toggle per project with `/agy:setup gate on` / `gate off`; state lives in `.claude/agy.local.md` (`stop_review_gate: true`).
- If agy is missing, the gate skips with a note instead of blocking.
- Review failures and timeouts block with guidance to run `/agy:review` manually or turn the gate off.

## Design

Thin by design: no broker process, no job files. Every delegation is one `agy -p … --output-format json` call. Write-capable runs use `--mode accept-edits`; reviews run read-only. Foreground runs are capped near 9 minutes by the Bash tool ceiling; split longer work or use `--background`.

Job control stays thin too: `/agy:status`, `/agy:result`, and `/agy:cancel` read Claude Code's own background task tracking instead of a job store, so they cover the current session only. Cross-session continuity lives agy-side via `conversation_id` and `/agy:rescue --resume`.

## Layout

```
.
├── .claude-plugin/
│   ├── marketplace.json               marketplace catalog
│   └── plugin.json                    manifest (plugin name: agy)
├── agents/
│   └── agy-rescue.md                  forwarding subagent
├── commands/
│   ├── adversarial-review.md
│   ├── cancel.md
│   ├── continue.md
│   ├── quota.md
│   ├── rescue.md
│   ├── result.md
│   ├── review.md
│   ├── setup.md
│   ├── status.md
│   └── transfer.md
├── hooks/
│   └── hooks.json                     Stop hook wiring for the stop-review gate
├── schemas/
│   └── review-output.schema.json      adversarial review output shape
├── scripts/
│   ├── agy-setup.mjs                  /agy:setup readiness report
│   ├── npx-install.mjs                npx agy-plugin-cc installer
│   └── stop-review-gate-hook.mjs      stop-review gate (dependency-free node)
├── skills/
│   ├── agy-cli-runtime/               CLI call contract
│   └── agy-result-handling/           output presentation rules
├── CHANGELOG.md
├── LICENSE
├── README.md
└── package.json                       npm package (agy-plugin-cc) for the npx installer
```

## FAQ

### Do I need a separate Antigravity account for this plugin?

If you are already signed into agy on this machine, that account works immediately here too. This plugin uses your local Antigravity CLI authentication.

If you have not used Antigravity yet, [install the CLI](#install) and run `!agy` once to sign in with your Google account, then run [`/agy:setup`](#agysetup) to confirm everything is ready.

### Does the plugin use a separate Antigravity runtime?

No. Every delegation is a call to the same local `agy` binary you would use directly, with the same authentication state, the same repository checkout, and the same machine-local environment.

### Will it use the same agy settings I already have?

Yes. The plugin picks up your existing configuration in `~/.gemini/antigravity-cli/settings.json`, including `permissions.allow` rules. Headless runs auto-deny tools not covered by those rules; [`/agy:setup`](#agysetup) detects this and shows the fix.

### Does it spend my Antigravity quota?

Yes. Delegations, reviews, and stop-review gate runs all contribute to your Antigravity usage limits. [`/agy:quota`](#agyquota) shows what is left per bucket and is itself quota-free.

### What does `npx agy-plugin-cc` actually do?

It runs `claude plugin marketplace add Eakkapoom-Name/antigravity-plugin-cc` and `claude plugin install agy@antigravity-plugin-cc` through your local `claude` CLI, then points you at [`/agy:setup`](#agysetup). It is safe to rerun. See [Install](#install) for the manual steps.
