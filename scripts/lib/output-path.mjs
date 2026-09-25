import fs from "node:fs";
import path from "node:path";

// The companion writes research reports and copied images for the user. The
// target is resolved against the workspace root and must stay inside it after
// symlinks are followed, its parent must exist, and it must not already exist.
// agy itself never writes these files: it runs isolated.
export function resolveOutputPath(requested, workspaceRoot) {
  const text = String(requested ?? "").trim();
  if (!text) {
    return { ok: false, reason: "--out needs a path" };
  }
  let root;
  try {
    root = fs.realpathSync(workspaceRoot);
  } catch (error) {
    return { ok: false, reason: `workspace root is not readable: ${error.message}` };
  }
  const target = path.resolve(root, text);
  const parent = path.dirname(target);
  let realParent;
  try {
    realParent = fs.realpathSync(parent);
  } catch {
    return { ok: false, reason: `the parent directory of --out does not exist: ${parent}` };
  }
  if (realParent !== root && !realParent.startsWith(root + path.sep)) {
    return { ok: false, reason: `--out must stay inside the workspace ${root}` };
  }
  const resolved = path.join(realParent, path.basename(target));
  // lstatSync, not existsSync: existsSync follows a symlink and reports false
  // for a dangling one, but a dangling symlink still occupies the target
  // name. writeFileSync's "wx" flag opens with O_EXCL, which refuses to open
  // through any symlink there, broken or not, so leaving that case to the
  // write would spend a whole agy run before failing on the write. lstatSync
  // sees the entry itself, so anything already at the target name (a file, a
  // symlink, or otherwise) is refused here instead.
  try {
    fs.lstatSync(resolved);
    return { ok: false, reason: `--out already exists: ${resolved}; choose a new name` };
  } catch (error) {
    // ENOENT is the good path: nothing occupies the target name yet. Anything
    // else (a null byte in the path throws ERR_INVALID_ARG_VALUE rather than
    // ENOENT, for instance) is not "the target is free"; treating it that way
    // would let a bad path through the one check meant to catch it before a
    // multi-minute agy run, only to fail later at the write.
    if (error.code !== "ENOENT") {
      return { ok: false, reason: `--out could not be checked: ${error.message}` };
    }
  }
  return { ok: true, path: resolved };
}

// A second, narrower containment check for immediately before the write or
// copy that follows a multi-minute agy run: resolveOutputPath already proved
// `resolved`'s parent was inside the workspace when --out was first checked,
// but a parent directory can be removed and replaced with a symlink to
// somewhere else while the run is in flight, and neither the earlier check
// nor the `wx`/`COPYFILE_EXCL` flag on the write itself catches that, since
// both follow the parent symlink to reach the final path component. This
// only re-walks the parent's realpath against the workspace root; it does
// not repeat the lstat-on-the-target-name check, which stays the write
// flag's job, so a same-name race is still reported as the write's own
// EEXIST failure, unchanged. Callers pass the same `resolved` path
// resolveOutputPath returned, not the raw --out text, so this cannot be
// tricked by re-parsing a different value.
export function reconfirmContainment(resolved, workspaceRoot) {
  let root;
  try {
    root = fs.realpathSync(workspaceRoot);
  } catch (error) {
    return { ok: false, reason: `workspace root is not readable: ${error.message}` };
  }
  const parent = path.dirname(resolved);
  let realParent;
  try {
    realParent = fs.realpathSync(parent);
  } catch {
    return { ok: false, reason: `the parent directory of --out no longer exists: ${parent}` };
  }
  if (realParent !== root && !realParent.startsWith(root + path.sep)) {
    return { ok: false, reason: `--out must stay inside the workspace ${root}` };
  }
  return { ok: true };
}
