---
name: agy-cli-runtime
description: Internal helper contract for calling the Antigravity CLI (agy) from Claude Code
user-invocable: false
---

# Antigravity CLI Runtime

Use this skill only inside the `agy:agy-rescue` subagent or the `/agy:*` commands.

Base invocation:

```bash
root=$(git rev-parse --show-toplevel 2>/dev/null) || root=$PWD
agy -p "<task text>" --output-format json --print-timeout 8m --add-dir "$root"
```

Changed since the contract below was verified, and measured on agy 1.2.10 on 2026-09-25 (agy updated itself to 1.2.11 the same day; not re-measured):

- A bare print-mode run no longer treats its cwd as the project. Started in the repository without `--add-dir`, agy reported no active workspace, `pwd` gave `~/.gemini/antigravity-cli/scratch`, and a "create a file in the current directory" task wrote into that scratch directory. Always pass `--add-dir` with the repository root as an absolute path: `git rev-parse --show-toplevel`, falling back to `$PWD` outside a git repository, which matches the workspace root the companion script uses.
- Since agy 1.2.9 a headless run that leaves a background task running waits for it until the `--print-timeout` deadline (30 minute cap) before printing its result, and agy moves any command that runs longer than 10 seconds into the background. The deadline counts from when agy sends the message, after its startup and sign-in, which took up to 28 seconds. When it passes, agy stops the task and still prints its JSON. The rescue template and every companion prompt template (`prompts/*.md`, the stop-review gate included) therefore tell agy to leave nothing running, and to start any process the user wants kept up detached (nohup or setsid), since agy waits on a tracked background task and kills it at exit.
- The `--print-timeout` default is unlimited since agy 1.2.6, so never omit the flag.

Flag contract (verified against agy 1.2.4). Re-checked on agy 1.2.5 on 2026-09-18 without re-measuring each line: the 11-row `npm run test:denials` harness passed on 1.2.5, three cwd probes ran commands in the invoking directory, `agy --help` showed no flag this contract lacks, and the 1.2.4 and 1.2.5 `/changelog` sections name no print-mode, flag, permission, or result-shape change.

- `-p` / `--print`: run one prompt non-interactively and print the response.
- `--output-format json`: single JSON result object on stdout.
- `--print-timeout <dur>`: agy-side wait limit. Default was 5m on 1.2.4 and is unlimited since 1.2.6. The rescue subagent uses 8m with a 590000 ms Bash tool timeout, which leaves room for agy's startup and shutdown so the common case ends in the foreground. When a Bash call outlives its timeout, Claude Code 2.1.282 moves it to the background rather than killing it, so agy's own deadline is the real cap. The companion script uses 8m under its own 9 minute spawn timeout, which ends before a 590000 ms Bash timeout, so a hung agy comes back as a timeout failure. The stop-review gate is not a Bash call: it keeps 9m under a 10 minute spawn timeout inside the hook's 660 s limit.
- `--mode accept-edits`: auto-approve file edits. Add for write-capable runs. Omit for read-only runs (review, diagnosis, research).
- `-c` / `--continue`: continue the most recent agy conversation. `--conversation <id>`: resume a specific one.
- `--model <name>`: only when the user asked for a specific model. List with `agy models`; do not hardcode model names.
- `--effort <low|medium|high>`: only when the user asked for a specific effort. Some models reject it before any model call: agy exits 1 with `--effort is not supported for model "<name>"` (1.2.4, `claude-opus-4-6-thinking`). That spends no quota, so rerun once without `--effort` and say the flag was dropped. The companion does this itself for `/agy:transfer` and reports `effortDropped: true`.
- `--add-dir <path>`: add directories to the agy workspace. Repeatable. Pass the repository root itself too, as `--add-dir "$root"` from the base invocation; see the note under it.
- `--agent <name>`: select an agy-side agent. List with `agy agents`. Leave unset by default.
- Never pass `--dangerously-skip-permissions` unless the user explicitly asked for it in this session.

Flags that exist on 1.2.4 and are worth knowing:

