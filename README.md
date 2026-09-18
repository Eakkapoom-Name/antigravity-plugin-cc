# Antigravity plugin for Claude Code

Use Google's Antigravity CLI (`agy`) from inside Claude Code: delegate tasks to a second model, resume agy conversations, and get independent code reviews.

This plugin is for Claude Code users who want an easy way to start using Antigravity from the workflow they already have.

> [!NOTE]
> This is an open-source, third-party community project. It is not affiliated with, endorsed by, or sponsored by Anthropic or Google.

## What You Get

- `/agy:setup` for installation and authentication checks, and the stop-review gate toggle
- `/agy:review` for standard read-only code review
- `/agy:adversarial-review` for challenge-based review
- `/agy:rescue`, `/agy:status`, `/agy:result`, and `/agy:cancel` for task delegation and job management
- `/agy:continue` to follow up in an existing agy conversation
- `/agy:whisper` for a one-shot question to agy with no repository context
- `/agy:search` for a web search or a single page fetch through agy, second in the web tool order after Claude Code's own tools
- `/agy:research` for a web-grounded investigation with a fixed report shape and sources, optionally written to a file
- `/agy:image` to generate an image with agy and copy it into the project on request
- `/agy:transfer` to hand the current session over to a resumable agy conversation
- `/agy:quota` to check remaining Antigravity model quota
- An optional stop-review gate: a Stop hook that has agy review the previous turn before the session can end

## Requirements

- **Google account for Antigravity sign-in.**
  - Delegations contribute to your Antigravity usage limits. Check them anytime with `/agy:quota`.
- **Node.js 18 or later**
- **git**, for the review commands. The companion script collects the diff itself, so a missing git is reported as `git is not installed or not on PATH` rather than an empty review.

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

The plugin's own test suite runs on Windows as well as Linux in CI, including a check that it can actually execute the `.cmd` shims npm installs there.

If agy is installed but not signed in yet, run it once interactively:

```bash
! agy
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

### `/agy:setup`

Checks agy readiness through a companion script (`scripts/agy-setup.mjs`) that runs every check itself (agy on PATH, auth probe, a command probe and a file-read probe for headless permission denial, stop-review gate state) and prints a single JSON report with `ready`, per-check sections, and `nextSteps`.

Headless agy auto-denies any tool its `permissions.allow` rules do not cover, and it reports the refusal as `denied_actions` on an otherwise successful-looking result. The two probes exercise a terminal command and a file read, because the two need different rules (`command(...)` and `read_file(*)`) and `--mode accept-edits` covers neither. The report names each denied tool and the rule for it. That settings edit is yours to make by hand, in your own terminal: in a Claude Code auto mode session the classifier blocks the agent from editing the file, from passing `--dangerously-skip-permissions`, and even from querying `agy -p "/permissions"`.

When a probe fails, the report says which of three things went wrong rather than assuming a login problem: a real authentication failure, a restricted environment where the invoking shell blocked a syscall agy needs, or an unknown cause. Only the first is fixed by signing in again.

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
- some models reject `--effort` outright (agy 1.2.4 refuses it for `claude-opus-4-6-thinking` before running anything); the rescue agent then reruns once without the flag and says so
- write-capable runs use `--mode accept-edits` on the agy side; review and diagnosis runs stay read-only
- follow-up rescue requests can continue the latest agy conversation

### `/agy:continue`

Sends a follow-up into an existing agy conversation instead of starting a new one. With no id, continues the most recent conversation from this session. Same `--background`/`--wait`, `--model`, `--effort` flags as `/agy:rescue`.

Examples:

```bash
/agy:continue now apply the fix you proposed
/agy:continue 4f3062ab-b0d9-4874-b319-e42e9701e643 summarize what you changed
```

### `/agy:whisper`

```text
/agy:whisper what does SIGPIPE mean for a Node child process
/agy:whisper --model gemini-3.5-pro --effort high explain CRDT merge semantics
```

One-shot: no repository, no `--add-dir`, no follow-up. The answer comes back
with a `conversation_id`, so `/agy:continue <id> <follow-up>` picks it up. agy
runs from an isolated temp directory, so it does not see your project. That is
a working-directory change rather than a sandbox: agy's own
`allowNonWorkspaceAccess` setting, with an absolute path in the prompt text,
still reaches outside it. Nothing in this command's text is checked for a URL;
the local-network guard belongs to `/agy:search` alone.

### `/agy:search`

```text
/agy:search what changed in the Node 24 permission model
/agy:search https://nodejs.org/en/blog/release/v24.0.0
```

A bare question runs a web search and answers with a `Sources:` list. A single
`http://` or `https://` URL fetches that page as markdown. Local, private,
link-local, and other reserved-network targets, non-http schemes, and URLs
carrying credentials are refused before agy runs. A URL-shaped word inside an
ordinary search query is checked the same way, so a blocked address does not
get through by arriving with other words around it. That check is made once, on
the URL given; it does not follow redirects and cannot see a DNS answer that
changes afterward (rebinding), since agy performs the actual fetch in its own
process. It also covers this command only: `/agy:whisper`, `/agy:research` and
`/agy:image` send their text to the same web-capable agy unchecked. The
`agy-web` skill tells Claude Code to reach for this second, after
its own WebSearch and WebFetch and before Tavily.

### `/agy:research`

```text
/agy:research --effort high --out docs/notes/wasm-gc.md state of WebAssembly GC support
/agy:research tradeoffs between SQLite WAL and rollback journal for a desktop app
```

