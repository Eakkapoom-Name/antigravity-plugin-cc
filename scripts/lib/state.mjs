import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { resolveWorkspaceRoot } from "./workspace.mjs";
import { runCommand } from "./process.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
export const PLUGIN_NAMESPACE = "agy-plugin-cc";
const FALLBACK_STATE_ROOT = path.join(os.tmpdir(), PLUGIN_NAMESPACE);
const STATE_FILE_NAME = "state.json";

// Where the gate flag used to live, inside the project. Still read (when it
// is not tracked by git, see `legacyGateIsTracked` below), so a user who
// enabled the gate locally before this release does not silently lose it.
export const LEGACY_SETTINGS_FILE = path.join(".claude", "agy.local.md");

// Index paths are always `/`-separated, even on Windows, where
// `LEGACY_SETTINGS_FILE` above is `.claude\agy.local.md`; comparing against
// that backslashed form would never match, and the tracked file would be
// misread as untracked.
const LEGACY_SETTINGS_INDEX_PATH = LEGACY_SETTINGS_FILE.split(path.sep).join("/").toLowerCase();
const LEGACY_SETTINGS_DIR_INDEX_PATH = ".claude";

export function defaultState() {
  return { version: STATE_VERSION, config: { stopReviewGate: false } };
}

// Keyed by a hash of the canonical workspace root so two checkouts of the same
// project, or two projects sharing a basename, never collide. The readable slug
// is there so a human can tell the directories apart.
export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonical = workspaceRoot;
  try {
    canonical = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonical = workspaceRoot;
  }

  const slug =
    (path.basename(workspaceRoot) || "workspace")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);

  // CLAUDE_PLUGIN_DATA is the documented home for per-plugin state, but it is
  // not guaranteed to be set in every execution context, so the temp fallback
  // keeps both paths working rather than throwing.
  //
  // It is also not guaranteed to belong to this plugin. It was observed set to
  // another installed plugin's data directory in an ambient shell, so the state
  // goes in a subtree named for this plugin rather than straight into `state/`.
  // Worst case the data lands in a neighbour's directory under an obviously
  // foreign name; it never collides with that neighbour's own files.
  const pluginData = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginData
    ? path.join(pluginData, PLUGIN_NAMESPACE, "state")
    : FALLBACK_STATE_ROOT;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function loadState(cwd) {
  try {
    const parsed = JSON.parse(fs.readFileSync(resolveStateFile(cwd), "utf8"));
    if (!parsed || typeof parsed !== "object") {
      return defaultState();
    }
    return {
      version: STATE_VERSION,
      config: { stopReviewGate: parsed.config?.stopReviewGate === true }
    };
  } catch {
    return defaultState();
  }
}

export function saveState(cwd, state) {
  const file = resolveStateFile(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  return file;
}

// A committed copy of the legacy file would silently turn the gate on for
// anyone who clones the repository, so it is honoured only when git reports
// it untracked (or ignored). Returns true when the file must not be honoured.
//
// Asking about the file alone is not enough: a repository can commit
// `.claude` itself as a symlink (mode 120000) or a gitlink (mode 160000),
// and on a case-insensitive filesystem `.CLAUDE/agy.local.md` or
// `.claude/AGY.local.md` is the same file. So every index entry under a
// case-insensitive `.claude` is listed, and the file counts as tracked when
// any entry is `.claude` itself (any mode) or the legacy file, compared
// case-insensitively. A tracked sibling such as `.claude/settings.json`
// does not count.
//
// Only a clean git answer decides. With no `.git` at the workspace root (a
// tarball or zip download) or no git on PATH (an ENOENT spawn error) there
// is nothing to ask, and the file is read the way it always was. Any other
// failure with a `.git` present (git refusing the repository for dubious
// ownership, a corrupt index) means git could not vouch for the file, so it
// is not honoured. Every GIT_* variable is dropped from the environment so
// an ambient GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE cannot point the
// check at another repository's index.
function legacyGateIsTracked(workspaceRoot) {
  if (!fs.existsSync(path.join(workspaceRoot, ".git"))) {
    return false;
  }
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^GIT_/i.test(key)) {
      env[key] = value;
    }
  }
  const result = runCommand(
    "git",
    ["ls-files", "-z", "--stage", "--", `:(icase)${LEGACY_SETTINGS_DIR_INDEX_PATH}`],
    { cwd: workspaceRoot, encoding: "utf8", env }
  );
  if (result.error) {
    return result.error.code !== "ENOENT";
  }
  if (result.status !== 0) {
    return true;
  }
  // `-z --stage` entries are `<mode> <object> <stage>\t<path>`, NUL-ended.
  return String(result.stdout ?? "")
    .split("\0")
    .filter(Boolean)
    .some((entry) => {
      const tab = entry.indexOf("\t");
      const entryPath = (tab === -1 ? entry : entry.slice(tab + 1)).toLowerCase();
      return entryPath === LEGACY_SETTINGS_DIR_INDEX_PATH || entryPath === LEGACY_SETTINGS_INDEX_PATH;
    });
}

// The legacy file is honoured only as the workspace's own
// `.claude/agy.local.md`: a symlinked `.claude` or a symlinked file would
// read content from somewhere git's answer about this path does not cover.
function legacyGateFileIsDirect(workspaceRoot, file) {
  try {
    return fs.realpathSync.native(file) === path.join(fs.realpathSync.native(workspaceRoot), LEGACY_SETTINGS_FILE);
  } catch {
    return false;
  }
}

// The pre-0.7 format: `stop_review_gate: true` in the frontmatter of a file
// living inside the project, honoured only when that file is reached
// directly and is not tracked by git (see `legacyGateFileIsDirect` and
// `legacyGateIsTracked`).
export function readLegacyGate(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const file = path.join(workspaceRoot, LEGACY_SETTINGS_FILE);
  if (!legacyGateFileIsDirect(workspaceRoot, file)) {
    return null;
  }
  if (legacyGateIsTracked(workspaceRoot)) {
    return null;
  }
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) {
    return null;
  }
  if (/^stop_review_gate:\s*true\s*$/m.test(frontmatter[1])) {
    return true;
  }
  if (/^stop_review_gate:\s*false\s*$/m.test(frontmatter[1])) {
    return false;
  }
  return null;
}

// Stored state wins. The legacy file is consulted only when this workspace has
// no state file yet, so an existing gate keeps working across the upgrade.
export function gateEnabled(cwd) {
  if (fs.existsSync(resolveStateFile(cwd))) {
    return loadState(cwd).config.stopReviewGate === true;
  }
  return readLegacyGate(cwd) === true;
}

export function setGate(cwd, enabled) {
  const state = loadState(cwd);
  state.config.stopReviewGate = enabled === true;
  const file = saveState(cwd, state);
  return { enabled: state.config.stopReviewGate, file };
}
