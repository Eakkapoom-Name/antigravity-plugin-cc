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
}

test("quota command runs exactly one agy call", () => {
  const source = read("commands/quota.md");
  assert.match(source, /Run exactly one command/);
});
