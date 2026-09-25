import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

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

// F69. Every temp directory made here is removed once the file's tests are
// done, the way companion.test.mjs and output-path.test.mjs already clean up.
const scratchDirs = [];
after(() => {
  for (const dir of scratchDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function scratchRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-repo-"));
  scratchDirs.push(root);
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
  scratchDirs.push(loose);
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
    const aRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-a-"));
    const bRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-b-"));
    scratchDirs.push(aRoot, bRoot);
    const a = path.join(aRoot, "project");
    const b = path.join(bRoot, "project");
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
    const root = scratchGitRepo();
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
    const root = scratchGitRepo();
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

// A real repository, unlike `scratchRepo()`'s bare `.git` directory: git
// treats an empty `.git` folder as "not a git repository" (exit 128), and
// with a `.git` present any such refusal means the legacy file is not
// honoured, so every legacy-file test that expects it read needs a `.git`
// git itself recognizes.
function scratchGitRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-legacy-git-"));
  scratchDirs.push(root);
  spawnSync("git", ["init", "-q", "."], { cwd: root });
  spawnSync("git", ["config", "user.email", "t@e.x"], { cwd: root });
  spawnSync("git", ["config", "user.name", "t"], { cwd: root });
  fs.writeFileSync(path.join(root, "a.txt"), "one\n");
  spawnSync("git", ["add", "-A"], { cwd: root });
  spawnSync("git", ["commit", "-qm", "base"], { cwd: root });
  return root;
}

function writeLegacyGateFile(root) {
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".claude", "agy.local.md"),
    "---\nstop_review_gate: true\n---\n\nLocal settings.\n"
  );
}

// The tracked check runs git in the workspace on every Stop. A repository
// that arrives with its own `.git/config` (a tarball, a shared folder) must
// not get its `core.fsmonitor` command run by that check.
test("the legacy gate check does not run the repository's fsmonitor command", () => {
  withPluginData(() => {
    const root = scratchGitRepo();
    const marker = path.join(root, "fsmonitor-ran");
    const hook = path.join(root, "fsmonitor.sh");
    fs.writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    spawnSync("git", ["config", "core.fsmonitor", hook], { cwd: root });
    writeLegacyGateFile(root);
    readLegacyGate(root);
    assert.equal(fs.existsSync(marker), false, "the legacy gate check ran core.fsmonitor");
  });
});

// F116. A `.claude/agy.local.md` committed to the repository used to turn
// the gate on for anyone who cloned it. Only an untracked (local-only) copy
// is honoured now.
test("a legacy gate file committed to the repository is ignored", () => {
  withPluginData(() => {
    const root = scratchGitRepo();
    writeLegacyGateFile(root);
    spawnSync("git", ["add", "-A"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "commit the legacy gate file"], { cwd: root });
    assert.equal(readLegacyGate(root), null);
    assert.equal(gateEnabled(root), false, "a committed legacy file silently enabled the gate");
  });
});

test("an untracked legacy gate file in a real git repository still works", () => {
  withPluginData(() => {
    const root = scratchGitRepo();
    writeLegacyGateFile(root);
    // Deliberately not `git add`ed: the file exists locally but git has never
    // been told to track it.
    assert.equal(readLegacyGate(root), true);
    assert.equal(gateEnabled(root), true, "an untracked legacy file was ignored");
  });
});

test("a legacy gate file outside any git repository is unaffected by the tracked check", () => {
  withPluginData(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-legacy-nogit-"));
    scratchDirs.push(root);
    writeLegacyGateFile(root);
    assert.equal(readLegacyGate(root), true);
    assert.equal(gateEnabled(root), true, "a legacy file outside a git repository was ignored");
  });
});