Fixed report shape: Summary, Key findings (each with its source), Disagreements
and thin evidence, Caveats, Sources. `--effort` sets the depth. `--out <path>`
writes the same markdown inside the workspace; the parent directory must exist
and an existing file is never overwritten. agy runs isolated; the companion does
the write.

### `/agy:image`

```text
/agy:image --out assets/hero.png isometric illustration of a developer at a desk
/agy:image a minimalist dark-mode login mockup, blue accent colour
```

agy writes the file under its own artifacts directory
(`~/.gemini/antigravity-cli/brain/<conversation-id>/<generated-name>`). Without
`--out` the command reports that path and copies nothing. With `--out <path>`
the companion checks the file agy named really resolves, after symlinks, to
somewhere inside that directory, then copies it inside the workspace; the
parent directory must exist and an existing file is never overwritten. The
copy is a byte-for-byte copy, not a re-encode, so a `--out` name whose
extension differs from the file agy actually produced is copied as-is under
the name given. That happens: a run that asked for a PNG came back as a
1024x1024 JPEG, under a name agy chose itself. agy never sees `--out`; the
companion resolves it and does the copy.

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

Shows active and recent background agy work in this session. Two kinds appear, and both are listed: `agy:agy-rescue` subagent delegations from `/agy:rescue --background`, and backgrounded companion runs from `/agy:adversarial-review --background`, which are Claude Code background tasks rather than subagents.

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

Shows the stored final output of a finished background run, subagent delegation or companion review alike, including the `conversation_id` so you can reopen that run with `/agy:continue` or `agy --conversation <id>`.

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

### `/agy:quota`

Shows remaining Antigravity model quota per bucket (Gemini and third-party groups, 5-hour and weekly windows) with reset times. Instant and quota-free.

Examples:

```bash
/agy:quota
```

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

- Toggle per workspace with `/agy:setup gate on` / `gate off`. The flag is stored outside the repository, under `CLAUDE_PLUGIN_DATA` and keyed by a hash of the workspace root, so there is nothing in your project to commit by mistake. A gate enabled under the older in-repository `.claude/agy.local.md` is still honoured until you set it through the command.
- If agy is missing, the gate skips with a note instead of blocking.
- Review failures and timeouts block with guidance to run `/agy:review` manually or turn the gate off.

## FAQ

### Do I need a separate Antigravity account for this plugin?

If you are already signed into agy on this machine, that account works immediately here too. This plugin uses your local Antigravity CLI authentication.

If you have not used Antigravity yet, [install the CLI](#install) and run `! agy` once to sign in with your Google account, then run [`/agy:setup`](#agysetup) to confirm everything is ready. Interactive agy needs a TTY, so the `! agy` form only works where the host gives the command a real terminal; otherwise sign in from a terminal of your own.

### Does the plugin use a separate Antigravity runtime?

No. Every delegation is a call to the same local `agy` binary you would use directly, with the same authentication state, the same repository checkout, and the same machine-local environment.

### Will it use the same agy settings I already have?

Yes, and one of those settings decides whether delegation works at all.

agy's `toolPermission` setting decides whether headless delegation can work at
all, and it is set in `~/.gemini/antigravity-cli/settings.json` or through agy's
own `/config` screen. Measured on agy 1.2.4 with no allow-rules, and the same
live harness (`npm run test:denials`) passed on agy 1.2.5 on 2026-09-18:

| mode | headless behaviour |
|---|---|
| `always-proceed` | every tool approved, no sandbox, including reads and writes outside the workspace |
| `request-review` | agy's default. Commands are refused because there is nobody to ask. A read of a file inside the workspace was allowed with no rule, though GitHub issue #21 reported one refused, so do not count on it. File writes are not refused |
| `proceed-in-sandbox` | approves commands only when agy is started with `--sandbox`, which this plugin does not pass, so commands stay refused |
| `strict` | refuses even a read of a file inside the workspace, and is the only mode that did |

Anything else, including a typo, is accepted and silently read back as
`request-review`, so a mode that never takes effect looks the same as one that
does.

When a delegation is refused anyway, the plugin resumes that conversation once,
stating the constraint, rather than throwing the turn away. The result carries a
`recovery` object naming what was denied on the first turn. The stop-review gate
does not resume: a review that lost its file reads has nothing to say.

On top of the mode, `permissions.allow` rules grant individual tools. Headless
runs auto-deny anything not covered, file reads (`read_file(*)`, which also
covers directory listing) as well as commands (`command(*)`). A narrower
`command(git *)` is the safer intent but is unverified: on agy 1.2.4 a
`command(pwd)` rule did not permit `pwd` while `command(*)` did, and agy never
prints the target string it tried to match.

[`/agy:setup`](#agysetup) reports your mode and the denied tools. You make any
change by hand, outside the agent session: an auto mode session cannot apply it
for you.

If you want delegation to simply work, `always-proceed` is the setting that does
it. Understand what you are granting first: every tool approved with no sandbox,
reaching outside the workspace, and agy's own changelog records fixing a bug
where outside-of-workspace writes were wrongly auto-approved in exactly that
mode.

### Does it spend my Antigravity quota?

Yes. Delegations, reviews, and stop-review gate runs all contribute to your Antigravity usage limits. [`/agy:quota`](#agyquota) shows what is left per bucket and is itself quota-free.

### What does `npx agy-plugin-cc` actually do?

It runs `claude plugin marketplace add Eakkapoom-Name/antigravity-plugin-cc` and `claude plugin install agy@antigravity-plugin-cc` through your local `claude` CLI, then points you at [`/agy:setup`](#agysetup). It is safe to rerun. See [Install](#install) for the manual steps.
