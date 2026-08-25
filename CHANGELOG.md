# Changelog

All notable changes to the `agy` plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.1] - 2026-08-26

### Added

- `CHANGELOG.md` backfilled to v1.0.0.
- Apache-2.0 `LICENSE` and `NOTICE`.

## [1.3.0] - 2026-08-26

### Added

- `/agy:transfer`: hand the current Claude Code session over to a resumable
  agy conversation via a handoff brief and a single read-only seeding call (#4).

### Changed

- README restructured along the codex-plugin-cc layout (#3).
- Review-output schema pretty-printed (#5).

## [1.2.0] - 2026-08-25

### Changed

- `/agy:delegate` renamed to `/agy:rescue` (#2).

## [1.1.0] - 2026-08-25

### Added

- Job control commands: `/agy:status`, `/agy:result`, `/agy:cancel` (#1).
- `/agy:adversarial-review`: agy review that challenges implementation
  approach and design choices (#1).

## [1.0.1] - 2026-08-25

### Fixed

- Return full agy JSON stdout so `conversation_id` survives delegation.

## [1.0.0] - 2026-08-25

### Added

- Initial release: thin wrapper around the Antigravity CLI (`agy`) with
  `/agy:delegate`, `/agy:review`, `/agy:setup`, the `agy-rescue` subagent,
  and the `agy-cli-runtime` / `agy-result-handling` internal skills.

[1.3.1]: https://github.com/Eakkapoom-Name/antigravity-plugin-cc/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/Eakkapoom-Name/antigravity-plugin-cc/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Eakkapoom-Name/antigravity-plugin-cc/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Eakkapoom-Name/antigravity-plugin-cc/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/Eakkapoom-Name/antigravity-plugin-cc/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Eakkapoom-Name/antigravity-plugin-cc/releases/tag/v1.0.0
