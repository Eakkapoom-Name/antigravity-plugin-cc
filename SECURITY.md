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
  absolute path). agy 1.2.14 also has an `allowNonWorkspaceAccess` setting,
  whose effect is unmeasured here; nothing in this document relies on it.
- `/agy:transfer`: the handoff brief Claude Code wrote, which summarises the
  conversation and can quote files. agy then has the repository as its
  workspace (its cwd and its `--add-dir`) and can read files the brief names.
- `/agy:rescue`, `/agy:continue`: the task text, and whatever agy then reads
  or runs in your repository under agy's own permission settings. agy's full
  JSON answer is saved to `${TMPDIR:-/tmp}/agy-rescue-XXXXXX`, created by
  `mktemp`, and the response text alone to
  `${TMPDIR:-/tmp}/agy-rescue-XXXXXX.md`, both mode 0600 so only you can read
  them; the answer can quote code from the repository. Each rescue run first
  deletes your own regular files of those two name shapes, directly in that
  directory, last modified more than 10080 minutes (7 days) ago. Symlinks,
  directories, other users' files and other names are left untouched.
- `/agy:whisper`, `/agy:search`, `/agy:research`, `/agy:image`: the prompt
  text only, from an isolated temp directory, after the secret scan below.
- `/agy:quota`: no user text; a fixed print-mode `/usage` slash command that
  spends no quota.
- `/agy:setup`'s readiness check: no user text either, a version check plus
  fixed auth, command and read probes; the read probe briefly plants a
  marker file in your actual workspace root, not an isolated directory, and
  asks agy to read it back. All three probes run with that root as agy's
  working directory and its `--add-dir`. When the root is not writable, the
  read probe is skipped and reported as skipped, rather than planted in a
  temp directory outside that root. The gate on/off/status form of the same command
  sends nothing to agy at all.
- The stop-review gate: the previous Claude turn, and whatever agy reads in the
  repository to check it. The older in-repository `.claude/agy.local.md` gate
  flag is honoured only when git reports it untracked or ignored and it is
  not reached through a symlink; one committed to the repository (directly,
  through a committed `.claude` symlink or submodule, or under a case
  variant of the path) cannot turn the gate on for someone who clones it,
  and when git refuses to answer for the repository the file is not
  honoured. Residual: with no `.git` at the workspace root (a tarball or zip
  download) or no git installed, there is nothing to ask, and the file is
  still honoured.

## Guards

- A secret scan runs on every diff and transfer brief before it leaves, and on
  the free-text argument of `/agy:whisper`, `/agy:search`, `/agy:research` and
  `/agy:image` (not their flag values). A credential shape (AWS key id,
  private key block, GitHub, Slack, Google or Stripe secret
  (`sk_live_`/`sk_test_`) tokens, JWTs, bearer tokens,
  `SECRET`/`TOKEN`/`PASSWORD`/`API_KEY` assignments,
  `scheme://user:password@host` URLs) blocks the run and names the line and
  kind, never the value. An assignment is caught with the name in all upper
  case or all lower case (`password: ...` in YAML), a quote before the
  separator (`"API_KEY": "..."`), and a quoted value that contains spaces;
  mixed-case names such as `apiKey` or `tokenType` are not. Every assignment
  on a line is checked, so a placeholder or `${{ secrets.X }}` reference
  earlier on the line does not hide a real value after it. Under a lower-case
  name only, an unquoted value that reads as code is skipped: a call or
  subscript (`token = getAccessToken(scope);`), a dotted member path
  (`self.store.token`), or a snake_case or CONSTANT_CASE identifier
  (`password = private_key_password`). The cost is that a real secret of one
  of those shapes, written unquoted under a lower-case name
  (`password: my.pass.word.1234`), is not caught. Known false positives
  remain: a long value under any keyword name that is not a secret, such as
  `token_url: https://...`, quoted prose such as
  `password_label: "Please enter your password"`, and a string constant or
  call under an upper-case keyword name. The whole diff is
  what leaves, so the whole diff is scanned: added, removed and context lines,
  the text git copies from the file into a hunk header after its closing `@@`,
  and any line that is not one of git's own header lines. Only the
  `diff --git`/`diff --cc`/`diff --combined`, `---`/`+++`, hunk-header and
  extended header lines (index, mode, rename, binary notice), which carry
  paths and hashes, are not.
  Every diff is collected with its format pinned against your git config
  (`--no-color --no-ext-diff --no-textconv`, default `a/`/`b/` prefixes,
  `--submodule=short`), and a non-empty diff whose shape is not recognized (no
  `diff --git` or `diff --cc`/`diff --combined` header at all) is refused
  rather than sent unscanned. A blocked whisper, search, research or image run
  makes no agy call at all; `/agy:search` scans only after its URL guard has
  passed.
  `--allow-secret <regex>` (repeatable) belongs to `/agy:review`,
  `/agy:adversarial-review`, `/agy:transfer`, `/agy:whisper`, `/agy:search`,
  `/agy:research` and `/agy:image`, where it admits a known fixture; the other
  way forward is editing the diff, brief or argument to redact the credential.
  In a diff the pattern is matched against the raw line, marker included
  (`^\+FIXTURE_TOKEN=`). The copy of a file line that git puts in a hunk
  header has no marker, so a pattern clears that copy only when it matches the
  whole hunk-header line or the copied text as it stands, or when the copy is
  the same text as a content
  line an allow pattern cleared (or git's 80-byte cut of one). A pattern
  written for one marker therefore never clears a different line git copied
  into a header: `^-API_KEY`, admitting a removed revoked key, still blocks a
  live `API_KEY=` line that appears in a hunk header.
- `/agy:review`, `/agy:adversarial-review`, `/agy:whisper`, `/agy:search`,
  `/agy:research` and `/agy:image` run agy from an isolated temp directory
  rather than the project; whether agy can still reach paths outside it
  depends on agy's `toolPermission` setting. Six other runs are not isolated
  this way. `/agy:quota` is read-only and sends no user text. `/agy:setup`'s
  readiness check writes a marker file into the actual workspace root for its
  read probe to read back, so it runs against the workspace, not an isolated
  directory. The stop-review gate runs agy with the repository as its cwd and
  as its `--add-dir`, because it reviews the working tree itself.
  `/agy:transfer` likewise runs agy with the repository as its cwd and as its
  `--add-dir`. `/agy:rescue` and `/agy:continue` run agy with the repository
  as its cwd and its `--add-dir` and, by default, `--mode accept-edits`, so agy can edit it
  there; a run the user asks to keep read-only drops `--mode`.
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
