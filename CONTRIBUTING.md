# Contributing

- `npm test` must pass before a push. It runs `node --test tests/*.test.mjs`
  and needs no network and no agy.
- `npm run test:denials` is the live permission harness: one agy run per case
  in `scripts/lib/denial-matrix.mjs` (nine today), against a scratch `HOME`.
  It spends Antigravity quota and takes minutes; run it when a change touches
  the permission or denial path.
- Commits follow Conventional Commits (`feat`, `fix`, `docs`, `test`),
  subject line only. No PR number on a direct push to `main`.
- A release is its own commit, `docs: release X.Y.Z`, bumping
  `.claude-plugin/plugin.json`, `package.json` and `CHANGELOG.md` together;
  `npm run check-version` and `tests/manifest.test.mjs` hold them in step.
  Tag `vX.Y.Z`; the GitHub release title is the tag and its body is that
  version's CHANGELOG section.
- Measured claims name the agy version they were measured on. Re-check them
  when agy moves and say what the re-check consisted of.
- Test fixtures never contain a real or realistic credential; build the shape
  by concatenation at runtime.
