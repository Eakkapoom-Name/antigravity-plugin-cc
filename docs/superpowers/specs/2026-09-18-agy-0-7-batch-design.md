# agy plugin 0.7 batch: design

Date: 2026-09-18. Status: approved in conversation, section by section.
Release: none in this batch. Everything lands under CHANGELOG `[Unreleased]`.

## Scope

Nine items, one spec, ordered by dependency:

1. `runIsolated()`: a shared read-only run helper.
2. Secret scan before any repo text leaves on stdin.
3. `/agy:whisper`: one-shot prompt, no repo context.
4. `/agy:search`: web search or URL fetch through agy, plus the `agy-web` skill
   placing it second in the web tool order.
5. `/agy:research`: structured web investigation, chat plus optional file.
6. `/agy:image`: image generation, file copied out on request.
7. B7: `agy-prompting` skill.
8. F28: agy version floor in `/agy:setup`.
9. F29: `NOTICE`, `SECURITY.md`, `CONTRIBUTING.md`, and the licence position.

Out of scope, recorded elsewhere: review bench (F32), `/agy:scrape`,
`--sandbox`, a job store (deliberate divergence, see OPEN-WORK).

Renames: the command discussed as `/agy:ask` ships as `/agy:whisper`.

## Facts this design rests on

Measured on agy 1.2.5 on 2026-09-18 unless stated:

- `run_command` executes in the invoking `cwd`, with and without `--add-dir`
  (F30: three marker-file probes).
- Headless web search answers with a source URL (21 s), URL fetch returns page
  text (10 s), image generation writes a PNG under
  `~/.gemini/antigravity-cli/brain/<uuid>/` (32 s). All `status: SUCCESS`,
  `num_turns: 1`, no `denied_actions`.
- `agy --help` on 1.2.5 lists `--sandbox` (unmeasured here) and no
  `--tool-permission`.
- `claude --plugin-dir <path>` loads a plugin from a directory. `claude plugin
  marketplace update <name>` and `claude plugin update <plugin>` exist; the
  latter says a restart is required to apply.
- The installed copy on the development machine is 0.5.1 at the `installPath`
  recorded in `~/.claude/plugins/installed_plugins.json`; the repo is 0.6.5
  plus unreleased commits.
- `openai/codex-plugin-cc` is Apache-2.0 with a `NOTICE`. This repository was
  Apache-2.0 with a `NOTICE` at 0.3.1 and switched to MIT, removing `NOTICE`,
  at 0.4.2. `scripts/lib/` shares structure and function names with its
  `scripts/lib/` (`parseArgs`, `runCommand`, `resolveStateDir`,
  `resolveStateFile`, `loadState`, `saveState`, `resolveWorkspaceRoot`).

## Section 1: `runIsolated()`

New export in `scripts/lib/agy.mjs`:

```
runIsolated(prompt, options) -> same shape as runPromptWithDenialRecovery
```

Creates a temp directory with `fs.mkdtempSync`, calls
`runPromptWithDenialRecovery(prompt, { ...options, cwd: tmp, addDir: [tmp] })`,
removes the directory in `finally`. Never passes `--mode`. No `--sandbox` in
this batch.

Users: `review`, `adversarial-review`, `whisper`, `search`, `research`,
`image`. Not the stop gate (its prompt names `{{REPO_ROOT}}`), not `rescue`,
not `transfer`.

Cost, stated in the review prompt: the reviewer cannot open files around a
hunk; the diff is the whole evidence. Under `request-review` that read is
denied and F21's one-shot recovery finishes on the diff.

Errors: temp dir creation failure returns `{ ok: false, failure: "isolation" }`
before any agy call. Cleanup failure goes into the result as `note` and never
fails the run.

Tests (`tests/agy-lib.test.mjs`): temp path reaches `buildArgs` as both `cwd`
and `--add-dir`; the repo path never appears in argv; temp dir is gone after
success, after an agy failure, and after a thrown error.

## Section 2: secret scan

New `scripts/lib/secrets.mjs`:

```
scanForSecrets(text, { allow = [] }) -> { hits: [{ line, kind, sample }] }
```

