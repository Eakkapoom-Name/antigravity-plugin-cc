import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

export function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

export function listMarkdown(relativeDir) {
  return fs
    .readdirSync(path.join(ROOT, relativeDir))
    .filter((name) => name.endsWith(".md"))
    .sort();
}

// Minimal frontmatter reader: enough for the flat `key: value` blocks the
// plugin's commands and agents use. Returns null when the file has no
// frontmatter at all so callers can assert on that separately.
export function parseFrontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return null;
  }
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) {
      continue;
    }
    fields[field[1]] = field[2].trim().replace(/^["'](.*)["']$/, "$1");
  }
  return fields;
}
