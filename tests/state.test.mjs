import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  defaultState,
  gateEnabled,
  loadState,
  readLegacyGate,
  resolveStateDir,
  resolveStateFile,
  PLUGIN_NAMESPACE,
  setGate
} from "../scripts/lib/state.mjs";
import { resolveWorkspaceRoot } from "../scripts/lib/workspace.mjs";
import { main } from "../scripts/agy-companion.mjs";

// Each test gets its own CLAUDE_PLUGIN_DATA so nothing touches real state and
// the tests cannot see each other's writes.
function withPluginData(run) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-data-"));
  process.env.CLAUDE_PLUGIN_DATA = dir;
  try {
    return run(dir);
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

function scratchRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-repo-"));
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(root, "src", "deep"), { recursive: true });
  return root;
}

test("the workspace root is found from any depth inside the repository", () => {
  const root = scratchRepo();
  const real = fs.realpathSync(root);
  assert.equal(fs.realpathSync(resolveWorkspaceRoot(root)), real);
  assert.equal(fs.realpathSync(resolveWorkspaceRoot(path.join(root, "src"))), real);
  assert.equal(fs.realpathSync(resolveWorkspaceRoot(path.join(root, "src", "deep"))), real);
});

test("a directory outside any repository resolves to itself", () => {
  const loose = fs.mkdtempSync(path.join(os.tmpdir(), "agy-loose-"));
  // Nothing above a temp dir has a .git, so the walk hits the filesystem root
  // and falls back rather than throwing or climbing forever.
  assert.equal(resolveWorkspaceRoot(loose), path.resolve(loose));
});

// This is F6: the hook resolved its cwd from the Stop payload and setup from
// the environment, so a session in a subdirectory made them read different
// roots and disagree about whether the gate was on.
test("the gate reads the same from the repository root and a subdirectory", () => {
  withPluginData(() => {
    const root = scratchRepo();
    const deep = path.join(root, "src", "deep");

    assert.equal(resolveStateFile(root), resolveStateFile(deep));

    setGate(deep, true);
    assert.equal(gateEnabled(root), true);
    assert.equal(gateEnabled(deep), true);

    setGate(root, false);
    assert.equal(gateEnabled(deep), false);
  });
});

test("state lives under CLAUDE_PLUGIN_DATA, not in the repository", () => {
  withPluginData((dataDir) => {
    const root = scratchRepo();
    const { file } = setGate(root, true);
    assert.ok(file.startsWith(dataDir), `${file} is not under ${dataDir}`);
    assert.ok(!file.startsWith(root), "state was written inside the repository");
    assert.ok(!fs.existsSync(path.join(root, ".claude", "agy.local.md")));
  });
});

// CLAUDE_PLUGIN_DATA was observed in an ambient shell pointing at a different
// installed plugin's data directory. Namespacing means the worst case is a
// clearly foreign folder in a neighbour's tree, never a collision with the
// neighbour's own `state/`.
test("state is namespaced to this plugin inside the data directory", () => {
  withPluginData((dataDir) => {
    const root = scratchRepo();
    const file = resolveStateFile(root);
    assert.ok(
      file.startsWith(path.join(dataDir, PLUGIN_NAMESPACE) + path.sep),
      `${file} is not namespaced under ${PLUGIN_NAMESPACE}`
    );
  });
});

test("state falls back to a temp directory when the variable is unset", () => {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;
  try {
    const root = scratchRepo();
    const file = resolveStateFile(root);
    assert.ok(file.startsWith(path.join(os.tmpdir(), PLUGIN_NAMESPACE)), file);
    assert.equal(gateEnabled(root), false);
  } finally {
    if (previous !== undefined) {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("two repositories sharing a basename get different state", () => {
  withPluginData(() => {
    const a = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-a-")), "project");
    const b = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-b-")), "project");
    for (const root of [a, b]) {
      fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    }
    assert.notEqual(resolveStateDir(a), resolveStateDir(b));

    setGate(a, true);
    assert.equal(gateEnabled(a), true);
    assert.equal(gateEnabled(b), false);
  });
});

test("a workspace with no state yet reads as off", () => {
  withPluginData(() => {
    const root = scratchRepo();
    assert.equal(gateEnabled(root), false);
    assert.deepEqual(loadState(root), defaultState());
  });
});

test("corrupt state falls back to the default rather than throwing", () => {
  withPluginData(() => {
    const root = scratchRepo();
    const file = resolveStateFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    assert.deepEqual(loadState(root), defaultState());
    assert.equal(gateEnabled(root), false);
  });
});

test("a gate enabled under the old in-repository file still works", () => {
  withPluginData(() => {
    const root = scratchRepo();
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".claude", "agy.local.md"),
      "---\nstop_review_gate: true\n---\n\nLocal settings.\n"
    );
    assert.equal(readLegacyGate(root), true);
    assert.equal(gateEnabled(root), true, "an upgrading user silently lost their gate");
  });
});

test("stored state wins over the legacy file once it exists", () => {
  withPluginData(() => {
    const root = scratchRepo();
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".claude", "agy.local.md"),
      "---\nstop_review_gate: true\n---\n"
    );
    setGate(root, false);
    assert.equal(gateEnabled(root), false, "turning the gate off did not stick");
  });
});

test("a legacy file without the flag, or without frontmatter, reads as unset", () => {
  withPluginData(() => {
    const root = scratchRepo();
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    const file = path.join(root, ".claude", "agy.local.md");

    fs.writeFileSync(file, "no frontmatter here\n");
    assert.equal(readLegacyGate(root), null);

    fs.writeFileSync(file, "---\nsomething_else: true\n---\n");
    assert.equal(readLegacyGate(root), null);

    fs.writeFileSync(file, "---\nstop_review_gate: false\n---\n");
    assert.equal(readLegacyGate(root), false);
  });
});

// B3 shipped the state file outside the repository, and `commands/setup.md`
// promises the script reports the exact file. Only `gate on` and `gate off` did
// so, which left `gate status` unable to answer the one question B3 created:
// which file is this workspace actually reading?
test("gate status reports the state file it reads", () => {
  withPluginData(() => {
    const root = scratchRepo();
    const previous = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = root;
    try {
      const status = main(["gate", "status"]);
      assert.equal(status.ok, true);
      assert.equal(status.action, "status");
      assert.equal(status.stateFile, resolveStateFile(root));
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_PROJECT_DIR;
      } else {
        process.env.CLAUDE_PROJECT_DIR = previous;
      }
    }
  });
});