Called in the companion before `renderPrompt` for `review`,
`adversarial-review`, and `transfer`. New commands send no repo text and skip
it.

Patterns, hand-rolled, no dependency:

- AWS access key id: `AKIA` followed by 16 uppercase alphanumerics.
- Private key blocks: `-----BEGIN ... PRIVATE KEY-----`.
- GitHub tokens: `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` plus 36 characters;
  `github_pat_`.
- Slack tokens: `xox[abprs]-`.
- Google API keys: `AIza` plus 35 characters.
- `Authorization:` header or bearer with a long token.
- Assignment where the key name contains `SECRET`, `TOKEN`, `PASSWORD`,
  `API_KEY` and the value is 16 or more characters and not a placeholder
  (`xxx`, `changeme`, `<...>`, `${...}`).

Only added lines (`+` prefix) of a diff are scanned. `sample` is the first six
characters plus the length, never the value.

On a hit the run is blocked: `{ ok: false, failure: "secrets", hits }`. The
command prints `file:line kind` per hit and two ways forward: redact and rerun,
or `--allow-secret <regex>`, repeatable, matched against the full line. No
environment variable off-switch.

Out of scope: entropy scoring, untracked files, rescue prompts.

Tests (`tests/secrets.test.mjs`): each pattern hits on a documented example
value built by concatenation at runtime (AWS publishes
`AKIAIOSFODNN7EXAMPLE`; GitHub shape is `"ghp_" + "x".repeat(36)`), so the
test file holds no key-shaped literal. Negatives: placeholders, removed lines,
short values, `sha256:` digests. Companion test: a hit returns
`failure: "secrets"` and `buildArgs` is never called.

## Section 3: `/agy:whisper`

`commands/whisper.md`: `argument-hint: "[--model <name>] [--effort
low|medium|high] <prompt>"`, `allowed-tools: Bash(node:*)`, Bash timeout
200000 ms. Body runs `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs"
whisper "$ARGUMENTS"`, presents `response` as-is, reports `conversation_id` as
resumable via `/agy:continue`.

Companion subcommand `whisper`: existing flag parser for `--model` and
`--effort`; non-empty prompt required, else `{ ok: false, error: "whisper
needs a prompt" }` with no run; `prompts/whisper.md` template (answer
directly; cite sources when the answer rests on the web); `runIsolated()` with
`printTimeout: "3m"`.

Not in scope: `--add-dir`, `-c`, file output.

Tests: frontmatter and subcommand known-list in `tests/commands.test.mjs`;
template in `tests/prompts.test.mjs`; empty prompt short-circuit; flags reach
`buildArgs`; README "What You Get" line (`tests/docs.test.mjs`).

## Section 4: `/agy:search` and the `agy-web` skill

`commands/search.md`: `argument-hint: "[--model <name>] <query or URL>"`, Bash
timeout 200000 ms, `--print-timeout 3m`. Companion subcommand `search` picks
the mode:

- Argument parses as an `http(s)://` URL: fetch mode, `prompts/fetch.md`. Read
  the page, return content as markdown keeping headings and code blocks, list
  outbound links relied on, say plainly if the page could not be read.
- Otherwise: search mode, `prompts/search.md`. Answer from a web search, tie
  every claim to a source, end with `Sources:` and full URLs, say when sources
  disagree.

Both through `runIsolated()`.

Fetch guards, applied before any agy call, rejection carries the reason:
scheme `http` or `https` only; hostname must not resolve to loopback, RFC 1918
private ranges, link-local, or `169.254.169.254`; no credentials in the URL.
`nip.io` style hosts are not handled in this cut.

Skill `skills/agy-web/SKILL.md`, `user-invocable: false`. Tier order: built-in
WebSearch and WebFetch first; on failure (403, bot challenge, truncated
summary, raw text file) `/agy:search`; Tavily and ddg after. States what agy
returns: a grounded answer with sources, not a results list; extracted text,
not raw bytes. Every answer must carry source URLs.

Manual step for the user, outside the repo: one line in the global CLAUDE.md
"Web tool order" placing `/agy:search` between built-ins and Tavily.

