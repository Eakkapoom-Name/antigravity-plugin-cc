---
description: Check whether the local Antigravity CLI (agy) is installed, authenticated, and ready, and toggle the stop-review gate
argument-hint: "[gate on|off|status]"
allowed-tools: Bash(node:*), Read, Write, Edit
---

If $ARGUMENTS starts with `gate`, manage the stop-review gate and skip the readiness check:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" gate "<on|off|status>"
```

- The gate is a Stop hook that hands the previous Claude turn to a read-only agy review before the session is allowed to end. It is off by default and per workspace.
- The flag is stored outside the repository, keyed by a hash of the workspace root, so it is no longer a file you can accidentally commit. The script reports the exact `stateFile` it wrote.
- A gate enabled under the old `.claude/agy.local.md` file is still honoured until you set it through this command; after that, the stored value wins.
- `gate off`: turn the gate off for this workspace.
- `gate on`: warn the user that ending a turn can now take up to the agy review round-trip, and that the review only blocks when the previous turn made code changes with unresolved issues.
- `gate status` (or bare `gate`): report `enabled` and the `workspace` it applies to.

Otherwise check agy readiness. Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-setup.mjs"
```

Run it with an explicit Bash `timeout` of `400000` ms. The script fires two agy probes back to back, each with its own 3 minute spawn timeout, so a slow-but-working setup can take about 6 minutes. The default 120000 ms Bash timeout would kill the script before it prints its report, which looks identical to a broken install.

The script runs every check itself (agy on PATH, an auth probe, a tool-exercising probe that detects headless permission auto-denial, and the stop-review gate state) and prints one JSON report:

- `ready`: true only when `agy`, `auth`, and `toolPermissions` are all available.
- `agy` / `auth` / `toolPermissions`: each has `available` and a `detail` line; probe sections also carry `durationSeconds`. On failure, `detail` quotes the decisive stderr line when there is one.
- `auth.failureKind`: why the auth probe failed, or `null` when it passed. One of `environment` (the invoking shell blocked a syscall agy needs, typically a sandbox refusing its loopback listener), `auth` (a real sign-in problem), or `unknown` (the stderr named no cause). Never guess a remedy from `detail` alone; branch on this field.
- `reviewGateEnabled`: current stop-review gate state, read from the same stored state the Stop hook reads, resolved from the same workspace root. The two can no longer disagree when the session sits in a subdirectory.
- `nextSteps`: the remediation or optional follow-up commands to relay.

Present the final report to the user:

- If `ready` is true, report the agy version, both probe round-trip times, that delegation via `/agy:rescue` is ready, and the gate state. Add one line for auto mode sessions: a ready agy can still have its `/agy:rescue` launch refused by Claude Code's own auto mode classifier, one layer before agy runs, and the remedy for that is `/permissions`, not this command.
- If `agy.available` is false, tell the user to install the Antigravity CLI; do not guess an install command, point them to the official Antigravity documentation.
- If `auth.available` is false, quote `auth.detail`, then branch on `auth.failureKind`. These are three different problems and only one of them is a login problem, so do not offer the sign-in fix for all three:
  - `environment`: say plainly that this is not a login failure and that the user's credentials are fine. The shell that ran the probe blocked a syscall agy needs, usually a sandbox refusing its local loopback listener (`listen tcp 127.0.0.1:0: socket: operation not permitted`). Relay the `nextSteps` guidance to rerun from an unrestricted terminal.
  - `auth`: relay the `nextSteps` guidance to run `agy` once interactively, suggest typing `! agy` in the prompt, then rerun `/agy:setup`.
  - `unknown`: say the probe failed without naming a cause and relay the `nextSteps` command that reproduces the full error.
- If `toolPermissions.available` is false, report that delegation will not work headlessly until agy's permission settings allow tools, quoting `toolPermissions.detail` and relaying the `nextSteps` permission guidance in full. Show both JSON forms it carries as copyable blocks, keep the warning that `command(*)` grants every terminal command, and keep the note that the narrow form is unverified on this agy version so the exact target belongs to agy's own denial line. This is a permission problem, not an auth problem: never tell the user to sign in again here.
- Report any other failure verbatim.
