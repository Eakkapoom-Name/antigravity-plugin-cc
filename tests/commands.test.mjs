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

// Commands that stage a brief or a diff in a temp file, feed it to agy through
// `$(cat ...)`, and delete it afterwards. Derived from the bodies rather than
// hardcoded, so a command that grows a temp-file step is caught rather than
// silently skipped.
const TEMP_FILE_COMMANDS = COMMANDS.filter((name) =>
  /temp (?:brief |diff )?file/i.test(read(`commands/${name}`))
);

test("the commands with temp file steps are the ones expected", () => {
  // Equality in both directions: a new one must be added deliberately, and a
  // step removed from an existing one must not go unnoticed either.
  assert.deepEqual(TEMP_FILE_COMMANDS, [
    "adversarial-review.md",
    "review.md",
    "transfer.md"
  ]);
});

for (const name of TEMP_FILE_COMMANDS) {
  test(`${name} grants the tools its temp file steps actually need`, () => {
    const fields = parseFrontmatter(read(`commands/${name}`));
    const tools = fields["allowed-tools"].split(",").map((entry) => entry.trim());
    assert.ok(tools.includes("Write"), `${name} writes a temp file but does not grant Write`);
    assert.ok(
      tools.some((tool) => /^Bash\(rm:/.test(tool)),
      `${name} deletes its temp file but grants no scoped rm`
    );
    // The brief or diff reaches agy through a `$(cat <file>)` substitution
    // inside the agy command line, so cat is part of the call, not incidental.
    assert.ok(
      tools.some((tool) => /^Bash\(cat:/.test(tool)),
      `${name} interpolates its temp file with cat but grants no scoped cat`
    );
  });
}

test("setup command runs the readiness script with a timeout that outlasts both probes", () => {
  const source = read("commands/setup.md");
  assert.match(source, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/agy-setup\.mjs/);
  // Two probes at a 3 minute spawn timeout each: the default 120000 ms Bash
  // timeout kills the script before it prints its report.
  const timeout = source.match(/Bash `timeout` of `(\d+)` ms/);
  assert.ok(timeout, "setup.md does not state an explicit Bash timeout");
  assert.ok(
    Number(timeout[1]) > 390000,
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

test("setup command documents the gate toggle contract", () => {
  const source = read("commands/setup.md");
  assert.match(source, /\.claude\/agy\.local\.md/);
  assert.match(source, /stop_review_gate:\s*true/);
  assert.match(source, /gate on/);
  assert.match(source, /gate off/);
  assert.match(source, /gate status/);
});

for (const name of ["review.md", "adversarial-review.md"]) {
  test(`${name} stays review-only and stops before fixing`, () => {
    const source = read(`commands/${name}`);
    assert.match(source, /read-only/i);
    assert.match(source, /STOP/);
    assert.match(source, /before touching a single file/i);
    // A review must never hand agy a write mode.
    assert.match(source, /no `--mode` flag/);
  });
}

for (const name of ["rescue.md", "continue.md"]) {
  test(`${name} delegates through the Agent tool, not the Skill tool`, () => {
    const source = read(`commands/${name}`);
    assert.match(source, /subagent_type:\s*"agy:agy-rescue"/);
    assert.match(source, /not a skill/i);
    assert.match(source, /Do not call it through the `Skill` tool/);
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

test("quota command runs exactly one agy call", () => {
  const source = read("commands/quota.md");
  assert.match(source, /Run exactly one command/);
});
