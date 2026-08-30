import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import { ROOT, listMarkdown, parseFrontmatter, read, readJson } from "./helpers.mjs";

test("plugin manifest is valid and named agy", () => {
  const manifest = readJson(".claude-plugin/plugin.json");
  assert.equal(manifest.name, "agy");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.description);
});

test("marketplace manifest lists the plugin", () => {
  const marketplace = readJson(".claude-plugin/marketplace.json");
  assert.ok(Array.isArray(marketplace.plugins));
  const entry = marketplace.plugins.find((plugin) => plugin.name === "agy");
  assert.ok(entry, "marketplace.json has no agy entry");
  assert.ok(entry.source);
});

test("plugin and package versions stay in step", () => {
  const manifest = readJson(".claude-plugin/plugin.json");
  const pkg = readJson("package.json");
  assert.equal(manifest.version, pkg.version);
});

test("changelog documents the current version", () => {
  const manifest = readJson(".claude-plugin/plugin.json");
  assert.match(read("CHANGELOG.md"), new RegExp(`\\b${manifest.version.replace(/\./g, "\\.")}\\b`));
});

test("hooks.json declares the stop gate and points at a script that exists", () => {
  const hooks = readJson("hooks/hooks.json");
  const stop = hooks.hooks?.Stop;
  assert.ok(Array.isArray(stop) && stop.length > 0, "no Stop hook declared");
  const entries = stop.flatMap((matcher) => matcher.hooks ?? []);
  assert.ok(entries.length > 0, "Stop matcher declares no hooks");
  for (const entry of entries) {
    assert.equal(entry.type, "command");
    assert.match(entry.command, /\$\{CLAUDE_PLUGIN_ROOT\}/);
    assert.ok(entry.timeout > 0, "hook has no positive timeout");
    const script = entry.command.match(/scripts\/([a-z0-9-]+\.mjs)/);
    assert.ok(script, "hook command does not name a plugin script");
    assert.ok(
      fs.existsSync(path.join(ROOT, "scripts", script[1])),
      `hook points at missing script ${script[1]}`
    );
  }
});

test("the stop hook timeout outlasts the agy print timeout it uses", () => {
  const hooks = readJson("hooks/hooks.json");
  const hookTimeoutSeconds = hooks.hooks.Stop[0].hooks[0].timeout;
  const source = read("scripts/stop-review-gate-hook.mjs");
  const spawnTimeout = source.match(/SPAWN_TIMEOUT_MS\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/);
  assert.ok(spawnTimeout, "stop hook does not define SPAWN_TIMEOUT_MS");
  const spawnSeconds =
    (Number(spawnTimeout[1]) * Number(spawnTimeout[2]) * Number(spawnTimeout[3])) / 1000;
  assert.ok(
    hookTimeoutSeconds > spawnSeconds,
    `hook timeout ${hookTimeoutSeconds}s does not outlast the ${spawnSeconds}s spawn timeout`
  );
});

test("every agent declares a name, description, and its skills exist", () => {
  for (const name of listMarkdown("agents")) {
    const fields = parseFrontmatter(read(`agents/${name}`));
    assert.ok(fields, `${name} has no frontmatter`);
    assert.ok(fields.name, `${name} has no name`);
    assert.ok(fields.description, `${name} has no description`);
    const skills = (fields.skills ?? "")
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((skill) => skill.trim())
      .filter(Boolean);
    for (const skill of skills) {
      assert.ok(
        fs.existsSync(path.join(ROOT, "skills", skill, "SKILL.md")),
        `${name} references missing skill ${skill}`
      );
    }
  }
});

test("every skill has frontmatter with a name and description", () => {
  for (const skill of fs.readdirSync(path.join(ROOT, "skills"))) {
    const fields = parseFrontmatter(read(path.join("skills", skill, "SKILL.md")));
    assert.ok(fields, `${skill} SKILL.md has no frontmatter`);
    assert.equal(fields.name, skill, `${skill} SKILL.md name does not match its directory`);
    assert.ok(fields.description, `${skill} SKILL.md has no description`);
  }
});

test("review output schema is valid JSON with the documented shape", () => {
  const schema = readJson("schemas/review-output.schema.json");
  assert.ok(schema.$schema);
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    "findings",
    "next_steps",
    "summary",
    "verdict"
  ]);
});

test("every plugin script parses as an ES module", () => {
  const scripts = fs
    .readdirSync(path.join(ROOT, "scripts"))
    .filter((name) => name.endsWith(".mjs"));
  assert.ok(scripts.length > 0);
  for (const script of scripts) {
    // Parse without running: these scripts spawn agy when executed.
    const check = spawnSync(process.execPath, ["--check", path.join(ROOT, "scripts", script)], {
      encoding: "utf8"
    });
    assert.equal(check.status, 0, `${script} failed to parse:\n${check.stderr}`);
  }
});
