# Changelog

All notable changes to the `agy` plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
