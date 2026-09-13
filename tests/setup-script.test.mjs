import test from "node:test";
import assert from "node:assert/strict";

import { classifyProbeFailure, containsFilesystemPath } from "../scripts/agy-setup.mjs";

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

// A failed auth probe has three causes and three remedies. Classifying a
// sandboxed run as an auth failure sends the user to re-authenticate an account
// that was never broken, which is what GitHub issue #19 reported.
const ENVIRONMENT_STDERR = [
  // The exact line quoted in issue #19.
  "listen tcp 127.0.0.1:0: socket: operation not permitted",
  "listen tcp 127.0.0.1:43111: bind: permission denied",
  "Error: connect EPERM 127.0.0.1:8080",
  "open /run/user/1000/agy.sock: EACCES",
  "listen EADDRNOTAVAIL: address not available",
  "socket: EAFNOSUPPORT"
];

for (const stderr of ENVIRONMENT_STDERR) {
  test(`classifyProbeFailure calls ${JSON.stringify(stderr)} an environment failure`, () => {
    assert.equal(classifyProbeFailure(stderr), "environment");
  });
}

const AUTH_STDERR = [
  "Error: not authenticated. Run agy to sign in.",
  "login required",
  "invalid credentials",
  "unauthorized: token expired",
  "Unauthenticated request"
];

for (const stderr of AUTH_STDERR) {
  test(`classifyProbeFailure calls ${JSON.stringify(stderr)} an auth failure`, () => {
    assert.equal(classifyProbeFailure(stderr), "auth");
  });
}

const UNKNOWN_STDERR = [
  "",
  "   ",
  "jetski: no output produced",
  "unexpected end of JSON input",
  // A tool denial says "permission denied" too, so a bare match on that phrase
  // would steal this case from the unknown bucket.
  "tool call was denied: permission denied"
];

for (const stderr of UNKNOWN_STDERR) {
  test(`classifyProbeFailure cannot classify ${JSON.stringify(stderr)}`, () => {
    assert.equal(classifyProbeFailure(stderr), "unknown");
  });
}

test("classifyProbeFailure puts the environment cause ahead of an auth symptom", () => {
  // A sandboxed run fails the downstream auth step as a symptom. The sandbox is
  // the cause worth reporting, so it must win even with auth words present.
  assert.equal(
    classifyProbeFailure(
      "listen tcp 127.0.0.1:0: socket: operation not permitted\nauth handshake failed: unauthenticated"
    ),
    "environment"
  );
});

test("classifyProbeFailure tolerates null and undefined", () => {
  assert.equal(classifyProbeFailure(null), "unknown");
  assert.equal(classifyProbeFailure(undefined), "unknown");
});

test("importing the setup script does not run the probes", () => {
  // Reaching this line at all proves the module-level main() call is guarded;
  // an unguarded import would have spawned agy during the import above.
  assert.equal(typeof containsFilesystemPath, "function");
});
