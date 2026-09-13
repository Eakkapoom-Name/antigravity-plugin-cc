import fs from "node:fs";
import path from "node:path";

// The gate hook resolves its cwd from the Stop payload, and /agy:setup resolves
// it from the environment. When the session sits in a subdirectory those two
// disagree, so setup reports the gate off while the hook reads it on. Anchoring
// both on the repository root removes the disagreement at its source.
//
// The walk looks for `.git` rather than shelling out to `git rev-parse`: no
// spawn, no dependency on git being installed, and nothing to go wrong with
// Windows shim resolution.
export function resolveWorkspaceRoot(cwd) {
  let current;
  try {
    current = path.resolve(String(cwd || process.cwd()));
  } catch {
    return String(cwd || "");
  }

  // `.git` is a directory in a normal clone and a file in a worktree or
  // submodule, so existence is the test, not directory-ness.
  let candidate = current;
  while (true) {
    if (fs.existsSync(path.join(candidate, ".git"))) {
      return candidate;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      // Reached the filesystem root without finding a repository. The caller's
      // own directory is the best available answer.
      return current;
    }
    candidate = parent;
  }
}
