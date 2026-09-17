import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  classifyProbeFailure,
  containsFilesystemPath,
  evaluateCommandProbe,
  evaluateReadProbe,
  permissionNextStep,
  readAgySettings,
  resolveToolPermission
} from "../scripts/agy-setup.mjs";

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

// Probe payloads captured verbatim from agy 1.2.4 under a settings file that
// allows only `command(pwd)`. `denied_actions` is the decisive signal: the
// status is SUCCESS and the exit code 0 either way, and issue #21 showed the
// response can be non-empty too, so neither of the old signals is enough.
const DENIED_COMMAND_PAYLOAD = {
  conversation_id: "cfae3f3f-62fa-4015-9657-d2506a1884b4",
  status: "SUCCESS",
  response: "",
  duration_seconds: 4.47,
  num_turns: 1,
  usage: {},
  denied_actions: [{ action: "command", display_name: "RunCommand" }]
};

const DENIED_READ_PAYLOAD = {
  conversation_id: "fa93f7f2-4c03-45a4-a767-11d695cf9a18",
  status: "SUCCESS",
  response: "Reading the file now.\n",
  duration_seconds: 6.49,
  num_turns: 1,
  usage: {},
  denied_actions: [{ action: "read_file", display_name: "ViewFile" }]
};

function okProbe(payload) {
  return { ok: true, failure: null, stderr: "", payload };
}

test("the command probe reports a denied command by name", () => {
  const evaluated = evaluateCommandProbe(okProbe(DENIED_COMMAND_PAYLOAD));
  assert.equal(evaluated.available, false);
  assert.deepEqual(evaluated.deniedActions, ["command"]);
  assert.match(evaluated.detail, /command/);
});

test("the command probe still passes on a path when agy predates denied_actions", () => {
  const evaluated = evaluateCommandProbe(
    okProbe({ status: "SUCCESS", response: "/home/toaster/scratch\n", duration_seconds: 3.1 })
  );
  assert.equal(evaluated.available, true);
  assert.deepEqual(evaluated.deniedActions, []);
});

test("the command probe fails on an empty response with no denied_actions field", () => {
  const evaluated = evaluateCommandProbe(okProbe({ status: "SUCCESS", response: "", duration_seconds: 2 }));
  assert.equal(evaluated.available, false);
  assert.deepEqual(evaluated.deniedActions, []);
});

test("a denied action outranks a plausible-looking response", () => {
  // A response can carry a path and still have done nothing: the model narrates
  // what it was about to do, then the tool call is soft-denied.
  const evaluated = evaluateCommandProbe(
    okProbe({ ...DENIED_COMMAND_PAYLOAD, response: "Running pwd in /home/toaster now.\n" })
  );
  assert.equal(evaluated.available, false);
});

test("the read probe reports a denied read by name", () => {
  const evaluated = evaluateReadProbe(okProbe(DENIED_READ_PAYLOAD), "nonce-1234");
  assert.equal(evaluated.available, false);
  assert.deepEqual(evaluated.deniedActions, ["read_file"]);
  assert.match(evaluated.detail, /read_file/);
});

test("the read probe passes only when the nonce it planted comes back", () => {
  const passed = evaluateReadProbe(
    okProbe({ status: "SUCCESS", response: "agy-probe-nonce-1234\n", duration_seconds: 4 }),
    "agy-probe-nonce-1234"
  );
  assert.equal(passed.available, true);
  const wrong = evaluateReadProbe(
    okProbe({ status: "SUCCESS", response: "I could not find that file.\n", duration_seconds: 4 }),
    "agy-probe-nonce-1234"
  );
  assert.equal(wrong.available, false);
});

test("a probe that never produced JSON is reported as failed, not denied", () => {
  const evaluated = evaluateReadProbe(
    { ok: false, failure: "timeout", stderr: "", payload: null },
    "nonce"
  );
  assert.equal(evaluated.available, false);
  assert.deepEqual(evaluated.deniedActions, []);
  assert.match(evaluated.detail, /timeout/);
});

// The remedy has to name the rule for what was actually denied. Issue #21: every
// piece of guidance said `command(...)`, so a user whose reads were denied
// followed it and got a run that still read nothing.
test("the permission remedy names read_file(*) when a read was denied", () => {
  const step = permissionNextStep(["read_file"]);
  assert.match(step, /read_file\(\*\)/);
  assert.match(step, /settings\.json/);
});

test("the permission remedy names command rules when a command was denied", () => {
  const step = permissionNextStep(["command"]);
  assert.match(step, /command\(\*\)/);
  assert.match(step, /command\(git \*\)/);
});

test("the permission remedy names both rules when both were denied", () => {
  const step = permissionNextStep(["command", "read_file"]);
  assert.match(step, /command\(\*\)/);
  assert.match(step, /read_file\(\*\)/);
});

test("the permission remedy says the settings edit is the user's manual step", () => {
  // In an auto mode session the classifier denies the settings edit, the skip
  // flag, and even a read-only `agy -p "/permissions"`. Relaying the fix as
  // something the agent can carry out sends it into three more denials.
  const step = permissionNextStep(["read_file"]);
  assert.match(step, /by hand/);
  assert.match(step, /outside/);
  assert.match(step, /auto mode/);
  assert.match(step, /--dangerously-skip-permissions/);
});

