import test from "node:test";
import assert from "node:assert/strict";

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { listMarkdown, parseFrontmatter, read } from "./helpers.mjs";
import { DEFAULT_PRINT_TIMEOUT, printTimeoutMs, spawnTimeoutMs } from "../scripts/lib/agy.mjs";

const COMMANDS = listMarkdown("commands");

// Commands that deliberately take no arguments.
const NO_ARGUMENT_COMMANDS = new Set(["quota.md"]);

test("every command file exists and is discovered", () => {
  assert.deepEqual(COMMANDS, [
    "adversarial-review.md",
    "cancel.md",
    "continue.md",
    "image.md",
    "quota.md",
    "rescue.md",
    "research.md",
    "result.md",
    "review.md",
    "search.md",
    "setup.md",
    "status.md",
    "transfer.md",
    "whisper.md"
  ]);
});

for (const name of COMMANDS) {
  test(`${name} has a usable frontmatter block`, () => {
    const fields = parseFrontmatter(read(`commands/${name}`));
    assert.ok(fields, `${name} has no frontmatter`);
    assert.ok(fields.description, `${name} has no description`);
    assert.ok(
      fields.description.length <= 120,
      `${name} description is too long for the command picker`
    );
    assert.ok(fields["allowed-tools"], `${name} does not declare allowed-tools`);
    if (NO_ARGUMENT_COMMANDS.has(name)) {
      assert.equal(fields["argument-hint"], undefined);
    } else {
      assert.ok(fields["argument-hint"], `${name} takes arguments but has no argument-hint`);
    }
  });

  test(`${name} scopes every Bash grant`, () => {
    const fields = parseFrontmatter(read(`commands/${name}`));
    const tools = fields["allowed-tools"].split(",").map((entry) => entry.trim());
    for (const tool of tools) {
      if (tool === "Bash" || tool.startsWith("Bash ")) {
        assert.fail(`${name} grants unscoped Bash; use Bash(<prefix>:*)`);
      }
    }
  });

  test(`${name} references plugin scripts through CLAUDE_PLUGIN_ROOT`, () => {
    const source = read(`commands/${name}`);
    for (const match of source.matchAll(/[^\s"']*scripts\/[a-z0-9-]+\.mjs/g)) {
      assert.match(
        match[0],
        /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\//,
        `${name} refers to ${match[0]} without CLAUDE_PLUGIN_ROOT`
      );
    }
  });
}

// After the companion port only /agy:transfer still writes a file model-side,
// because the handoff brief summarizes a conversation the script cannot see.
// It hands the script a path, so the brief never reaches a command line.
test("transfer writes its brief with the Write tool and passes only a path", () => {
  const fields = parseFrontmatter(read("commands/transfer.md"));
  const source = read("commands/transfer.md");
  const tools = fields["allowed-tools"].split(",").map((entry) => entry.trim());
  assert.ok(tools.includes("Write"), "transfer.md writes a brief but does not grant Write");
  assert.match(source, /Pass the script the \*\*path\*\*, never the brief text/);
  assert.match(source, /agy-companion\.mjs" transfer/);
});

// The old shape: every command shelled out to agy itself, so each needed its own
// agy, git, cat and rm grants. The companion owns those calls now, so a command
// that still grants Bash(agy:*) is reaching around it.
for (const name of ["review.md", "adversarial-review.md", "transfer.md", "quota.md", "whisper.md", "search.md", "research.md", "image.md"]) {
  test(`${name} goes through the companion rather than calling agy itself`, () => {
    const fields = parseFrontmatter(read(`commands/${name}`));
    const source = read(`commands/${name}`);
    assert.ok(
      !fields["allowed-tools"].includes("Bash(agy:"),
      `${name} still grants Bash(agy:*); the companion runs agy now`
    );
    assert.match(fields["allowed-tools"], /Bash\(node:\*\)/);
    assert.match(source, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/agy-companion\.mjs/);
  });
}

test("setup command runs the readiness script with a timeout that outlasts both probes", () => {
  const source = read("commands/setup.md");
  assert.match(source, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/agy-setup\.mjs/);
  // Three probes at a 3 minute spawn timeout each: the default 120000 ms Bash
  // timeout kills the script before it prints its report.
  const timeout = source.match(/Bash `timeout` of `(\d+)` ms/);
  assert.ok(timeout, "setup.md does not state an explicit Bash timeout");
  assert.ok(
    Number(timeout[1]) > 3 * 180000,
    `setup.md timeout ${timeout[1]} ms is not longer than the worst-case readiness run`
  );
  assert.ok(
    Number(timeout[1]) <= 600000,
    `setup.md timeout ${timeout[1]} ms exceeds the Bash tool maximum`
  );
});

// F81. Every command that runs Bash states its own timeout, or a slow run
// falls back to the default 120000 ms and is killed mid-report. Two phrasings
// are in use: "Bash `timeout` of `N` ms" and "Bash tool timeout to N ms".
const BASH_COMMANDS = COMMANDS.filter((name) =>
  /\bBash\b/.test(parseFrontmatter(read(`commands/${name}`))?.["allowed-tools"] ?? "")
);

test("at least one command grants Bash, so the timeout checks below run", () => {
  assert.ok(BASH_COMMANDS.length > 0, "no command's allowed-tools grants Bash");
});

for (const name of BASH_COMMANDS) {
  test(`${name} states an explicit Bash timeout`, () => {
    const source = read(`commands/${name}`);
    const timeout = source.match(/Bash (?:tool )?`?timeout`?(?: of| to) `?(\d+)`? ms/);
    assert.ok(timeout, `${name} grants Bash but states no explicit Bash timeout`);
    const ms = Number(timeout[1]);
    assert.ok(ms > 0, `${name} states a zero Bash timeout`);
    assert.ok(ms <= 600000, `${name} timeout ${ms} ms exceeds the Bash tool maximum`);
  });
}

// F79/F98/F102. Every companion command's stated Bash timeout has to outlast
// the spawn timeout the companion derives from its own print timeout (or a
// hung agy is killed by Bash before Node's own timeout can report a clean
// failure), and has to clear the print timeout plus agy's own startup
// overhead (up to 28 s measured on agy 1.2.9) by at least 60 s (F98's own
// margin), or Claude Code backgrounds the call instead of agy returning its
// own timeout report.
const AGY_STARTUP_MARGIN_MS = 28 * 1000;
const BASH_TIMEOUT_MARGIN_MS = 60 * 1000;

// The print timeout each companion command runs agy with, read from
// scripts/agy-companion.mjs itself so this test fails the moment a call site
// changes a printTimeout without updating its command file's Bash timeout to
// match. review/adversarial-review/transfer take no printTimeout override, so
// they fall back to runPrompt's own DEFAULT_PRINT_TIMEOUT; quota takes no
// override either, but runSlashCommand's own default is "2m", not
// DEFAULT_PRINT_TIMEOUT, since slash commands are a different protocol.
function companionPrintTimeout(fnName) {
  const source = read("scripts/agy-companion.mjs");
  const start = source.indexOf(`function ${fnName}(`);
  assert.ok(start >= 0, `${fnName} not found in scripts/agy-companion.mjs`);
  const end = source.indexOf("\nexport ", start + 1);
  const body = source.slice(start, end === -1 ? source.length : end);
  const match = body.match(/printTimeout:\s*"(\d+[ms])"/);
  return match ? match[1] : DEFAULT_PRINT_TIMEOUT;
}

const COMPANION_COMMAND_PRINT_TIMEOUTS = {
  "whisper.md": companionPrintTimeout("whisper"),
  "search.md": companionPrintTimeout("search"),
  "research.md": companionPrintTimeout("research"),
  "image.md": companionPrintTimeout("image"),
  "review.md": DEFAULT_PRINT_TIMEOUT,
  "adversarial-review.md": DEFAULT_PRINT_TIMEOUT,
  "transfer.md": DEFAULT_PRINT_TIMEOUT,
  "quota.md": "2m"
};

for (const [name, printTimeout] of Object.entries(COMPANION_COMMAND_PRINT_TIMEOUTS)) {
  test(`${name}'s stated Bash timeout leaves margin over its print timeout's spawn timeout`, () => {
    const source = read(`commands/${name}`);
    const timeout = source.match(/Bash (?:tool )?`?timeout`?(?: of| to) `?(\d+)`? ms/);
    assert.ok(timeout, `${name} states no explicit Bash timeout`);
    const bashMs = Number(timeout[1]);
    const printMs = printTimeoutMs(printTimeout);
    const spawnMs = spawnTimeoutMs(printTimeout);

    assert.ok(bashMs > spawnMs, `${name}'s ${bashMs} ms Bash timeout does not exceed its ${spawnMs} ms spawn timeout`);
    assert.ok(
      bashMs - printMs - AGY_STARTUP_MARGIN_MS >= BASH_TIMEOUT_MARGIN_MS,
      `${name}'s ${bashMs} ms Bash timeout leaves less than ${BASH_TIMEOUT_MARGIN_MS} ms over its ${printMs} ms print timeout plus agy's startup`
    );
    assert.ok(bashMs <= 600000, `${name} timeout ${bashMs} ms exceeds the Bash tool maximum`);
  });
}

test("setup command branches on the auth failure kind instead of always saying sign in", () => {
  const source = read("commands/setup.md");
  // The script classifies three causes; the doc is what actually decides what
  // the user is told, so it has to name all three and the field to branch on.
  assert.match(source, /auth\.failureKind/);
  for (const kind of ["environment", "auth", "unknown"]) {
    assert.match(source, new RegExp("`" + kind + "`"));
  }
  assert.match(source, /not a login failure/i);
});

test("setup command keeps the permission guidance honest", () => {
  const source = read("commands/setup.md");
  assert.match(source, /command\(\*\)/);
  assert.match(source, /unverified/i);
  // A permission denial must never be presented as an auth problem.
  assert.match(source, /never tell the user to sign in again/i);
});

test("setup command routes the gate toggle through the companion", () => {
  const source = read("commands/setup.md");
  assert.match(source, /agy-companion\.mjs" gate/);
  assert.match(source, /gate on/);
  assert.match(source, /gate off/);
  assert.match(source, /gate status/);
  // The status branch names the state file too, so a reader can tell which file
  // this workspace reads without turning the gate on and off to find out.
  assert.match(source, /`gate status`[^\n]*`stateFile`/);
  // The flag left the repository, so the command must not tell users to edit a
  // file in their project any more.
  assert.ok(
    !/Create the file if missing/.test(source),
    "setup.md still instructs the model to write the in-repository settings file"
  );
  assert.match(source, /stored outside the repository/);
});

for (const name of ["review.md", "adversarial-review.md"]) {
  test(`${name} stays review-only and stops before fixing`, () => {
    const source = read(`commands/${name}`);
    assert.match(source, /read-only/i);
    assert.match(source, /STOP/);
    assert.match(source, /before touching a single file/i);
  });
}

for (const name of ["rescue.md", "continue.md"]) {
  test(`${name} delegates through the Agent tool, not the Skill tool`, () => {
    const source = read(`commands/${name}`);
    assert.match(source, /subagent_type:\s*"agy:agy-rescue"/);
    assert.match(source, /not a skill/i);
    assert.match(source, /Do not call it through the `Skill` tool/);
  });

  test(`${name} grants no agy access it never uses`, () => {
    const fields = parseFrontmatter(read(`commands/${name}`));
    const source = read(`commands/${name}`);
    // Both commands delegate through the Agent tool only; neither runs agy
    // itself, so a Bash(agy:*) grant here is unused authority.
    assert.ok(
      !fields["allowed-tools"].includes("Bash(agy:"),
      `${name} grants Bash(agy:*) but delegates only through the Agent tool`
    );
    assert.match(source, /subagent_type:\s*"agy:agy-rescue"/);
  });

  test(`${name} separates a Claude Code denial from an agy failure`, () => {
    const source = read(`commands/${name}`);
    assert.match(source, /denied by the Claude Code auto mode classifier/);
    assert.match(source, /`\/permissions`/);
    // The setup branch used to swallow this case, since a denial is an
    // immediate error. It has to be scoped to agy's own failures now.
    assert.match(source, /agy itself is missing or errors out immediately/);
    assert.match(source, /not a Claude Code denial/);
  });
}

test("rescue command points a plan-only run at the continue command", () => {
  const source = read("commands/rescue.md");
  assert.match(source, /plan ending in a question/);
  assert.match(source, /no edits/);
  assert.match(source, /\/agy:continue <conversation_id>/);
});

test("rescue agent returns a Claude Code denial verbatim without retrying", () => {
  const source = read("agents/agy-rescue.md");
  assert.match(source, /denied by the Claude Code auto mode classifier/);
  assert.match(source, /Do not reword the task to get past it, do not retry/);
});

test("setup command warns that a ready agy can still be denied in auto mode", () => {
  const source = read("commands/setup.md");
  assert.match(source, /auto mode classifier/);
  assert.match(source, /`\/permissions`, not this command/);
});

test("quota command keeps the argv form and refuses to spend quota on a retry", () => {
  const source = read("commands/quota.md");
  // Slash commands are answered by the CLI itself and are unavailable under
  // --input-format stream-json, so this one call stays on the classic form.
  assert.match(source, /slash commands are answered by the CLI itself/i);
  assert.match(source, /would spend quota/);
});

// A backgrounded /agy:adversarial-review is a Bash task, not an agy-rescue
// subagent, so a status command that only calls ListAgents reports nothing and
// the review looks like it never started.
test("status and result cover both kinds of background run", () => {
  for (const name of ["status.md", "result.md"]) {
    const source = read(`commands/${name}`);
    assert.match(source, /agy:agy-rescue/, `${name} does not mention subagent runs`);
    assert.match(source, /companion/i, `${name} does not mention backgrounded companion runs`);
  }
  assert.match(read("commands/status.md"), /`ListAgents` will not list it/);
});

test("adversarial-review does not route its background path through the subagent", () => {
  const source = read("commands/adversarial-review.md");
  // The subagent passes task text as an argument, which is the size limit the
  // companion exists to avoid.
  assert.match(source, /Do not route the background path through the `agy:agy-rescue` subagent/);
  assert.match(source, /run_in_background: true/);
});

// Issue #21: the setup guidance named only `command(...)`, and the probe only
// exercised a command, so a read denial passed setup and failed the first
// delegation. The command has to relay the denied action names the script now
// reports and the read rule next to the command rule.
test("setup command relays denied actions and names the read rule", () => {
  const source = read("commands/setup.md");
  assert.match(source, /deniedActions/);
  assert.match(source, /read_file\(\*\)/);
  assert.match(source, /three agy probes/);
});

test("setup command makes the settings edit the user's own manual step", () => {
  const source = read("commands/setup.md");
  assert.match(source, /by hand/);
  assert.match(source, /do not attempt/i);
});

test("rescue agent returns stderr when any action was denied, not only on an empty response", () => {
  const source = read("agents/agy-rescue.md");
  assert.match(source, /denied_actions/);
});

test("rescue agent drops --effort once when the model rejects it", () => {
  const source = read("agents/agy-rescue.md");
  // The rejection happens before any model call and costs no quota, so the one
  // permitted retry is the run without the flag. Anything else stays one call.
  assert.match(source, /--effort is not supported for model/);
  assert.match(source, /without `--effort`/);
});

test("rescue command treats denied actions as a failed run", () => {
  const source = read("commands/rescue.md");
  assert.match(source, /denied_actions/);
});

// F89. On agy 1.2.10 a bare print-mode run started in the repo resolves its
// workspace to ~/.gemini/antigravity-cli/scratch, so relative commands and
// writes land there. The repo has to be added explicitly, by absolute path.
test("rescue agent adds the repository root as the agy workspace", () => {
  const agent = read("agents/agy-rescue.md");
  assert.match(agent, /--add-dir "\$root"/);
  assert.match(agent, /root=\$\(git rev-parse --show-toplevel 2>\/dev\/null\) \|\| root=\$PWD/);
  const runtime = read("skills/agy-cli-runtime/SKILL.md");
  assert.match(runtime, /--add-dir "\$root"/);
  assert.match(runtime, /scratch/);
});

// F88. Since agy 1.2.9 a headless run holds its finished result until the
// --print-timeout deadline while any background task is still running, and
// agy moves every command over 10 s into the background.
test("rescue agent tells agy to leave nothing running, on every run", () => {
  const agent = read("agents/agy-rescue.md");
  assert.match(agent, /nothing you started is still running/);
  assert.match(agent, /including a continuation/);
  // Cleanup by name would take out Claude Code itself, which is a node process.
  assert.match(agent, /never use pkill, killall, or kill by name/);
  const prompting = read("skills/agy-prompting/SKILL.md");
  assert.match(prompting, /one-shot mode \(no watch mode\)/);
  assert.match(prompting, /print timeout/i);
});

// agy's own deadline has to be the cap: when the Bash timeout passes first,
// Claude Code backgrounds the call instead of returning.
test("rescue print timeout leaves margin under the Bash timeout", () => {
  const agent = read("agents/agy-rescue.md");
  assert.match(agent, /--print-timeout 8m/);
  assert.match(agent, /590000/);
  assert.doesNotMatch(agent, /--print-timeout 9m/);
});

// F90. Retyping agy's whole JSON through the subagent model cost about 3.5 s
// per KB after agy had already exited.
test("rescue agent writes the agy result to a file and returns a summary", () => {
  const agent = read("agents/agy-rescue.md");
  assert.match(agent, /mktemp/);
  assert.match(agent, /AGY_RESCUE_SUMMARY/);
  assert.doesNotMatch(agent, /Return the full JSON stdout of the `agy` command exactly as-is/);
  for (const name of ["rescue.md", "continue.md", "result.md", "status.md"]) {
    const source = read(`commands/${name}`);
    assert.match(source, /result_file/, `${name} does not read the result file`);
    assert.ok(
      parseFrontmatter(source)["allowed-tools"].split(/,\s*/).includes("Read"),
      `${name} cannot read the result file without the Read tool`
    );
  }
  const handling = read("skills/agy-result-handling/SKILL.md");
  assert.match(handling, /result_file/);
  // A stderr line can imitate the summary, so the caller checks the path.
  assert.match(handling, /last line that starts with `AGY_RESCUE_SUMMARY `/);
  assert.match(handling, /agy-rescue-` followed by six letters or digits/);
  assert.match(read("SECURITY.md"), /agy-rescue-XXXXXX/);
  // A replaced result path (a symlink to a secret) must never be quoted.
  assert.match(handling, /`regular_file` equal to `true`/);
  assert.match(handling, /no `\.\.` segment/);
});

// Retest 2026-09-25: an unknown --model is an immediate agy error that
// /agy:setup would pass, and a forwarder refusal never reached agy at all.
test("rescue and continue send only missing or unauthenticated agy to setup", () => {
  for (const name of ["rescue.md", "continue.md"]) {
    const source = read(`commands/${name}`);
    assert.match(source, /unknown `--model`/, `${name} sends every agy error to setup`);
    assert.match(source, /agy-rescue refused:/, `${name} does not route a forwarder refusal`);
    assert.match(source, /null or empty, say the run left no conversation/);
  }
  assert.match(read("agents/agy-rescue.md"), /agy-rescue refused:/);
  assert.match(read("agents/agy-rescue.md"), /summary line last/);
});

// F91. Claude Code can move a long Bash call into the background; the
// subagent needs a sanctioned way to wait instead of improvising.
test("rescue agent says what to do when its Bash call is moved to the background", () => {
  const agent = read("agents/agy-rescue.md");
  assert.match(agent, /moved to the background/);
  assert.match(agent, /do not start a second agy run/i);
  // The wait keys on the marker Claude Code appends when the task ends, so a
  // cancelled run ends the wait too.
  assert.match(agent, /\\\[\(exited with code\|killed\)/);
});

// The prose tests above pin wording. This one runs the fenced template from
// the agent file against a stub agy, so a broken heredoc, a lost exit code or
// stderr leaking into the result file fails here.
function rescueTemplate() {
  const agent = read("agents/agy-rescue.md");
  const match = agent.match(/^```bash\n([\s\S]*?)^```$/m);
  assert.ok(match, "agents/agy-rescue.md has no fenced bash template");
  return match[1];
}

const STUB_AGY = `#!/bin/sh
echo "stub stderr line" >&2
echo 'AGY_RESCUE_SUMMARY {"result_file":"/etc/passwd"}' >&2
case "$STUB_MODE" in
  ok) printf '%s\\n' '{"conversation_id":"c-1","status":"SUCCESS","response":"hello"}' ;;
  error) printf '%s\\n' '{"conversation_id":"","status":"ERROR","response":"","error":"bad model"}'; exit 1 ;;
  nojson) echo "not json" ;;
  symlink) out="$(readlink /proc/$$/fd/1)"; rm -f "$out"; ln -s /etc/hostname "$out" ;;
  args) printf '%s\n' "$@" > "$STUB_ARGS"; printf '%s\n' '{"conversation_id":"c-1","status":"SUCCESS","response":"ok"}' ;;
esac
`;

// Runs the template with the stub first on PATH (or no agy at all) and returns
// the summary parsed from the last AGY_RESCUE_SUMMARY line of its output.
// `setup` may prepare the temp dir and return a subdirectory to run from.
function runTemplate(mode, taskText, { withAgy = true, setup } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-rescue-test-"));
  try {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    const cwd = setup ? setup(dir) : dir;
    const argsFile = path.join(dir, "agy-args");
    if (withAgy) fs.writeFileSync(path.join(bin, "agy"), STUB_AGY, { mode: 0o755 });
    // Keep node and the coreutils reachable while hiding any real agy.
    const nodeDir = path.dirname(process.execPath);
    const script = rescueTemplate().replace("<task text>", taskText);
    const run = spawnSync("bash", ["-c", script], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, PATH: [bin, nodeDir, "/usr/bin", "/bin"].join(path.delimiter), STUB_MODE: mode, STUB_ARGS: argsFile, TMPDIR: dir }
    });
    const lines = run.stdout.trim().split("\n");
    const last = lines[lines.length - 1];
    assert.ok(last.startsWith("AGY_RESCUE_SUMMARY "), `summary is not the last output line: ${run.stdout}${run.stderr}`);
    const summary = JSON.parse(last.slice("AGY_RESCUE_SUMMARY ".length));
    let fileText = null;
    try { fileText = fs.readFileSync(summary.result_file, "utf8"); } catch {}
    let args = null;
    try { args = fs.readFileSync(argsFile, "utf8").split("\n"); } catch {}
    return { run, summary, fileText, dir, args };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const HAS_BASH = process.platform !== "win32" && spawnSync("bash", ["-c", "true"]).status === 0;
const HAS_PROC = fs.existsSync("/proc/self/fd");

test("rescue template summarises a successful run from the result file", { skip: !HAS_BASH }, () => {
  const { run, summary, fileText, dir } = runTemplate("ok", "say \"hi\" and it's $HOME `x`");
  assert.equal(summary.exit_code, 0);
  assert.equal(summary.conversation_id, "c-1");
  assert.equal(summary.status, "SUCCESS");
  assert.equal(summary.response_chars, 5);
  assert.equal(summary.regular_file, true);
  assert.match(path.basename(summary.result_file), /^agy-rescue-[A-Za-z0-9]{6}$/);
  assert.equal(path.dirname(summary.result_file), path.resolve(dir));
  // stdout only: the stub's stderr, including its fake summary, stays out of
  // the file and comes before the real summary in the tool output.
  assert.doesNotMatch(fileText, /stub stderr|AGY_RESCUE_SUMMARY/);
  assert.match(run.stdout, /stub stderr line/);
  assert.match(run.stdout, /^agy-rescue result file: /m);
  assert.ok(run.stdout.indexOf("/etc/passwd") < run.stdout.lastIndexOf("AGY_RESCUE_SUMMARY "));
});

test("rescue template keeps the exit code and error of a failed run", { skip: !HAS_BASH }, () => {
  const { summary } = runTemplate("error", "task");
  assert.equal(summary.exit_code, 1);
  assert.equal(summary.status, "ERROR");
  assert.equal(summary.error, "bad model");
  assert.equal(summary.conversation_id, null);
  assert.equal(summary.response_chars, 0);
});

test("rescue template flags a result path replaced by a symlink", { skip: !HAS_BASH || !HAS_PROC }, () => {
  const { summary } = runTemplate("symlink", "task");
  assert.equal(summary.regular_file, false);
});

test("rescue template reports a missing agy as exit 127 with an empty file", { skip: !HAS_BASH }, () => {
  const { summary, fileText } = runTemplate("ok", "task", { withAgy: false });
  assert.equal(summary.exit_code, 127);
  assert.equal(fileText, "");
  assert.equal(summary.status, null);
});

test("rescue template reports non-JSON stdout as a null status", { skip: !HAS_BASH }, () => {
  const { summary, fileText } = runTemplate("nojson", "task");
  assert.equal(summary.status, null);
  assert.equal(fileText.trim(), "not json");
});

// F96. The workspace agy gets is the repository root, the same root the
// companion uses, even when the subagent's shell sits in a subdirectory.
// Outside a git repository the template falls back to the current directory.
const HAS_GIT = spawnSync("git", ["--version"]).status === 0;

function addDirOf(args) {
  const at = args.indexOf("--add-dir");
  assert.ok(at >= 0, `agy got no --add-dir: ${args.join(" ")}`);
  return args[at + 1];
}

test("rescue template adds the git top level from a subdirectory", { skip: !HAS_BASH || !HAS_GIT }, () => {
  let root;
  const { run, args } = runTemplate("args", "task", {
    setup: (dir) => {
      root = path.join(dir, "repo");
      fs.mkdirSync(path.join(root, "sub"), { recursive: true });
      assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
      root = fs.realpathSync(root);
      return path.join(root, "sub");
    }
  });
  assert.equal(addDirOf(args), root);
  assert.doesNotMatch(run.stdout, /fatal:/);
});

test("rescue template falls back to the current directory outside git", { skip: !HAS_BASH }, () => {
  const { run, args, dir } = runTemplate("args", "task");
  assert.equal(path.resolve(addDirOf(args)), path.resolve(dir));
  // git's "not a git repository" error must not leak into the tool output.
  assert.doesNotMatch(run.stdout, /fatal:/);
});

// F22. The setup report now carries the user's agy permission mode, which is
// what actually decides whether a probe can pass. The command has to relay it.
test("setup command reports the agy tool permission mode", () => {
  const source = read("commands/setup.md");
  assert.match(source, /agySettings/);
  assert.match(source, /toolPermission/);
  for (const mode of ["always-proceed", "request-review", "proceed-in-sandbox", "strict"]) {
    assert.ok(source.includes(mode), `setup.md does not name the ${mode} mode`);
  }
});

test("setup command warns that proceed-in-sandbox does not work with this plugin", () => {
  const source = read("commands/setup.md");
  assert.match(source, /--sandbox/);
  assert.match(source, /does not pass/i);
});

test("setup command says an unrecognised mode falls back silently", () => {
  const source = read("commands/setup.md");
  assert.match(source, /declaredToolPermission/);
  assert.match(source, /silently|without an error/i);
});

// A model that strips --wait/--background before forwarding must not also
// drop --allow-secret with them, or the argument-hint advertises an unblock
// mechanism for a known-fixture false positive that silently does nothing.
// Both review commands must also render a scan hit as file:line, not the
// raw offset into the diff text that predated this.
test("the review commands forward --allow-secret and render a hit as file:line", () => {
  const adversarial = read("commands/adversarial-review.md");
  assert.match(adversarial, /Strip only those two flags[^\n]*--allow-secret/);
  assert.match(adversarial, /adversarial-review "[^"\n]*--allow-secret/);
  for (const name of ["review.md", "adversarial-review.md"]) {
    assert.match(
      read(`commands/${name}`),
      /<file>:<line> <kind>/,
      `${name} does not render a hit as file:line`
    );
  }
});

// F21. A denied delegation is worth one resume: the conversation survives, and
// the model finishes under a stated constraint. The gate is deliberately left
// out, because a stop-time review that lost its file reads has nothing to say
// and a second turn would only double the wait before the block.
test("the companion delegates through the denial-recovering runner", () => {
  const source = read("scripts/agy-companion.mjs");
  assert.match(source, /runPromptWithDenialRecovery\(/);
  assert.ok(
    !/\brunPrompt\(/.test(source),
    "the companion still calls runPrompt directly, so a denial there is abandoned"
  );
  // Both delegation paths, the reviews and the handoff, report what happened.
  // Both name the result of the runner call `out` now, not `run`, since
  // `run` itself is the injectable low-level runner forwarded into
  // `runIsolated`/`runPromptWithDenialRecovery`, and reusing the name for the
  // result would shadow the very function being injected.
  assert.match(source, /recovery: out\.recovery/);
});

test("the stop gate does not resume a denied review", () => {
  const source = read("scripts/stop-review-gate-hook.mjs");
  assert.ok(
    !/runPromptWithDenialRecovery/.test(source),
    "the stop gate resumes a denied review, doubling the wait before it blocks"
  );
});

// F93. Setup warns, without refusing, when agy is newer than the version the
// CLI contract was last verified on. The command has to relay that warning and
// keep it from reading as a failure.
test("setup command relays the newer-than-verified warning without failing setup", () => {
  const source = read("commands/setup.md");
  assert.match(source, /agy\.newerThanVerified/);
  assert.match(source, /agy\.verifiedVersion/);
  assert.match(source, /`ready` stays true/);
});

// F92. Wrapping every rescue in a <verification_loop> and a stop-and-ask
// <action_safety> cost +55% input tokens on a one-line fix, ran tests nobody
// asked for, and invited plan-only endings that each cost an /agy:continue
// round trip. The loop is now conditional and names its command and
// directory; routine edits are agy's call. The softer wording must not tell
// agy to skip asking or confirming: that phrasing trips the Claude Code
// classifier (see the agy-result-handling skill).
function promptingBullet(source, tag) {
  const match = source.match(new RegExp(`^- \`<${tag}>\`:[\\s\\S]*?(?=\\n- |\\n\\n)`, "m"));
  assert.ok(match, `prompting skill has no <${tag}> bullet`);
  return match[0];
}