Tests: URL guard table (allowed, loopback, private, metadata, credentials,
ftp); mode selection; templates; frontmatter; skill text pins the tier order
and the source-URL rule in `tests/skills.test.mjs`.

## Section 5: `/agy:research`

`commands/research.md`: `argument-hint: "[--model <name>] [--effort
low|medium|high] [--out <path>] <topic>"`, Bash timeout 590000 ms,
`--print-timeout 9m`.

`prompts/research.md`, fixed section order:

1. Summary, three to five sentences.
2. Key findings, each with its source inline.
3. Where sources disagree or evidence is thin.
4. Caveats and what was not checked.
5. Sources, numbered, full URLs.

Depth is `--effort`. Effort rejection reuses the existing drop-and-rerun on
`effortRejected()` and reports `effortDropped: true`.

Output: chat first. `--out <path>` writes the same markdown: path resolved
against the workspace root and must stay inside it; parent directory must
exist; an existing file is refused (no `--force` in this cut). The companion
performs the write after agy returns; agy runs through `runIsolated()`.

Tests: `--out` path rules (inside, outside, existing, missing parent); write
only on `ok: true`; effort drop; template; frontmatter; README line.

## Section 6: `/agy:image`

`commands/image.md`: `argument-hint: "[--model <name>] [--out <path>]
<description>"`, Bash timeout 320000 ms, `--print-timeout 5m`.

`prompts/image.md`: use the image generation tool to create the described
image; reply with one line, the absolute path of the saved file, nothing else.

Companion subcommand `image`: `runIsolated()`; parse the single path from
`response`; validate that it resolves (after `fs.realpathSync`) under
`~/.gemini/antigravity-cli/brain/` and ends in `.png`, `.jpg`, `.jpeg`, or
`.webp`; otherwise report the raw response and copy nothing. With `--out
<path>`: same workspace-root rules as research, then `fs.copyFileSync`. Without
`--out`: report the brain path, copy nothing. Result carries `imagePath` and,
when copied, `outPath`.

The path check is the point: the companion copies a file agy named, so the
name must be shown to sit where agy writes before `cp` runs.

Tests: path parsing from a one-line and a chatty response; realpath under
brain accepted, outside rejected, symlink out rejected; extension list;
`--out` rules; no copy without `--out`; frontmatter; template; README line.

## Section 7: B7, the `agy-prompting` skill

`skills/agy-prompting/SKILL.md`, `user-invocable: false`, listed in the
`skills:` frontmatter of `agents/agy-rescue.md` so the agent loads it.

Contract, block-structured with XML tags, one task per run:

- `<task>`: the concrete job and the repository or failure context.
- `<output_contract>`: exact shape, ordering, brevity.
- `<done_state>`: what finished looks like; agy does not infer it.
- `<verification_loop>`: required for fixes and implementation; run the tests
  it touched and report the command and result.
- `<grounding_rules>`: required for review and research; no claim without a
  source or an inspected artifact.
- `<action_safety>`: for write-capable runs; stay narrow, no unrelated
  refactors, no dependency changes unless asked.

The five new prompt templates (`whisper`, `search`, `fetch`, `research`,
`image`) follow this contract, so there is one prompt shape in the plugin.

Tests (`tests/skills.test.mjs`): frontmatter fields; each block name present;
`agents/agy-rescue.md` lists the skill.

## Section 8: F28, the agy version floor

`scripts/agy-setup.mjs`: `const MIN_AGY_VERSION = "1.2.4"`, the version every
contract was measured on. `agy --version` prints a bare `1.2.5`; compare three
numeric parts, no library. Below the floor: `ready: false`, a `not-ready` line
naming both versions, and the probes are skipped (they would fail with worse
messages). At or above: unchanged. The report gains `agy.minimumVersion`.

The denial harness rows must still read `ready: false` for the denial reason,
not the version gate; the harness asserts `agy.minimumVersion` is met.

Tests: compare table (`1.2.4` vs `1.2.4`, `1.2.5`, `1.2.10`, `1.3.0`,
`1.1.28`, `2.0.0`, malformed); report shape when below; probes not called
when below.

## Section 9: F29, licence position and policy files

