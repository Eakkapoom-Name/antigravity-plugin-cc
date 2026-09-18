import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveOutputPath } from "../scripts/lib/output-path.mjs";

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-out-"));
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "existing.md"), "x\n");
  return root;
}

test("a relative path inside the workspace resolves", () => {
  const root = scratch();
  try {
    const out = resolveOutputPath("docs/report.md", root);
    assert.equal(out.ok, true);
    assert.equal(out.path, path.join(fs.realpathSync(root), "docs", "report.md"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a path that escapes the workspace is refused", () => {
  const root = scratch();
  try {
    assert.equal(resolveOutputPath("../outside.md", root).ok, false);
    assert.equal(resolveOutputPath("/tmp/outside.md", root).ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a missing parent directory is refused", () => {
  const root = scratch();
  try {
    const out = resolveOutputPath("nope/report.md", root);
    assert.equal(out.ok, false);
    assert.match(out.reason, /parent/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an existing file is refused", () => {
  const root = scratch();
  try {
    const out = resolveOutputPath("docs/existing.md", root);
    assert.equal(out.ok, false);
    assert.match(out.reason, /exists/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a symlinked parent that points outside is refused", () => {
  const root = scratch();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agy-outside-"));
  try {
    fs.symlinkSync(outside, path.join(root, "link"));
    assert.equal(resolveOutputPath("link/report.md", root).ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// existsSync follows a symlink and reports false for one that points at
// nothing, which would let a dangling symlink through as if the name were
// free. writeFileSync's "wx" flag then refuses to open through it (O_EXCL),
// so without this check the run would spend its full timeout before failing
// on the write instead of being refused up front.
test("a dangling symlink at the target is refused", () => {
  const root = scratch();
  try {
    fs.symlinkSync(path.join(root, "docs", "nowhere.md"), path.join(root, "docs", "dangling.md"));
    const out = resolveOutputPath("docs/dangling.md", root);
    assert.equal(out.ok, false);
    assert.match(out.reason, /exists/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
