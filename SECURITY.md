# Security

## What leaves your machine

Every command here hands text to the Antigravity CLI (`agy`), which sends it
to Google's models under your own agy account and settings. What that text is,
per command:

- `/agy:review`, `/agy:adversarial-review`: the git diff of the chosen scope.
  Not the rest of the repository: these run from an isolated temp directory
  and agy cannot read your files.
- `/agy:transfer`: the handoff brief Claude Code wrote, which summarises the
  conversation and can quote files.
- `/agy:rescue`, `/agy:continue`: the task text, and whatever agy then reads
  or runs in your repository under agy's own permission settings.
- `/agy:whisper`, `/agy:search`, `/agy:research`, `/agy:image`: the prompt
  text only, from an isolated temp directory.
- The stop-review gate: the previous Claude turn, and whatever agy reads in the
  repository to check it.

## Guards

- A secret scan runs on every diff and transfer brief before it leaves. A
  credential shape (AWS key id, private key block, GitHub, Slack or Google
  tokens, bearer tokens, `SECRET`/`TOKEN`/`PASSWORD`/`API_KEY` assignments)
  blocks the run and names the line and kind, never the value.
  `--allow-secret <regex>` admits a known fixture.
- Read-only commands run agy in an isolated temp directory so they cannot
  write into the project.
- `/agy:search` fetch mode refuses loopback, private and link-local targets,
  non-http schemes, and URLs with credentials.
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