// F22. `toolPermission` decides whether any rule or probe matters, and the
// plugin never read it. Values confirmed against agy 1.2.4's own /config UI.
const VALID_MODES = ["always-proceed", "request-review", "proceed-in-sandbox", "strict"];

for (const mode of VALID_MODES) {
  test(`resolveToolPermission keeps the valid mode ${mode}`, () => {
    assert.equal(resolveToolPermission({ toolPermission: mode }), mode);
  });
}

// Measured: agy silently falls back to request-review for anything it does not
// recognise. `sandbox`, `agent-decides` and `asks-for-review` were each set and
// each read back as request-review, so a typo is invisible to the user.
for (const bogus of ["sandbox", "agent-decides", "asks-for-review", "typo", "", null, undefined, 42]) {
  test(`resolveToolPermission falls back to request-review for ${JSON.stringify(bogus)}`, () => {
    assert.equal(resolveToolPermission({ toolPermission: bogus }), "request-review");
  });
}

test("resolveToolPermission treats a missing key and a missing file as the default", () => {
  assert.equal(resolveToolPermission({}), "request-review");
  assert.equal(resolveToolPermission(null), "request-review");
});

test("readAgySettings reports an unreadable settings file instead of throwing", () => {
  const settings = readAgySettings(path.join(os.tmpdir(), "definitely-not-a-home-xyz"));
  assert.equal(settings.readable, false);
  assert.equal(settings.toolPermission, "request-review");
  assert.ok(settings.path.endsWith(path.join(".gemini", "antigravity-cli", "settings.json")));
});

test("readAgySettings reads the mode and both booleans from a real file", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-settings-"));
  const dir = path.join(home, ".gemini", "antigravity-cli");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({ toolPermission: "always-proceed", allowNonWorkspaceAccess: true, sandboxMode: false })
  );
  const settings = readAgySettings(home);
  assert.equal(settings.readable, true);
  assert.equal(settings.toolPermission, "always-proceed");
  assert.equal(settings.allowNonWorkspaceAccess, true);
  assert.equal(settings.sandboxMode, false);
});

test("readAgySettings survives malformed JSON", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-settings-bad-"));
  const dir = path.join(home, ".gemini", "antigravity-cli");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), "{ not json");
  const settings = readAgySettings(home);
  assert.equal(settings.readable, false);
  assert.equal(settings.toolPermission, "request-review");
});

// The remedy has to differ per mode. Measured with an empty allow-list:
// always-proceed passes everything; request-review denies reads and commands
// but not writes; proceed-in-sandbox denies commands unless --sandbox is passed,
// which this plugin does not pass; strict denies even in-workspace reads.
test("the remedy for request-review names both rules and the mode switch", () => {
  const step = permissionNextStep(["read_file", "command"], "request-review");
  assert.match(step, /read_file\(\*\)/);
  assert.match(step, /command\(\*\)/);
  assert.match(step, /always-proceed/);
  assert.match(step, /request-review/);
});

test("the remedy warns that proceed-in-sandbox does not work with this plugin", () => {
  const step = permissionNextStep(["command"], "proceed-in-sandbox");
  // The plugin never passes --sandbox, and without it this mode denies commands.
  assert.match(step, /--sandbox/);
  assert.match(step, /does not pass/i);
});

test("the remedy for strict says it denies even in-workspace reads", () => {
  const step = permissionNextStep(["read_file"], "strict");
  assert.match(step, /strict/);
  assert.match(step, /in-workspace|inside the workspace/i);
});

test("a denial under always-proceed is not blamed on the mode", () => {
  // always-proceed approves everything, so a denial here means something else
  // is wrong and telling the user to change the mode would be noise.
  const step = permissionNextStep(["command"], "always-proceed");
  assert.ok(!/switch to `always-proceed`/.test(step));
});

test("every remedy still says the edit is the user's manual step", () => {
  for (const mode of VALID_MODES) {
    const step = permissionNextStep(["read_file"], mode);
    assert.match(step, /by hand/, `${mode} remedy dropped the manual-step warning`);
    assert.match(step, /auto mode/, `${mode} remedy dropped the classifier warning`);
  }
});

// F24. The first full run of the denial harness contradicted what 0.6.5 was
// about to ship: under `request-review` with an empty allow-list, the command
// probe was denied and the in-workspace read probe passed, three runs out of
// three, trusted workspace or not. Only `strict` denied an in-workspace read.
test("the remedy for request-review reports the measured split, not a blanket read denial", () => {
  const step = permissionNextStep(["command"], "request-review");
  assert.match(step, /commands were refused/i);
  assert.match(step, /inside the workspace was allowed/i);
  assert.ok(
    !/gates reads and commands/i.test(step),
    "the request-review remedy still claims the mode refuses reads"
  );
});

// F24, same overclaim four lines from the one already fixed: the comment above
// the read probe blamed `always-proceed` for the read passing here. The harness
// showed it passing under every mode but `strict`.
test("the read probe comment does not blame always-proceed for a passing read", () => {
  const source = fs.readFileSync(
    new URL("../scripts/agy-setup.mjs", import.meta.url),
    "utf8"
  );
  assert.ok(
    !/true only because this machine runs/.test(source),
    "the read probe comment still says always-proceed is why the read passed"
  );
  assert.match(source, /Only `strict` denied it/);
});