test("the prompting skill includes the verification loop only when tests are relevant", () => {
  const prompting = read("skills/agy-prompting/SKILL.md");
  const loop = promptingBullet(prompting, "verification_loop");
  assert.doesNotMatch(loop, /required for fixes and implementation/);
  assert.match(loop, /only when tests are relevant to the request/);
  assert.match(loop, /name the test command and the directory to run it from/);
  assert.match(loop, /rather than inventing one/);
  assert.match(prompting, /`verification_loop` only when tests are relevant/);
});

test("the prompting skill lets routine edits through without inviting a stop-and-ask", () => {
  const safety = promptingBullet(read("skills/agy-prompting/SKILL.md"), "action_safety");
  assert.doesNotMatch(safety, /stop to ask when the task turns out to need a decision/);
  assert.match(safety, /Routine choices inside that scope/);
  assert.match(safety, /changes scope, public behaviour, or dependencies/);
  assert.doesNotMatch(safety, /without (asking|confirm)|skip[^.]*confirm/i);
});

test("the rescue agent adds a verification loop only for relevant tests, with command and directory", () => {
  const agent = read("agents/agy-rescue.md");
  assert.doesNotMatch(agent, /for fixes a `<verification_loop>` and `<action_safety>`/);
  assert.match(agent, /`<verification_loop>` only when tests are relevant to the request/);
  assert.match(agent, /name that command and the directory to run it from/);
  assert.match(agent, /Never invent a test command/);
  assert.doesNotMatch(agent, /without (asking|confirm)|skip[^.]*confirm/i);
});
