import test from "node:test";
import assert from "node:assert/strict";

import { containsFilesystemPath } from "../scripts/agy-setup.mjs";

// The tool-permission probe asks agy to run `pwd`. agy formats that answer in
// several ways, and a false negative here reports a working install as broken.
const PATH_RESPONSES = [
  "/home/toaster",
  "/tmp/agy-scratch\n",
  "`/home/toaster/project`",
  "'/var/folders/xy/scratch'",
  '"/opt/agy"',
  "The output is: /home/toaster",
  "(/home/toaster)",
  "<file:///home/toaster>".replace("file://", ""),
  "C:\\Users\\toaster",
  "`C:\\Users\\toaster\\project`",
  "D:/work/agy"
];

for (const response of PATH_RESPONSES) {
  test(`containsFilesystemPath accepts ${JSON.stringify(response)}`, () => {
    assert.equal(containsFilesystemPath(response), true);
  });
}

const NON_PATH_RESPONSES = [
  "",
  "   ",
  "OK",
  "I do not have permission to run terminal commands.",
  "Tool call denied by permission settings",
  "and/or",
  "24/7",
  "read/write access was refused"
];

for (const response of NON_PATH_RESPONSES) {
  test(`containsFilesystemPath rejects ${JSON.stringify(response)}`, () => {
    assert.equal(containsFilesystemPath(response), false);
  });
}

test("containsFilesystemPath tolerates null and undefined", () => {
  assert.equal(containsFilesystemPath(null), false);
  assert.equal(containsFilesystemPath(undefined), false);
});

test("importing the setup script does not run the probes", () => {
  // Reaching this line at all proves the module-level main() call is guarded;
  // an unguarded import would have spawned agy during the import above.
  assert.equal(typeof containsFilesystemPath, "function");
});
