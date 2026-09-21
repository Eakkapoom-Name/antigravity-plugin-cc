# AGENTS.md

Guidance for AI coding agents working in this repository. Local, not committed.

## Tracking open work

Outstanding work for this repository lives in
`.claude/skills/agy-open-work/OPEN-WORK.md`. Two skills own it:
`agy-open-work` reads and reports, `agy-log-finding` writes.

Invoke `agy-log-finding` when any of these happens, in the same turn it happens,
without waiting to be asked:

- A bug, defect, gap, or rough edge surfaces and is not being fixed right now.
- A fix is deferred, descoped, or explicitly left for later.
- A review, audit, or test run turns up something worth acting on later.
- A workaround is applied and the real fix is still owed.
- A tracked item is fixed, so it moves to Awaiting verification.
- A verification passes, so the item can be closed.

Invoke `agy-open-work` when asked what is left, what is open or pending, what
the backlog holds, or what to work on next.

A fix never moves straight to Closed. It goes to Awaiting verification with a
runnable `Verify by:` line, and only closes once that step has actually been run
and passed.

Do not record transient steps of the current task. Something belongs in
`OPEN-WORK.md` only if it would still be worth doing in a fresh session
tomorrow.

These skills are Claude Code plugin skills. An agent without skill support
should read and update `OPEN-WORK.md` directly using the same rules.

## Repository conventions

- Conventional Commits (`feat`, `fix`, `docs`, `test`), no PR number on a direct
  push to main.
- A release is its own commit (`docs: release X.Y.Z`) bumping
  `.claude-plugin/plugin.json`, `package.json`, and `CHANGELOG.md` together;
  `tests/manifest.test.mjs` asserts the three agree.
- Tag `vX.Y.Z`; the GitHub release title is the tag and its body is that
  version's CHANGELOG section.
- `npm test` runs `node --test tests/*.test.mjs` and must pass before a push.
