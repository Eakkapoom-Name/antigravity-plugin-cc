#!/usr/bin/env node

// Refuses to pack while a backup file sits in the tree. `npm pack`
// force-includes anything matching README*, so a README.md.bak left by an
// editing session ships in the tarball, and neither a `files` negation nor an
// .npmignore entry keeps it out (both were tried). The only reliable guard is
// to not pack at all until the file is gone.
// Usage: node prepack-check.mjs [package-root]   (npm runs it as `prepack`)

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Matches the shapes the editing sessions leave behind: `.bak`, `.bak2`, and
// the `.bak[0-9]` forms .gitignore already lists. `keep.bak.md` is not one.
const BACKUP_NAME = /\.bak[0-9]*$/;

export function strayBackupFiles(names) {
  return names.filter((name) => BACKUP_NAME.test(name));
}

function walk(dir, relative = "") {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...walk(path.join(dir, entry.name), rel));
    } else {
      found.push(rel);
    }
  }
  return found;
}

export function main(root) {
  const stray = strayBackupFiles(walk(root));
  if (stray.length === 0) {
    return 0;
  }
  process.stderr.write(
    `Refusing to pack: backup files in the tree would ship in the tarball (npm force-includes README*).\n` +
      stray.map((name) => `  ${name}`).join("\n") +
      `\nRemove or move them, then pack again.\n`
  );
  return 1;
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = main(path.resolve(process.argv[2] ?? process.cwd()));
}
