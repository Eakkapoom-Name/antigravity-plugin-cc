import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

// npm installs `agy` and `claude` on Windows as `.cmd` and `.ps1` shims, which
// `spawnSync("agy", ...)` cannot execute: there is no `agy` file to exec.
//
// `shell: true` would fix it and must not be used. These commands are handed
// prompt text, diffs, and file paths; routing any of that through a shell turns
// argument data into shell syntax. Resolving the real file and spawning it
// directly keeps arguments as arguments.
//
// This also replaces the `which` call the setup script used, which only existed
// on Unix in the first place.
export function resolveCommand(name, env = process.env) {
  const raw = String(name ?? "");
  if (!raw) {
    return null;
  }

  const isWindows = process.platform === "win32";
  const extensions = isWindows
    ? ["", ...String(env.PATHEXT || DEFAULT_PATHEXT).split(";").filter(Boolean)]
    : [""];

  const exists = (candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  };

  // An explicit path is used as given; only PATH entries get the extension walk.
  if (raw.includes("/") || raw.includes("\\")) {
    const absolute = path.resolve(raw);
    for (const extension of extensions) {
      if (exists(absolute + extension)) {
        return absolute + extension;
      }
    }
    return null;
  }

  for (const dir of String(env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, raw + extension);
      if (exists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

export function commandAvailable(name, env = process.env) {
  return resolveCommand(name, env) !== null;
}

const WINDOWS_BATCH = /\.(cmd|bat)$/i;

// Resolving the shim is only half the job: Windows cannot exec a .cmd or .bat
// image at all, and since the fix for CVE-2024-27980 Node refuses to try,
// throwing EINVAL. Such a file has to be handed to cmd.exe.
//
// cmd.exe is invoked explicitly rather than through `shell: true` because the
// difference is what stays fixed. Here the interpreter and the command file are
// decided by this function and only the arguments are quoted. With
// `shell: true` the whole line, command included, would be assembled from
// caller-supplied text.
export function quoteForCmd(value) {
  const text = String(value ?? "");
  // Windows argument rules: backslashes are literal unless they precede a
  // quote, where they must be doubled.
  const escaped = text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  return `"${escaped}"`;
}

export function buildCmdInvocation(target, args, env = process.env) {
  // /d skips AutoRun commands from the registry, /s fixes how the outer quotes
  // around the whole command are parsed, /c runs it and exits.
  return {
    file: env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${[target, ...args].map(quoteForCmd).join(" ")}"`]
  };
}

// Spawns without a shell, always. When the command cannot be resolved the raw
// name is passed through so the caller still gets a normal ENOENT result rather
// than a different error shape from this layer.
export function runCommand(name, args, options = {}) {
  const resolved = resolveCommand(name) ?? name;

  if (process.platform === "win32" && WINDOWS_BATCH.test(resolved)) {
    const invocation = buildCmdInvocation(resolved, args);
    return spawnSync(invocation.file, invocation.args, {
      ...options,
      shell: false,
      // The argument vector is already quoted for cmd.exe above; letting Node
      // quote it again would double the escaping.
      windowsVerbatimArguments: true
    });
  }

  return spawnSync(resolved, args, { ...options, shell: false });
}
