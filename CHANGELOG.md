# Changelog

All notable changes to the `agy` plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- A headless agy run refused the one tool it needed now counts as a failure.
  agy 1.2.4 reports the refusal as `denied_actions` on the result while keeping
  `status: "SUCCESS"`, exit code 0, and sometimes a non-empty `response`, so the
  plugin's empty-response rule never fired and a run that read nothing looked
  complete (GitHub issue #21). `scripts/lib/agy.mjs` treats a non-empty
  `denied_actions` as `failure: "denied"`, the companion passes the denied tool
  names through, and the rescue agent, the rescue command, and the result
  handling skill name each denied action and the rule for it.
- `/agy:setup` exercises a file read as well as a terminal command, because the
  two need different rules and every earlier version of the guidance named
  `command(...)` only. The read probe plants a file in the workspace root and
  asks agy to read it back, which is what every rescue does first. The report
  carries `toolPermissions.command`, `toolPermissions.read`, and the union
  `toolPermissions.deniedActions`; `nextSteps` names `read_file(*)` next to the
  command rules and only for what was actually denied. The command's Bash
  timeout rose to 590000 ms for the third probe.
- The permission fix is stated as the user's own manual step, made by hand
  outside the agent session. In a Claude Code auto mode session the classifier
  denied the settings edit, `--dangerously-skip-permissions`, and even a
  read-only `agy -p "/permissions"`, all as `[Create Unsafe Agents]`, so guidance
  that read as something the agent could carry out produced three more denials.
  The operator-runs-commands fallback from the same issue is documented as a
  fallback.
- `--effort` is dropped and the run repeated once when the chosen model rejects
  the flag (`--effort is not supported for model`, exit 1, before any model
  call). The rescue agent does this in its one permitted retry; the companion
  does it for `/agy:transfer` and reports `effortDropped: true`.

- The stop-review gate names the missing permission rule when agy auto-denies
  its tool call. The hook now runs agy through the shared `runPrompt`, so a
  headless denial arrives as `failure: "denied"` with the tool names, and the
  block reason says which rule to add by hand instead of "returned no output"
  or "returned an unexpected answer". The decision logic moved to
  `scripts/lib/stop-review.mjs` so it is tested against captured payloads, and
  importing the hook no longer reads stdin.

### Added

- `scripts/prepack-check.mjs`, wired as the npm `prepack` script. `npm pack`
  force-includes anything matching `README*`, so a `README.md.bak` left by an
  editing session shipped in the tarball, and neither a `files` negation nor
  `.npmignore` kept it out. The guard refuses to pack while any `.bak` or
  `.bak<n>` file is in the tree and lists them.

### Changed

- `--mode plan` was run on agy 1.2.4 in print mode and is documented rather
  than exposed: it wrote a plan artifact, answered that it was ready to
  execute, and then edited the target file in the same turn, with and without
  `--add-dir`. It is not a no-edit mode headlessly, so read-only runs keep
  omitting `--mode`.
- The runtime contract is re-verified against agy 1.2.4: every documented flag,
  the stream-json result shape including `denied_actions`, and the print-mode
  `/usage` payload. It records the headless read permission scope observed
  (workspace reads pass without a rule, outside reads need `read_file(*)`), the
  `-i=` prompt attachment form, and that interactive mode needs a TTY.
- The 1.1.20 denial text in the result handling skill was reproduced on 1.2.4,
  so it no longer says it was not re-checked.

## [0.6.3] - 2026-09-14

### Added

- `scripts/agy-companion.mjs`, a companion script that owns the deterministic
  half of the plugin: diff collection, prompt construction, the agy call, and
  result normalizing, behind `review`, `adversarial-review`, `transfer`,
  `quota`, and `gate` subcommands. The commands that used to spell that work out
  as prose now call it, so the behaviour can be tested rather than only the
  wording. `/agy:status`, `/agy:result`, and `/agy:cancel` are deliberately
  unchanged: this plugin keeps no job store by design, and those three
  orchestrate Claude Code's own background tasks.
- `scripts/bump-version.mjs` with a `--check` mode, wired into CI as
  `npm run check-version`. A release is now one command that sets
  `package.json`, `.claude-plugin/plugin.json`, and the CHANGELOG heading
  together, instead of three hand edits that can drift.
- Prompts live in `prompts/` and are loaded through `scripts/lib/prompts.mjs`,
  which fails loudly when a placeholder is missing or unused rather than
  shipping a literal `{{REPO_ROOT}}` to the model.
- CI runs on `windows-latest` as well as `ubuntu-latest`. Windows support was a
  suspicion for as long as CI only ran Linux; this leg is what turns it into a
  result.
- `.claude-plugin/plugin.json` carries `homepage`, `repository`, `license`, and
  `keywords`.

### Fixed

- `/agy:setup` no longer reports a restricted execution environment as a login
  failure. A sandbox that refuses agy's local loopback listener makes the probe
  print `listen tcp 127.0.0.1:0: socket: operation not permitted`; that used to
  fall through as a generic auth failure and the command told the user to sign
  in again. The auth section now carries a `failureKind` of `environment`,
  `auth`, or `unknown`, and each one gets its own remedy. A failing report also
  never ships with an empty `nextSteps` any more.
- The headless permission guidance now shows both a broad and a narrow
  `permissions.allow` block, warns that `command(*)` grants every terminal
  command, and says the narrow form is unverified on this agy version so the
  exact target belongs to agy's own denial line.
- A `/agy:rescue` or `/agy:continue` launch refused by Claude Code's own auto
  mode classifier is now reported as a host permission block rather than an agy
  failure. The refusal lands one layer before agy runs, so there is no JSON and
  no `conversation_id`, and the old advice to run `/agy:setup` sent the user to
  a check that passes. The remedies are `/permissions`, which has worked every
  reported time, and rewording the task text, which is cheaper but has failed
  before.
- `/agy:transfer`, `/agy:review`, and `/agy:adversarial-review` no longer rely
  on tool access they never declared. Each used to write a brief or a diff to a
  temp file, read it back into an agy command line, and delete it, while
  granting none of `Write`, `cat`, or `rm`; `/agy:transfer` granted only
  `Bash(agy:*)`. The companion does that work now, so the two reviews write no
  files at all and `/agy:transfer` declares the `Write` it uses for the one file
  a script cannot produce.
- The npx installer no longer treats any output containing the word "already"
  as a successful no-op. A genuine failure whose message happened to include it,
  such as "this error was already reported upstream", was reported as a rerun.
  Detection now matches the shape of a no-op, checked against the two messages
  the `claude` CLI actually prints. The installer also reports a rerun honestly:
  both duplicate cases exit 0, so the exit status never said whether anything
  changed and it printed "Marketplace added." either way.
- `scripts/npx-install.mjs` only installs when invoked as a script, so importing
  it for tests no longer shells out to the `claude` CLI.
- Large diffs no longer fail opaquely. The whole diff used to be interpolated
  into the agy command line, which exceeds `ARG_MAX` (2097152 bytes on a typical
  Linux box) and dies with `Argument list too long`. Diffs now reach agy on
  stdin through `--input-format stream-json`, verified with a 7617893 byte diff
  that passes as 9 arguments. The terminal `result` event carries the same
  object `--output-format json` produces, so result handling is unchanged.
- `/agy:setup` and the stop-review gate can no longer disagree about whether the
  gate is on. Both now resolve the workspace root the same way and read the same
  stored state, instead of one reading `input.cwd` and the other
  `CLAUDE_PROJECT_DIR`, which differ when the session sits in a subdirectory.
- Commands resolve `agy`, `claude`, and `git` through `PATH` and `PATHEXT`
  rather than spawning a bare name, so the `.cmd` shims npm installs on Windows
  are found, and a resolved `.cmd` is handed to `cmd.exe` rather than exec'd
  directly, which Windows cannot do and Node refuses to attempt since the fix
  for CVE-2024-27980. The Unix-only `which` call is gone. Spawning still never
  uses a shell: these commands are handed prompt text and diffs, and a shell
  would turn that data into syntax.
- `/agy:status` and `/agy:result` report backgrounded companion reviews as well
  as `agy:agy-rescue` subagent delegations. A backgrounded
  `/agy:adversarial-review` is a Claude Code background task, not a subagent, so
  a status built only on `ListAgents` made it look like it never started.
- `/agy:transfer` accepts `--model` and `--effort` again. Both were documented
  in the README while the command had stopped parsing them.
- The npx installer ships `scripts/lib/process.mjs` alongside itself, which it
  now imports. Without it `npx agy-plugin-cc` would fail on a missing module.
- A write-capable run that answers with a plan ending in a question, such as
  `Proceed with implementation?`, is no longer presented as a finished task. It
  touched no files, so the result now says so and hands over the
  `/agy:continue <conversation_id> Yes, proceed.` follow-up. Pre-approving the
  plan inside the original task text is called out as the wrong fix, since that
  phrasing is what trips the classifier above.

### Changed

- The agy flag contract, the result JSON shape, and the print-mode slash command
  list are re-verified against agy 1.2.2, replacing claims that had stood since
  1.1.20. Every documented flag still exists and `--print-timeout` still
  defaults to 5m. The one claim that could not be re-probed, the headless
  permission denial text, keeps its 1.1.20 attribution and now says why.
- `README.md` writes `! agy` with a space, matching the rest of the
  documentation; `/agy:rescue` and `/agy:continue` drop a `Bash(agy:*)` grant
  neither of them uses, since both delegate only through the `Agent` tool.
- The stop-review gate flag moved out of the repository. It lives under
  `CLAUDE_PLUGIN_DATA`, keyed by a hash of the workspace root and namespaced to
  this plugin, with a temp-directory fallback when the variable is unset. A gate
  enabled under the old `.claude/agy.local.md` is still honoured until it is set
  through `/agy:setup gate`, so upgrading does not silently disable it.
- `/agy:review`, `/agy:adversarial-review`, `/agy:transfer`, and `/agy:quota`
  grant `Bash(node:*)` and call the companion, replacing the per-command `agy`,
  `git`, `cat`, and `rm` grants they carried before. `/agy:adversarial-review`
  passes `--json-schema`, so its review object is enforced by agy rather than
  requested in prose.
- The runtime contract documents `--input-format`, `--json-schema`,
  `--mode plan`, `--sandbox`, and `--disable-slash-commands`, along with the
  constraint that slash commands are unavailable under stream-json input, which
  is why `/agy:quota` keeps the argv form.
- `npm test` runs `node --test` with no shell glob, so the suite runs on Windows
  as well as Linux. CI runs three legs: Ubuntu on Node 22 and Node 18, and
  Windows on Node 22. The Node 18 leg exists so the `engines: ">=18"` claim is
  tested rather than asserted, and the Windows leg executes a real `.cmd` shim
  rather than only resolving one.
- README: `git` is listed as a requirement, since the companion collects diffs
  itself; `/agy:status` and `/agy:result` describe both kinds of background run;
  and `/agy:setup` explains that a failed probe names which of three causes it
  hit rather than assuming a login problem.

## [0.6.2] - 2026-08-30

### Added

- Test suite (`tests/`, run with `npm test`) covering command frontmatter
  contracts, plugin and marketplace manifest shape, hook wiring and timeouts,
  version and changelog sync, agent skill references, script syntax, and the
  setup tool-probe path detection.
- Pull request CI workflow running the suite on Node 22 with SHA-pinned
  actions, on pull requests and pushes to main.
- `.gitignore`, covering `.claude/agy.local.md`, the per-project gate settings
  file that is documented as not meant to be committed.

### Fixed

- `/agy:setup` runs the readiness script with an explicit 400000 ms Bash
  timeout. The two agy probes can take about 6.5 minutes, so the default
  120000 ms timeout killed the script before it printed its report, which was
  indistinguishable from a broken install.
- The tool-permission probe accepts a filesystem path that agy wraps in
  backticks, quotes, or brackets, and Windows drive-letter paths. Previously
  those shapes reported a working setup as broken.

### Changed

- `scripts/agy-setup.mjs` exports its path detection and only runs the probes
  when invoked as a script, so tests can import it without spawning agy.

## [0.6.1] - 2026-08-26

### Added

- README: note that the project is an open-source, third-party community
  project not affiliated with, endorsed by, or sponsored by Anthropic or
  Google.

### Changed

- README: the `agy --conversation <id>` resume command sits in its own
  copyable block, FAQ answers link to the Install, `/agy:setup`, and
  `/agy:quota` sections, and Layout is a full tree listing.

## [0.6.0] - 2026-08-26

### Added

- npm installer: `npx agy-plugin-cc` registers the marketplace and installs
  the plugin through the local `claude` CLI (`package.json` +
  `scripts/npx-install.mjs`; safe to rerun).
- README: FAQ and How to Delegate sections.

### Changed

- README restructured along the codex-plugin-cc layout: audience line,
  trimmed Requirements, line-by-line Install (npx one-liner, marketplace
  commands, official agy install commands), per-command Usage with copyable
  examples, and Typical Flows.

- `/agy:setup` readiness check now runs through a companion script
  (`scripts/agy-setup.mjs`), matching the codex-plugin setup contract: the
  script performs every check itself (agy on PATH, auth probe, tool-exercising
  probe, stop-review gate state) and prints a single JSON report with `ready`,
  per-check sections, `reviewGateEnabled`, and `nextSteps`; the command now
  just runs it and presents the result.

## [0.5.1] - 2026-08-26

### Fixed

- Headless permission denial went undetected (#12): the `/agy:setup` probe was
  tool-free, so it reported ready while every real delegation was auto-denied
  under a narrow agy `permissions.allow` list, returning an empty `response`
  (with `status` observed as both `SUCCESS` and `CANCELED`) and the failure
  visible only in a stderr line starting `jetski: no output produced`. Setup
  now runs a second, tool-exercising probe and explains the permission fix;
  result handling treats an empty `response` as a failure and surfaces the
  stderr line; the rescue agent forwards stderr when the response is empty.

## [0.5.0] - 2026-08-26

### Added

- `/agy:continue`: send a follow-up into an existing agy conversation (most recent by default, or a specific `conversation_id`), building on agy's native conversation resumability.
- `/agy:quota`: show remaining Antigravity model quota per bucket with reset times, via the quota-free print-mode `agy -p "/usage"` command.
- `agy-cli-runtime` skill: documented the print-mode slash-command contract (structured `command` payload, no quota spend, no conversation left behind).

## [0.4.2] - 2026-08-26

### Changed

- License from Apache-2.0 to MIT; removed the `NOTICE` file.

## [0.4.1] - 2026-08-26

### Fixed

- Stop-review gate: agy launched from a hook has no workspace (its shell sits
  in the agy scratch dir), so the reviewer saw an empty workspace and allowed
  everything. The hook now passes `--add-dir <project>` and states the
  repository root in the review prompt.

## [0.4.0] - 2026-08-26

### Added

- Stop-review gate: an optional Stop hook that has agy review the previous
  Claude turn (read-only, `ALLOW:`/`BLOCK:` contract) before the session can
  end. Off by default; toggled per project with `/agy:setup gate on|off|status`
  via `.claude/agy.local.md`.

## [0.3.1] - 2026-08-26

### Added

- `CHANGELOG.md` backfilled to v0.0.0.
- Apache-2.0 `LICENSE` and `NOTICE`.

## [0.3.0] - 2026-08-26

### Added

- `/agy:transfer`: hand the current Claude Code session over to a resumable
  agy conversation via a handoff brief and a single read-only seeding call (#4).

### Changed

- README restructured along the codex-plugin-cc layout (#3).
- Review-output schema pretty-printed (#5).

## [0.2.0] - 2026-08-25

### Changed

- `/agy:delegate` renamed to `/agy:rescue` (#2).

## [0.1.0] - 2026-08-25

### Added

- Job control commands: `/agy:status`, `/agy:result`, `/agy:cancel` (#1).
- `/agy:adversarial-review`: agy review that challenges implementation
  approach and design choices (#1).

## [0.0.1] - 2026-08-25

### Fixed

- Return full agy JSON stdout so `conversation_id` survives delegation.

## [0.0.0] - 2026-08-25

### Added

- Initial release: thin wrapper around the Antigravity CLI (`agy`) with
  `/agy:delegate`, `/agy:review`, `/agy:setup`, the `agy-rescue` subagent,
  and the `agy-cli-runtime` / `agy-result-handling` internal skills.

[0.4.1]: https://github.com/Eakkapoom-Name/antigravity-plugin-cc/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Eakkapoom-Name/antigravity-plugin-cc/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/Eakkapoom-Name/antigravity-plugin-cc/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Eakkapoom-Name/antigravity-plugin-cc/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Eakkapoom-Name/antigravity-plugin-cc/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Eakkapoom-Name/antigravity-plugin-cc/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/Eakkapoom-Name/antigravity-plugin-cc/compare/v0.0.0...v0.0.1
[0.0.0]: https://github.com/Eakkapoom-Name/antigravity-plugin-cc/releases/tag/v0.0.0
