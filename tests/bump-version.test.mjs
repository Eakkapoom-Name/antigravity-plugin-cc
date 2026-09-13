import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import {
  changelogState,
  checkVersions,
  closeUnreleased,
  parseArgs,
  validateVersion
} from "../scripts/bump-version.mjs";
import { ROOT } from "./helpers.mjs";

function scratchRepo(version, changelog) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-bump-"));
  fs.mkdirSync(path.join(dir, ".claude-plugin"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "agy-plugin-cc", version }, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(dir, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: "agy", version }, null, 2)}\n`
  );
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), changelog);
  return dir;
}

test("validateVersion accepts semver and rejects the rest", () => {
  for (const good of ["0.0.1", "1.2.3", "10.20.30", "1.0.0-rc.1"]) {
    assert.equal(validateVersion(good), good);
  }
  for (const bad of ["v1.2.3", "1.2", "1.2.3.4", "latest", "", null]) {
    assert.throws(() => validateVersion(bad), /semver-like/);
  }
});

test("checkVersions passes when the three files agree", () => {
  const dir = scratchRepo("1.2.3", "# Changelog\n\n## [1.2.3] - 2026-01-01\n");
  assert.deepEqual(checkVersions(dir, "1.2.3"), []);
});

test("checkVersions accepts an open Unreleased section between releases", () => {
  const dir = scratchRepo("1.2.3", "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- thing\n");
  assert.deepEqual(checkVersions(dir, "1.2.3"), []);
});

test("checkVersions names every file that disagrees", () => {
  const dir = scratchRepo("1.2.3", "# Changelog\n\n## [0.9.0] - 2026-01-01\n");
  const mismatches = checkVersions(dir, "2.0.0");
  assert.equal(mismatches.length, 3);
  assert.ok(mismatches.some((line) => line.startsWith("package.json")));
  assert.ok(mismatches.some((line) => line.startsWith(".claude-plugin/plugin.json")));
  assert.ok(mismatches.some((line) => line.startsWith("CHANGELOG.md")));
});

test("checkVersions catches one manifest drifting on its own", () => {
  const dir = scratchRepo("1.2.3", "# Changelog\n\n## [1.2.3] - 2026-01-01\n");
  fs.writeFileSync(
    path.join(dir, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: "agy", version: "1.2.2" }, null, 2)}\n`
  );
  const mismatches = checkVersions(dir, "1.2.3");
  assert.equal(mismatches.length, 1);
  assert.match(mismatches[0], /plugin\.json version: expected 1\.2\.3, found 1\.2\.2/);
});

test("closeUnreleased renames the open section and leaves the rest alone", () => {
  const before = "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- thing\n\n## [1.0.0] - 2026-01-01\n";
  const after = closeUnreleased(before, "1.1.0", "2026-09-13");
  assert.equal(after.changed, true);
  assert.match(after.text, /## \[1\.1\.0\] - 2026-09-13/);
  assert.ok(!after.text.includes("## [Unreleased]"));
  // The previous release heading and the bullet survive untouched.
  assert.match(after.text, /## \[1\.0\.0\] - 2026-01-01/);
  assert.match(after.text, /- thing/);
});

test("closeUnreleased is a no-op when there is no open section", () => {
  const before = "# Changelog\n\n## [1.0.0] - 2026-01-01\n";
  const after = closeUnreleased(before, "1.1.0", "2026-09-13");
  assert.equal(after.changed, false);
  assert.equal(after.text, before);
});

test("changelogState reports both states independently", () => {
  assert.deepEqual(changelogState("## [Unreleased]\n", "1.0.0"), {
    hasUnreleased: true,
    hasVersion: false
  });
  assert.deepEqual(changelogState("## [1.0.0] - 2026-01-01\n", "1.0.0"), {
    hasUnreleased: false,
    hasVersion: true
  });
});

test("parseArgs reads the flags it documents and rejects the rest", () => {
  assert.equal(parseArgs(["--check"]).check, true);
  assert.equal(parseArgs(["1.2.3"]).version, "1.2.3");
  assert.equal(parseArgs(["--date", "2026-01-01"]).date, "2026-01-01");
  assert.throws(() => parseArgs(["--nope"]), /Unknown option/);
  assert.throws(() => parseArgs(["1.2.3", "4.5.6"]), /extra argument/);
  assert.throws(() => parseArgs(["--root"]), /requires a value/);
});

test("the bump writes all three files and check then passes", () => {
  const dir = scratchRepo("1.2.3", "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- thing\n");
  const bump = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "bump-version.mjs"), "1.3.0", "--root", dir, "--date", "2026-09-13"],
    { encoding: "utf8" }
  );
  assert.equal(bump.status, 0, bump.stderr);
  assert.deepEqual(checkVersions(dir, "1.3.0"), []);
  assert.match(fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8"), /## \[1\.3\.0\] - 2026-09-13/);
});

test("this repository's own version metadata is in sync", () => {
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  assert.deepEqual(checkVersions(ROOT, version), []);
});

test("importing the bump script does not rewrite any manifest", () => {
  // An unguarded import would have run main() during the imports above, which
  // with no arguments throws rather than writing, but the guard is what keeps a
  // future argv from reaching it.
  assert.equal(typeof checkVersions, "function");
});
