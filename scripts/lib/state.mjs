import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
export const PLUGIN_NAMESPACE = "agy-plugin-cc";
const FALLBACK_STATE_ROOT = path.join(os.tmpdir(), PLUGIN_NAMESPACE);
const STATE_FILE_NAME = "state.json";

// Where the gate flag used to live, inside the project. Still read, so a user
// who enabled the gate before this release does not silently lose it.
export const LEGACY_SETTINGS_FILE = path.join(".claude", "agy.local.md");

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

// The pre-0.7 format: `stop_review_gate: true` in the frontmatter of a file
// committed inside the project.
export function readLegacyGate(cwd) {
  const file = path.join(resolveWorkspaceRoot(cwd), LEGACY_SETTINGS_FILE);
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