function git(root, ...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

// Runs `run` with the given environment overrides, restoring every key after.
function withEnv(overrides, run) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    process.env[key] = overrides[key];
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

// F116 follow-up. `git ls-files --error-unmatch -- .claude/agy.local.md`
// exits 1 when `.claude` itself is what the repository commits (a symlink,
// mode 120000, or a gitlink, mode 160000), while reading the file follows
// the link: the committed repository still turned the gate on.
test("a legacy gate file reached through a committed .claude symlink is ignored", (t) => {
  withPluginData(() => {
    const root = scratchGitRepo();
    fs.mkdirSync(path.join(root, "cfg"));
    fs.writeFileSync(path.join(root, "cfg", "agy.local.md"), "---\nstop_review_gate: true\n---\n");
    try {
      fs.symlinkSync("cfg", path.join(root, ".claude"), "dir");
    } catch {
      t.skip("symlinks are not available here");
      return;
    }
    git(root, "add", "-A");
    git(root, "commit", "-qm", "commit a .claude symlink");
    assert.match(git(root, "ls-files", "--stage", "--", ".claude"), /^120000 /);
    assert.equal(readLegacyGate(root), null);
    assert.equal(gateEnabled(root), false, "a committed .claude symlink enabled the gate");
  });
});

// The realpath guard on its own: an untracked symlink is not something git
// can vouch for either way, and the file it reaches is not the workspace's
// own `.claude/agy.local.md`.
test("a legacy gate file reached through any symlink is ignored, even untracked or outside git", (t) => {
  withPluginData(() => {
    for (const root of [scratchGitRepo(), fs.mkdtempSync(path.join(os.tmpdir(), "agy-legacy-nogit-"))]) {
      scratchDirs.push(root);
      const target = fs.mkdtempSync(path.join(os.tmpdir(), "agy-legacy-target-"));
      scratchDirs.push(target);
      fs.writeFileSync(path.join(target, "agy.local.md"), "---\nstop_review_gate: true\n---\n");
      try {
        fs.symlinkSync(target, path.join(root, ".claude"), "dir");
      } catch {
        t.skip("symlinks are not available here");
        return;
      }
      assert.equal(readLegacyGate(root), null, `a symlinked .claude was honoured in ${root}`);
      fs.rmSync(path.join(root, ".claude"));
      fs.mkdirSync(path.join(root, ".claude"));
      fs.symlinkSync(path.join(target, "agy.local.md"), path.join(root, ".claude", "agy.local.md"));
      assert.equal(readLegacyGate(root), null, `a symlinked agy.local.md was honoured in ${root}`);
    }
  });
});

test("a legacy gate file under a committed .claude gitlink is ignored", () => {
  withPluginData(() => {
    const root = scratchGitRepo();
    writeLegacyGateFile(root);
    const head = git(root, "rev-parse", "HEAD").trim();
    git(root, "update-index", "--add", "--cacheinfo", `160000,${head},.claude`);
    git(root, "commit", "-qm", "commit a .claude gitlink");
    const exact = spawnSync("git", ["ls-files", "--error-unmatch", "--", ".claude/agy.local.md"], { cwd: root });
    assert.notEqual(exact.status, 0, "the fixture no longer reproduces the gitlink bypass");
    assert.equal(readLegacyGate(root), null);
    assert.equal(gateEnabled(root), false, "a committed .claude gitlink enabled the gate");
  });
});

// On a case-insensitive filesystem a committed `.CLAUDE/agy.local.md` or
// `.claude/AGY.local.md` is the same file as `.claude/agy.local.md`. The
// index comparison ignores case everywhere, so this is checked on Linux too,
// where the two happen to be separate files.
test("a case-variant legacy gate path tracked by git is treated as tracked", () => {
  for (const tracked of [path.join(".CLAUDE", "agy.local.md"), path.join(".claude", "AGY.local.md")]) {
    withPluginData(() => {
      const root = scratchGitRepo();
      fs.mkdirSync(path.join(root, path.dirname(tracked)), { recursive: true });
      fs.writeFileSync(path.join(root, tracked), "---\nstop_review_gate: true\n---\n");
      git(root, "add", "-A");
      git(root, "commit", "-qm", "commit a case-variant legacy file");
      writeLegacyGateFile(root);
      assert.equal(readLegacyGate(root), null, `a tracked ${tracked} did not count as tracked`);
    });
  }
});

// A tracked sibling under `.claude` (a shared settings.json) is not the
// legacy file and must not switch off a legitimate local gate.
test("a tracked .claude/settings.json does not disable an untracked legacy gate", () => {
  withPluginData(() => {
    const root = scratchGitRepo();
    fs.mkdirSync(path.join(root, ".claude"));
    fs.writeFileSync(path.join(root, ".claude", "settings.json"), "{}\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "commit shared settings");
    writeLegacyGateFile(root);
    assert.equal(readLegacyGate(root), true);
  });
});

// With a `.git` present, a git that refuses the repository (a corrupt index
// here; dubious ownership does the same) cannot say the file is untracked,
// so the file is not honoured.
test("a legacy gate file is not honoured when git refuses the repository", () => {
  withPluginData(() => {
    const root = scratchGitRepo();
    writeLegacyGateFile(root);
    fs.writeFileSync(path.join(root, ".git", "index"), "garbage\n");
    const probe = spawnSync("git", ["ls-files"], { cwd: root });
    assert.notEqual(probe.status, 0, "the corrupt index fixture no longer makes git fail");
    assert.equal(readLegacyGate(root), null);
    assert.equal(gateEnabled(root), false, "a legacy file was honoured although git refused the repository");
  });
});

// An ambient GIT_DIR (or GIT_WORK_TREE, GIT_INDEX_FILE) would point the check
// at some other repository's index, where the file may well be untracked.
test("a stray GIT_DIR in the environment does not redirect the tracked check", () => {
  withPluginData(() => {
    const committed = scratchGitRepo();
    writeLegacyGateFile(committed);
    git(committed, "add", "-A");
    git(committed, "commit", "-qm", "commit the legacy gate file");
    const other = scratchGitRepo();
    withEnv({ GIT_DIR: path.join(other, ".git"), GIT_WORK_TREE: other }, () => {
      assert.equal(readLegacyGate(committed), null, "GIT_DIR made a committed legacy file look untracked");
    });
    const local = scratchGitRepo();
    writeLegacyGateFile(local);
    withEnv({ GIT_DIR: path.join(committed, ".git"), GIT_WORK_TREE: committed }, () => {
      assert.equal(readLegacyGate(local), true, "GIT_DIR made an untracked legacy file look tracked");
    });
  });
});

// The documented fallback: with git not installed there is nothing to ask,
// and the legacy file is read the way it always was.
test("a legacy gate file is still honoured when git is not installed", () => {
  withPluginData(() => {
    const root = scratchGitRepo();
    writeLegacyGateFile(root);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "agy-nopath-"));
    scratchDirs.push(empty);
    withEnv({ PATH: empty }, () => {
      assert.equal(readLegacyGate(root), true);
    });
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
