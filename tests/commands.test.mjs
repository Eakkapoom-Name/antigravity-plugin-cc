import test from "node:test";
import assert from "node:assert/strict";

import { listMarkdown, parseFrontmatter, read } from "./helpers.mjs";

const COMMANDS = listMarkdown("commands");

// Commands that deliberately take no arguments.
const NO_ARGUMENT_COMMANDS = new Set(["quota.md"]);

test("every command file exists and is discovered", () => {
  assert.deepEqual(COMMANDS, [
    "adversarial-review.md",
    "cancel.md",
    "continue.md",
    "quota.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md",
    "transfer.md"
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
for (const name of ["review.md", "adversarial-review.md", "transfer.md", "quota.md"]) {
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