Facts: this repository derives structure and helper code from
`openai/codex-plugin-cc` (Apache-2.0, with `NOTICE`). It was Apache-2.0 with a
`NOTICE` at 0.3.1 and switched to MIT, removing `NOTICE`, at 0.4.2. The
README does not name codex-plugin-cc.

Position taken here, not legal advice: Apache-2.0 section 4 asks a
redistributor of a derivative to keep the Apache licence text and the `NOTICE`
attribution for the derived parts. MIT can cover this repository's own work; it
does not remove those terms from the derived parts.

Changes:

- `NOTICE`: names `openai/codex-plugin-cc`, its copyright line, and Apache-2.0,
  and lists the files whose structure derives from it (the argument parsing
  in `scripts/agy-companion.mjs`, `scripts/lib/process.mjs`, `state.mjs`,
  `workspace.mjs`, and the companion and stop-gate layout).
- `LICENSE`: MIT text stays for this repository's work; add
  `LICENSE-APACHE-2.0` with the Apache text for the derived parts, and a
  paragraph at the top of `LICENSE` explaining the split.
- README: a "Credits and licence" section naming codex-plugin-cc and the split.
- `package.json` `files`: add `NOTICE` and `LICENSE-APACHE-2.0` so the npm
  tarball carries them; `tests/prepack.test.mjs` asserts they are packed.
- `SECURITY.md`: what leaves the machine (diffs, changed-file contents, the
  transfer brief, prompts), where it goes (agy, then Google's models), the
  secret scan, the read-only isolation, how to report a problem (GitHub
  issue, or the email in `package.json` `author` if present, else the issue
  tracker only).
- `CONTRIBUTING.md`: `npm test` must pass, Conventional Commits, no PR number
  on direct pushes, release is its own `docs: release X.Y.Z` commit, the
  denial harness is live and costs quota.

Tests (`tests/docs.test.mjs`): `NOTICE` names codex-plugin-cc and Apache-2.0;
README credits section exists; `SECURITY.md` names the secret scan and
isolation; prepack includes the two files.

## Section 10: development loop, testing, order

Development loop, as chosen:

1. Update the installed copy so it matches the repo before touching it:
   `claude plugin marketplace update antigravity-plugin-cc`, then `claude
   plugin update agy@antigravity-plugin-cc`, restart Claude Code. Confirm
   `installPath` in `~/.claude/plugins/installed_plugins.json` now points at a
   `0.6.5` directory and `diff -rq <installPath> <repo> -x .git -x '*.bak' -x
   .claude -x node_modules -x docs` is empty apart from files the repo has
   that the plugin does not ship.
2. Edit the installed copy at `installPath`. Try commands in a real session.
   Run `npm test` inside that copy.
3. Copy back with `diff -rq` as the list, never from memory. New files
   (`skills/agy-prompting/SKILL.md`, `skills/agy-web/SKILL.md`,
   `commands/whisper.md`, `commands/search.md`, `commands/research.md`,
   `commands/image.md`, `prompts/*.md`, `scripts/lib/secrets.mjs`,
   `tests/secrets.test.mjs`, `NOTICE`, `LICENSE-APACHE-2.0`, `SECURITY.md`,
   `CONTRIBUTING.md`) are the ones that get forgotten.
4. In the repo: `npm test`, `npm run test:denials` when a change touches the
   permission path (sections 1, 2, 8), one commit per section in Conventional
   Commits, co-author grep before every push, push to `main`. No tag, no
   release.

Every new command file carries an explicit Bash timeout (F1) and a
`--print-timeout` sized to the job. README "What You Get" gains one line per
new command. CHANGELOG `[Unreleased]` gains `### Added` bullets for sections
3 to 7 and 9, `### Changed` for sections 1, 2 and 8.

Build order, by dependency:

1. Section 1 (`runIsolated`) and Section 2 (secret scan), offline tests.
2. Reviews and transfer adopt both.
3. Section 3 whisper, Section 4 search plus skill, Section 5 research,
   Section 6 image, on the helper.
4. Section 7 prompting skill alongside the new templates.
5. Section 8 floor and Section 9 policy files, independent, any time.

Live checks after step 3: one run of each new command against a throwaway
workspace, results pasted into the CHANGELOG bullets as measured numbers.