- `--input-format <text|stream-json>`: `stream-json` reads one NDJSON message per line from stdin and requires `--output-format stream-json`. The input line is `{"event":"user","message":{"role":"user","content":"..."}}`; the `event` key is required and a `type` key is rejected. This is how the companion script sends prompts, because argv is capped (2097152 bytes on a typical Linux box) and a branch diff can exceed it. `-p` still needs an argument in this mode, so it is passed as `-p=`.
- `--json-schema <string or path>`: enforces structured output. For stream-json it applies to the final result. `/agy:adversarial-review` uses it so its review object is enforced rather than merely requested in prose.
- `--mode <accept-edits|plan>`: `--mode plan` is a second mode next to `accept-edits`. Run on 1.2.4 in print mode with a one-line feature request: it wrote a plan artifact under `~/.gemini/antigravity-cli/brain/`, answered `Ready to execute upon approval`, and then edited the target file in the same turn, with and without `--add-dir`. It is not a no-edit mode headlessly, so it is not exposed by `/agy:rescue`; a read-only run still means omitting `--mode`, and a plan-shaped answer is still handled after the fact (see the result handling skill).
- `--sandbox`: runs agy with terminal restrictions enabled. A plausible source of the environment failure `/agy:setup` classifies as `environment`.
- `--disable-slash-commands`: turns off slash command and skill expansion in print mode. `/agy:quota` depends on that expansion, so this flag breaks it.

Constraint worth remembering: slash commands are answered by the CLI itself and are **unavailable** under `--input-format stream-json`. agy says so explicitly. Anything needing `/usage` or another slash command must use the argv form with `--output-format json`.

Interactive mode gotchas (1.2.4):

- `agy -i --mode accept-edits "<prompt>"` exits 2: `-i` takes the next token as its prompt. Attach the prompt to the flag, `agy --mode accept-edits -i="$(cat prompt.md)"`, and put every other flag before it.
- Interactive mode needs a TTY. From a tool shell it fails with `bubbletea: could not open TTY: open /dev/tty: no such device or address`. The `! agy` sign-in hint works only where the host gives the command a terminal.

Headless permission scope (measured on 1.2.4, harness green on 1.2.5). What governs this is the
`toolPermission` setting in `~/.gemini/antigravity-cli/settings.json`, not
workspace membership. With no allow-rules: `always-proceed` approved everything
including outside the workspace; `request-review`, the default, refused commands
while a read of a file inside the workspace was allowed, and file writes were not
gated; `proceed-in-sandbox` refused commands unless agy was started with
`--sandbox`, which this plugin does not pass; `strict` refused even an
in-workspace read, and is the only mode that did. GitHub issue #21 reported an
in-workspace read refused under the default mode, which no run here has
reproduced, so treat a passing read as this machine's result and not a rule. Allow-rules layer on top: `read_file(*)`
lifted a read denial under the default mode, and it covers directory listing,
which agy reports as the same `read_file` action with display name `ListDir`. A
narrow `command(pwd)` rule did not permit `pwd` while `command(*)` did, and agy
never prints the target it tried to match.

agy has no per-invocation override for this. There is no `--tool-permission`
flag and no environment variable, so the mode cannot be set for one run; it is
whatever the user's settings file says. `--mode accept-edits` is not a
substitute: writes were never the thing being refused. GitHub issue #21 saw an in-repository read denied, which did not reproduce here.

Result JSON shape (verified on agy 1.2.4). Under `--output-format stream-json` the terminal `{"event":"result","result":{...}}` carries this same object, plus an `error` field when it failed, which is why both transports feed the same result handling. A headless tool denial adds `denied_actions`, for example `[{"action":"read_file","display_name":"ViewFile"}]`, while `status` stays `SUCCESS` and the exit code stays 0; the companion treats that as a failed run:

```json
{
  "conversation_id": "…",
  "status": "SUCCESS",
  "response": "…",
  "duration_seconds": 3.9,
  "num_turns": 1,
  "usage": {"input_tokens": 0, "output_tokens": 0, "thinking_tokens": 0, "cache_read_tokens": 0, "total_tokens": 0}
}
```

Print-mode slash commands (verified on agy 1.2.4): `agy -p "/usage" --output-format json` (also `/help`, `/changelog`, `/permissions`, `/hooks`, `/config`) answers instantly with a structured payload under a top-level `command` object, spends no quota, and leaves no conversation behind. Detect support by checking that `command.name` matches the requested command; older agy versions treat the text as a normal prompt.

Rules:

- One `agy` invocation per handoff. No retries without being asked.
- Run from the repository root the task concerns, and add it with `--add-dir "$root"` (the git top level, or `$PWD` outside git). Running from the root alone was enough on agy 1.2.5 and is not on 1.2.10.
- Escape the task text safely; prefer a single-quoted heredoc into a shell variable when the text contains quotes.
- Known limit: rescue runs are capped at 8 minutes of agy time by `--print-timeout`. Report a timeout as a timeout; do not silently retry.
