import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROMPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts");
const PLACEHOLDER = /\{\{([A-Z0-9_]+)\}\}/g;

export function promptPath(name) {
  return path.join(PROMPTS_DIR, `${name}.md`);
}

export function readPrompt(name) {
  return fs.readFileSync(promptPath(name), "utf8");
}

export function placeholdersIn(template) {
  return [...new Set([...String(template ?? "").matchAll(PLACEHOLDER)].map((match) => match[1]))];
}

// Every placeholder in the file must be supplied, and every supplied value must
// correspond to one. A prompt that silently ships a literal `{{REPO_ROOT}}` to
// the model is worse than a crash, and so is a caller passing a value the
// template stopped using.
export function renderPrompt(name, values = {}) {
  const template = readPrompt(name);
  const required = placeholdersIn(template);
  const supplied = Object.keys(values);

  const missing = required.filter((key) => !supplied.includes(key));
  if (missing.length > 0) {
    throw new Error(`Prompt ${name} needs values for: ${missing.join(", ")}`);
  }
  const unused = supplied.filter((key) => !required.includes(key));
  if (unused.length > 0) {
    throw new Error(`Prompt ${name} has no placeholder for: ${unused.join(", ")}`);
  }

  return template.replace(PLACEHOLDER, (_match, key) => String(values[key] ?? ""));
}
