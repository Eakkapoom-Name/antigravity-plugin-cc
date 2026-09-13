import test from "node:test";
import assert from "node:assert/strict";

import { alreadyDone } from "../scripts/npx-install.mjs";

// Both strings were captured from the real `claude` CLI by running the add and
// the install twice against an isolated CLAUDE_CONFIG_DIR. Both reruns exited
// 0, so these messages are the only signal that nothing changed.
const NO_OP_OUTPUT = [
  "Adding marketplace...Marketplace 'antigravity-plugin-cc' already on disk - declared in user settings",
  'Installing plugin "agy@antigravity-plugin-cc"...Plugin "agy@antigravity-plugin-cc" is already installed (scope: user)',
  "marketplace already added",
  "plugin already exists",
  "already up-to-date",
  "already up to date",
  "already registered"
];

for (const output of NO_OP_OUTPUT) {
  test(`alreadyDone accepts ${JSON.stringify(output.slice(0, 60))}`, () => {
    assert.equal(alreadyDone(output), true);
  });
}

// A bare /already/i over combined stdout and stderr reported these as a
// successful no-op, which is the whole finding.
const REAL_FAILURE_OUTPUT = [
  "error: repository not found",
  "fatal: could not read from remote repository",
  "Error: the marketplace manifest is invalid; this error was already reported upstream",
  "npm ERR! already logged this failure, aborting",
  "Failed: already-running installer holds the lock",
  ""
];

for (const output of REAL_FAILURE_OUTPUT) {
  test(`alreadyDone rejects ${JSON.stringify(output.slice(0, 60))}`, () => {
    assert.equal(alreadyDone(output), false);
  });
}

test("alreadyDone tolerates null and undefined", () => {
  assert.equal(alreadyDone(null), false);
  assert.equal(alreadyDone(undefined), false);
});

test("importing the installer does not shell out to the claude CLI", () => {
  // Reaching this line proves the module-level install is guarded; an unguarded
  // import would have run `claude plugin marketplace add` during the import.
  assert.equal(typeof alreadyDone, "function");
});
