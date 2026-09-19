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
    const relative = resolveOutputPath("../outside.md", root);
    assert.equal(relative.ok, false);
    assert.match(relative.reason, /inside the workspace/);
    // An absolute path whose parent exists on every OS and sits outside the
    // scratch root. A literal /tmp/... resolves to C:\tmp on Windows, where
    // that directory does not exist, so the missing-parent check would fire
    // first and this test would stop testing containment.
    const absolute = resolveOutputPath(path.join(os.tmpdir(), "outside.md"), root);
    assert.equal(absolute.ok, false);
    assert.match(absolute.reason, /inside the workspace/);
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

// A bare `catch {}` around the occupancy lstatSync would read any error the
// same way as "nothing is there", including one that has nothing to do with
// occupancy. A null byte makes lstatSync throw ERR_INVALID_ARG_VALUE rather
// than ENOENT; letting that through as "ok: true" would only be caught later
// by the write itself, after a whole agy run had already been spent. This
// has to be refused here, before any run starts.
test("a path with a null byte is refused before any run starts", () => {
  const root = scratch();
  try {
    const out = resolveOutputPath("docs/a\0b.md", root);
    assert.equal(out.ok, false);
    assert.match(out.reason, /could not be checked/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
