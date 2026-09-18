import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { strayBackupFiles } from "../scripts/prepack-check.mjs";
import { ROOT, readJson } from "./helpers.mjs";

// F17. `npm pack` force-includes anything matching README*, so a README.md.bak
// left by an editing session ships in the tarball. Neither a `files` negation
// nor .npmignore excludes it (both tried), so the guard is a prepack script
// that refuses to pack while one exists.
test("stray backup files are recognised by name", () => {
  assert.deepEqual(
    strayBackupFiles(["LICENSE", "README.md", "README.md.bak", "package.json", "notes.bak2", "keep.bak.md"]),
    ["README.md.bak", "notes.bak2"]
  );
  assert.deepEqual(strayBackupFiles(["README.md", "LICENSE"]), []);
  assert.deepEqual(strayBackupFiles([]), []);
});

test("package.json runs the guard before packing", () => {
  const pkg = readJson("package.json");
  assert.equal(pkg.scripts.prepack, "node scripts/prepack-check.mjs");
});

function scratchPackage(extraFiles) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-prepack-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"x","version":"0.0.0"}\n');
  fs.writeFileSync(path.join(dir, "README.md"), "# x\n");
  for (const name of extraFiles) {
    fs.writeFileSync(path.join(dir, name), "stale\n");
  }
  return dir;
}

test("the guard refuses a tree holding a README backup and names it", () => {
  const dir = scratchPackage(["README.md.bak"]);
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", "prepack-check.mjs"), dir], {
    encoding: "utf8"
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /README\.md\.bak/);
});

test("the guard lets a clean tree pack", () => {
  const dir = scratchPackage([]);
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", "prepack-check.mjs"), dir], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
});

test("the tarball carries the licence file", () => {
  const files = readJson("package.json").files;
  assert.ok(files.includes("LICENSE"), "package.json files lacks LICENSE");
});
