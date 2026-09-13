# Changelog

All notable changes to the `agy` plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- `/agy:transfer`, `/agy:review`, and `/agy:adversarial-review` now grant the
  tools their own steps need. Each one writes a brief or a diff to a temp file,
  feeds it to agy, and deletes it afterwards, but none of them granted `Write`
  or any form of `rm`; `/agy:transfer` granted only `Bash(agy:*)`. They now also
  grant `Bash(cat:*)`, since the file reaches agy through a `$(cat <file>)`
  substitution inside the agy command line. The suite asserts these grants for
  every command whose body has a temp file step, a check that was held back
  until the grants existed.

- A write-capable run that answers with a plan ending in a question, such as
  `Proceed with implementation?`, is no longer presented as a finished task. It
  touched no files, so the result now says so and hands over the
  `/agy:continue <conversation_id> Yes, proceed.` follow-up. Pre-approving the
  plan inside the original task text is called out as the wrong fix, since that
  phrasing is what trips the classifier above.

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
