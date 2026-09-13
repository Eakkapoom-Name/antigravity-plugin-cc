#!/usr/bin/env node

// npx installer for the agy Claude Code plugin.
// `npx agy-plugin-cc` registers the marketplace and installs the plugin
// through the user's local `claude` CLI. Safe to rerun.

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

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

// A rerun is a no-op, not a failure, but a bare /already/i over the combined
// stdout and stderr also swallows any genuine failure whose message happens to
// contain the word. Match the shape of a no-op instead. The two observed
// messages are `Marketplace '<name>' already on disk` and
// `Plugin "<name>" is already installed`; the rest are near neighbours.
const ALREADY_DONE =
  /\balready\s+(?:on disk|installed|added|exists?|present|registered|configured|up[- ]to[- ]date)\b/i;

export function alreadyDone(output) {
  return ALREADY_DONE.test(String(output ?? ""));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function main() {
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
  // A rerun succeeds rather than failing, so the exit status alone does not say
  // whether anything changed; the message does.
  console.log(alreadyDone(add.output) ? "Marketplace already added." : "Marketplace added.");

  console.log(`Installing ${PLUGIN} ...`);
  const install = run(["plugin", "install", PLUGIN]);
  if (!install.ok && !alreadyDone(install.output)) {
    fail(`Could not install the plugin:\n${install.output}`);
  }
  console.log(alreadyDone(install.output) ? "Plugin already installed." : "Plugin installed.");

  console.log(`
Done. Next steps:
  1. Start (or restart) Claude Code.
  2. Run /agy:setup to check that the Antigravity CLI (agy) is ready.
     If agy is not installed yet, see https://antigravity.google/docs/cli/install/`);
}

// Only install when invoked as a script; importing this module (for tests) must
// not shell out to the claude CLI.
if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  main();
}
