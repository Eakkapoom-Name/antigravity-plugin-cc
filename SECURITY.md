# Security

## What leaves your machine

Most commands here hand text to the Antigravity CLI (`agy`), which sends it
to Google's models under your own agy account and settings. Three never call
agy at all: `/agy:cancel`, `/agy:status`, and `/agy:result` only read Claude
Code's own background task tracking; this plugin keeps no job store, so
those three have no deterministic work to send anywhere. They may read a
rescue result file (see below), which stays local. What the rest
send, per command:

- `/agy:review`, `/agy:adversarial-review`: the git diff of the chosen scope.
  Not the rest of the repository: these run from an isolated temp directory,
  not your project. That is a working-directory change, not a sandbox:
  whether agy can reach paths outside that directory depends on agy's own
  `toolPermission` setting (under `always-proceed` it can read a file by
  absolute path), and with agy's `allowNonWorkspaceAccess` setting on and an
  absolute path in the text, agy can still reach outside it.
- `/agy:transfer`: the handoff brief Claude Code wrote, which summarises the
  conversation and can quote files.
- `/agy:rescue`, `/agy:continue`: the task text, and whatever agy then reads
  or runs in your repository under agy's own permission settings. agy's full
  JSON answer is saved to `${TMPDIR:-/tmp}/agy-rescue-XXXXXX`, created by
  `mktemp` with mode 0600 so only you can read it. Nothing deletes these
  files; the answer can quote code from the repository.
- `/agy:whisper`, `/agy:search`, `/agy:research`, `/agy:image`: the prompt
  text only, from an isolated temp directory.
- `/agy:quota`: no user text; a fixed print-mode `/usage` slash command that
  spends no quota.
- `/agy:setup`'s readiness check: no user text either, a version check plus
  fixed auth, command and read probes; the read probe briefly plants a
  marker file in your actual workspace root, not an isolated directory, and
  asks agy to read it back. The gate on/off/status form of the same command
  sends nothing to agy at all.
- The stop-review gate: the previous Claude turn, and whatever agy reads in the
  repository to check it.

## Guards

- A secret scan runs on every diff and transfer brief before it leaves. A
  credential shape (AWS key id, private key block, GitHub, Slack or Google
  tokens, bearer tokens, `SECRET`/`TOKEN`/`PASSWORD`/`API_KEY` assignments,
  `scheme://user:password@host` URLs) blocks the run and names the line and
  kind, never the value. The whole diff is what leaves, so the whole diff is
  scanned: added, removed and context lines, the text git copies from the file
  into a hunk header after its closing `@@`, and any line that is not one of
  git's own header lines. Only the `diff --git`, `---`/`+++`, hunk-header and
  extended header lines (index, mode, rename, binary notice), which carry
  paths and hashes, are not. Every diff is collected with its format pinned
  against your git config (`--no-color --no-ext-diff --no-textconv`, default
  `a/`/`b/` prefixes, `--submodule=short`), and a non-empty diff whose shape
  is not recognized (no `diff --git` header at all) is refused rather than
  sent unscanned.
  `--allow-secret <regex>` belongs to `/agy:review` and
  `/agy:adversarial-review`, where it admits a known fixture. `/agy:transfer`
  has no such flag: a blocked brief is resolved by editing the brief.
- `/agy:review`, `/agy:adversarial-review`, `/agy:whisper`, `/agy:search`,
  `/agy:research` and `/agy:image` run agy from an isolated temp directory
  rather than the project; whether agy can still reach paths outside it
  depends on agy's `toolPermission` setting. Three other runs are not isolated this way.
  `/agy:quota` is read-only and sends no user text. `/agy:setup`'s readiness
  check writes a marker file into the actual workspace root for its read probe
  to read back, so it runs against the workspace, not an isolated directory.
  The stop-review gate runs agy with the repository as its cwd and as its
  `--add-dir`, because it reviews the working tree itself.
- `/agy:search` refuses loopback, private and link-local targets, non-http
  schemes, and URLs with credentials. Both halves of that command are checked:
  a URL given as the whole argument, and a URL-shaped word inside an ordinary
  search query. The check covers `/agy:search` only. `/agy:whisper`,
  `/agy:research` and `/agy:image` pass their text to the same web-capable agy
  with no URL check at all, so a local-network address named in one of those
  prompts is not refused here.
- `/agy:image` copies a file only after showing the path agy named sits under
  agy's own artifacts directory.
- `/agy:setup` refuses an agy below 1.2.4, the version these behaviours were
  measured on.

## Reporting a problem

Open an issue at https://github.com/Eakkapoom-Name/antigravity-plugin-cc/issues
with the command, the agy version (`agy --version`), and the smallest input that
shows the problem. Do not paste credentials, even redacted; describe their
shape. If the problem is in agy itself rather than this plugin, the Antigravity
documentation names its own channel.
