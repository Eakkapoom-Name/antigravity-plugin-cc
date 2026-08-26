#!/usr/bin/env node

// npx installer for the agy Claude Code plugin.
// `npx agy-plugin-cc` registers the marketplace and installs the plugin
// through the user's local `claude` CLI. Safe to rerun.

import { spawnSync } from "node:child_process";
import process from "node:process";

const MARKETPLACE = "Eakkapoom-Name/antigravity-plugin-cc";
const PLUGIN = "agy@antigravity-plugin-cc";

function run(args) {
  const result = spawnSync("claude", args, { encoding: "utf8" });
  return {
    ok: result.status === 0,
    enoent: result.error?.code === "ENOENT",
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
  };
}

function alreadyDone(output) {
  return /already/i.test(output);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

console.log(`Adding marketplace ${MARKETPLACE} ...`);
const add = run(["plugin", "marketplace", "add", MARKETPLACE]);
if (add.enoent) {
  fail(
    "The `claude` CLI was not found on PATH. Install Claude Code first: https://code.claude.com/docs"
  );
}
if (!add.ok && !alreadyDone(add.output)) {
  fail(`Could not add the marketplace:\n${add.output}`);
}
console.log(add.ok ? "Marketplace added." : "Marketplace already added.");

console.log(`Installing ${PLUGIN} ...`);
const install = run(["plugin", "install", PLUGIN]);
if (!install.ok && !alreadyDone(install.output)) {
  fail(`Could not install the plugin:\n${install.output}`);
}
console.log(install.ok ? "Plugin installed." : "Plugin already installed.");

console.log(`
Done. Next steps:
  1. Start (or restart) Claude Code.
  2. Run /agy:setup to check that the Antigravity CLI (agy) is ready.
     If agy is not installed yet, see https://antigravity.google/docs/cli/install/`);
