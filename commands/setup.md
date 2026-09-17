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

Run it with an explicit Bash `timeout` of `590000` ms. The script fires three agy probes back to back, each with its own 3 minute spawn timeout, so a slow-but-working setup can take about 9 minutes. The default 120000 ms Bash timeout would kill the script before it prints its report, which looks identical to a broken install.

The script runs every check itself (agy on PATH, an auth probe, a command probe and a file-read probe that detect headless permission auto-denial, and the stop-review gate state) and prints one JSON report:

- `ready`: true only when `agy`, `auth`, and `toolPermissions` are all available.
- `agy` / `auth` / `toolPermissions`: each has `available` and a `detail` line; probe sections also carry `durationSeconds`. On failure, `detail` quotes the decisive stderr line when there is one.
- `toolPermissions.command` and `toolPermissions.read`: the two tool probes, each with `available`, `detail`, `deniedActions`, and `durationSeconds`. The read probe plants a file in the workspace root and asks agy to read it back, which is what every rescue does first; the file is removed before the report prints.
- `toolPermissions.deniedActions`: the tool names agy refused, as it reports them in `denied_actions` (`command`, `read_file`). Empty on older agy versions that do not report denials in the JSON, in which case the probes fall back to judging the response text.
- `agySettings`: agy's own permission settings, read from
  `~/.gemini/antigravity-cli/settings.json`. Carries `toolPermission` (the
  effective mode), `declaredToolPermission` (what the file literally says, or
  `null`), `allowNonWorkspaceAccess`, `sandboxMode`, the `path`, and `readable`.
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
- Always report `agySettings.toolPermission`, on success as well as failure. It is the setting that decides everything else, and until now the report was silent about it. If `declaredToolPermission` is set but differs from `toolPermission`, say so plainly: agy accepted an unrecognised value and fell back to `request-review` silently, without an error anywhere, so the user's intended mode never took effect. Known modes are `always-proceed`, `request-review` (the default), `proceed-in-sandbox`, and `strict`.
- If the mode is `proceed-in-sandbox`, warn that it does not work with this plugin whatever the probes say: it approves commands only when agy is started with `--sandbox`, and the plugin does not pass that flag. Point the user at `request-review` with allow-rules, or `always-proceed`.
- If `toolPermissions.available` is false, report that delegation will not work headlessly until agy's permission settings allow the tools it needs, name each entry in `toolPermissions.deniedActions`, quote `toolPermissions.detail`, and relay the `nextSteps` permission guidance in full. Show every JSON form it carries as a copyable block: `command(*)` or a narrow `command(<target>)` when `command` was denied, `read_file(*)` when `read_file` was denied. Keep the warning that `command(*)` grants every terminal command, and keep the note that the narrow form is unverified on this agy version so the exact target belongs to agy's own denial line. `--mode accept-edits` covers writes only, so a denied read is not fixed by it. This is a permission problem, not an auth problem: never tell the user to sign in again here.
- The settings edit is the user's own step, made by hand in their terminal, outside this session. Do not attempt to edit `~/.gemini/antigravity-cli/settings.json`, do not offer `--dangerously-skip-permissions`, and do not run `agy -p "/permissions"` to look up the grammar: in an auto mode session the Claude Code classifier denied all three as `[Create Unsafe Agents]` (GitHub issue #21). Say what to add, then stop and wait for the user to rerun `/agy:setup`.
- Report any other failure verbatim.
