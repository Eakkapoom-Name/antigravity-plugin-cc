import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  MIN_AGY_VERSION,
  VERIFIED_AGY_VERSION,
  buildReport,
  classifyProbeFailure,
  compareVersions,
  containsFilesystemPath,
  decisiveStderrLine,
  evaluateCommandProbe,
  evaluateReadProbe,
  extractVersionNumber,
  meetsMinimumVersion,
  newerThanVerified,
  permissionNextStep,
  readAgySettings,
  resolveToolPermission
} from "../scripts/agy-setup.mjs";
import { read, ROOT } from "./helpers.mjs";

// F69. Every temp directory made here is removed once the file's tests are
// done, the way companion.test.mjs and output-path.test.mjs already clean up.
const scratchDirs = [];
after(() => {
  for (const dir of scratchDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
  scratchDirs.push(home);
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
  scratchDirs.push(home);
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

// F25. Reproduced live on 2026-09-17 with
// `bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /run --unshare-net agy -p ...`.
// A network-isolated sandbox never reaches the listener stage, so its stderr
// carries `dial tcp` rather than `listen tcp`, and the old pattern classified it
// as auth. That sent a sandboxed user to sign in again, which is the exact wrong
// advice F13 existed to remove.
const SANDBOX_NETWORK_STDERR = [
  'E0917 14:32:03.578718 45 g3syslog.go:23] [Post "https://play.googleapis.com/log": dial tcp: lookup play.googleapis.com on [::1]:53: read udp [::1]:57994->[::1]:53: read: connection refused]',
  // The full stderr from that run: the auth words are a symptom, the dial
  // failure is the cause, and the cause has to win.
  "W0917 14:32:08.563519 46 cache.go:135] Singleflight refresh failed: error getting token source: You are not logged into Antigravity.\nE0917 14:32:08.579603 45 g3syslog.go:23] [Post \"https://play.googleapis.com/log\": dial tcp: lookup play.googleapis.com on [::1]:53: read: connection refused]\nError: authentication timed out.",
  "dial tcp 142.250.66.106:443: connect: network is unreachable",
  'dial tcp: lookup play.googleapis.com: no such host'
];

for (const stderr of SANDBOX_NETWORK_STDERR) {
  test(`classifyProbeFailure calls a network-isolated sandbox an environment failure: ${stderr.slice(0, 48)}`, () => {
    assert.equal(classifyProbeFailure(stderr), "environment");
  });
}

// The other half of that boundary: a signed-out user on a working network shows
// the same auth words with no network failure behind them, and must still be
// told to sign in.
test("a logged-out user with working network is still an auth failure", () => {
  assert.equal(
    classifyProbeFailure(
      "error getting token source: You are not logged into Antigravity.\nError: authentication timed out."
    ),
    "auth"
  );
});

// F27. The reported detail came from the last stderr line, which in the F25
// sandbox run was the telemetry client failing to flush after the run had
// already lost. The classification and the remedy were both right; the one line
// the user was shown was the least useful one present.
test("a shutdown-time telemetry line loses to the error that caused the failure", () => {
  const stderr = [
    "W0917 14:32:08.563519 46 cache.go:135] Singleflight refresh failed: error getting token source: You are not logged into Antigravity.",
    "Error: authentication timed out.",
    'Failed to shutdown telemetry client: Post "https://play.googleapis.com/log": dial tcp: lookup play.googleapis.com: no such host'
  ].join("\n");
  assert.equal(decisiveStderrLine(stderr), "Error: authentication timed out.");
});

// The telemetry lines carry `dial tcp` themselves, so ranking on the network
// pattern alone would still pick one of them.
test("a network failure in a shutdown line loses to the same failure in a real one", () => {
  const stderr = [
    "dial tcp 142.250.66.106:443: connect: network is unreachable",
    'E0917 14:32:03.578718 45 g3syslog.go:23] [Post "https://play.googleapis.com/log": dial tcp: lookup play.googleapis.com: no such host]'
  ].join("\n");
  assert.equal(
    decisiveStderrLine(stderr),
    "dial tcp 142.250.66.106:443: connect: network is unreachable"
  );
});

test("jetski: no output produced still outranks everything else", () => {
  const stderr = [
    "jetski: no output produced",
    "Error: authentication timed out.",
    "dial tcp: lookup play.googleapis.com: no such host"
  ].join("\n");
  assert.equal(decisiveStderrLine(stderr), "jetski: no output produced");
});

// Demoting a line must never empty the report: with nothing but shutdown noise
// to show, the old last-line behaviour is still better than saying nothing.
test("stderr that is nothing but shutdown noise still reports its last line", () => {
  const stderr = [
    "Failed to shutdown telemetry client: first",
    "Failed to shutdown telemetry client: second"
  ].join("\n");
  assert.equal(decisiveStderrLine(stderr), "Failed to shutdown telemetry client: second");
});

test("empty stderr reports nothing rather than undefined", () => {
  assert.equal(decisiveStderrLine(""), "");
  assert.equal(decisiveStderrLine(null), "");
});

// F28. Every contract was measured on 1.2.4 and setup printed the version
// without gating on it, so an older agy failed later, inside a run, with an
// error that did not name the cause.
test("the floor is the version the contracts were measured on", () => {
  assert.equal(MIN_AGY_VERSION, "1.2.4");
});

test("compareVersions orders dotted numeric versions", () => {
  assert.equal(compareVersions("1.2.4", "1.2.4"), 0);
  assert.equal(compareVersions("1.2.5", "1.2.4"), 1);
  assert.equal(compareVersions("1.2.10", "1.2.4"), 1);
  assert.equal(compareVersions("1.3.0", "1.2.4"), 1);
  assert.equal(compareVersions("1.1.28", "1.2.4"), -1);
  assert.equal(compareVersions("2.0.0", "1.2.4"), 1);
  assert.equal(compareVersions("1.2", "1.2.0"), 0);
});

test("meetsMinimumVersion is false for anything it cannot parse", () => {
  assert.equal(meetsMinimumVersion("1.2.5"), true);
  assert.equal(meetsMinimumVersion("1.2.4"), true);
  assert.equal(meetsMinimumVersion("1.2.3"), false);
  assert.equal(meetsMinimumVersion(""), false);
  assert.equal(meetsMinimumVersion("dev"), false);
  assert.equal(meetsMinimumVersion(null), false);
});

// F74. The gates and compareVersions read a version through the same numeric
// core, so a prefixed or suffixed print gets one answer from all of them.
test("meetsMinimumVersion and compareVersions agree on prefixed and suffixed versions", () => {
  for (const [raw, meets] of [
    ["1.2.4-beta", true],
    ["v1.2.4", true],
    ["1.2.4", true],
    ["v1.2.3", false],
    ["1.2.3-beta", false],
    ["agy 1.3.0", true],
    ["garbage", false]
  ]) {
    assert.equal(meetsMinimumVersion(raw), meets, `meetsMinimumVersion(${JSON.stringify(raw)})`);
  }
  assert.equal(compareVersions("1.2.4-beta", "1.2.4"), 0);
  assert.equal(compareVersions("v1.2.4", "1.2.4"), 0);
  assert.equal(compareVersions("v1.2.4", "1.2.4-beta"), 0);
  assert.equal(compareVersions("v1.2.5", "1.2.4-beta"), 1);
  assert.equal(compareVersions("1.2.3-beta", "v1.2.4"), -1);
  // No numeric core reads as the lowest version, and the gates refuse it.
  assert.equal(compareVersions("garbage", "1.2.4"), -1);
  assert.equal(meetsMinimumVersion("garbage"), false);
  assert.equal(newerThanVerified("v99.0.0"), true);
  assert.equal(newerThanVerified("99.0.0-beta"), true);
  assert.equal(newerThanVerified("garbage"), false);
});

// A four-part version compares on all four parts. Reading only the first three
// made 1.2.11.1 equal to 1.2.11, so a build past the verified version raised no
// drift warning.
test("compareVersions and the gates read every part of a four-part version", () => {
  assert.equal(compareVersions("1.2.11.1", "1.2.11"), 1);
  assert.equal(compareVersions("1.2.11", "1.2.11.1"), -1);
  assert.equal(compareVersions("1.2.11.0", "1.2.11"), 0);
  assert.equal(compareVersions("v1.2.11.2-beta", "1.2.11.1"), 1);
  assert.equal(compareVersions("1.2.10.9", "1.2.11"), -1);
  assert.equal(newerThanVerified("1.2.11.1", "1.2.11"), true);
  assert.equal(newerThanVerified("1.2.11.0", "1.2.11"), false);
  assert.equal(meetsMinimumVersion("1.2.3.9", "1.2.4"), false);
  assert.equal(meetsMinimumVersion("1.2.4.1", "1.2.4"), true);
});

// The below-floor branch cannot be exercised on this machine, whose agy is
// above the floor, so the report assembly takes its inputs from `buildReport`
// and the probes are injected here. What is pinned: an agy under the floor
// skips both probes entirely, the report is not ready, and the one next step
// names the version found as well as the floor it missed.
const BELOW_FLOOR_AGY = {
  available: true,
  detail: "agy 1.1.28",
  path: "/usr/local/bin/agy",
  version: "1.1.28",
  minimumVersion: MIN_AGY_VERSION,
  meetsMinimum: false
};

function reportBelowFloor() {
  const calls = { auth: 0, tools: 0 };
  const report = buildReport({
    cwd: os.tmpdir(),
    node: { available: true, detail: "v22.0.0" },
    agy: BELOW_FLOOR_AGY,
    agySettings: { path: "settings.json", readable: false, toolPermission: "request-review" },
    gateOn: false,
    checkAuth: () => {
      calls.auth += 1;
      throw new Error("the auth probe ran below the floor");
    },
    checkToolPermissions: () => {
      calls.tools += 1;
      throw new Error("the tool probe ran below the floor");
    }
  });
  return { report, calls };
}

test("an agy below the floor skips both probes", () => {
  const { calls } = reportBelowFloor();
  assert.equal(calls.auth, 0);
  assert.equal(calls.tools, 0);
});

test("an agy below the floor is not ready and says so in both probe details", () => {
  const { report } = reportBelowFloor();
  assert.equal(report.ready, false);
  assert.equal(report.auth.detail, "not checked; agy is below the minimum version");
  assert.equal(report.toolPermissions.detail, "not checked; agy is below the minimum version");
  assert.equal(report.auth.available, false);
  assert.equal(report.toolPermissions.available, false);
});

test("the below-floor next step names the version found and the floor it missed", () => {
  const { report } = reportBelowFloor();
  assert.equal(report.nextSteps.length, 1);
  assert.match(report.nextSteps[0], /agy 1\.1\.28 is below the 1\.2\.4/);
  assert.match(report.nextSteps[0], /agy update/);
  assert.match(report.nextSteps[0], /probes were skipped/);
});

// F80. A report with no readable version is a distinct case from a version
// that parsed and came in under the floor: saying "is below the floor" for a
// version that could not even be read is a false claim, since an unparsable
// version could be well above the floor and simply printed in a shape
// meetsMinimumVersion does not gate on yet.
test("a below-floor report with no version says the version could not be read, not that it is below the floor", () => {
  const report = buildReport({
    cwd: os.tmpdir(),
    node: { available: true, detail: "v22.0.0" },
    agy: { ...BELOW_FLOOR_AGY, version: null },
    agySettings: { toolPermission: "request-review" },
    gateOn: false,
    checkAuth: () => assert.fail("the auth probe ran below the floor"),
    checkToolPermissions: () => assert.fail("the tool probe ran below the floor")
  });
  assert.match(report.nextSteps[0], /could not (be )?(read|parse)/i);
  assert.doesNotMatch(report.nextSteps[0], /is below the 1\.2\.4/);
});

// F80. `meetsMinimumVersion` and `compareVersions` gate on the raw
// `agy --version` output. A future prefixed or suffixed print ("agy 1.3.0",
// "1.2.4-beta", "v1.2.4") failed the gate outright and, worse, printed a
// literal, doubled "agy agy 1.3.0 is below the 1.2.4 floor" report. Extracting
// the numeric core first keeps the gate and the printed detail on the same
// value, whatever wrapping agy's own output carries.
test("extractVersionNumber pulls the numeric core out of a prefixed, suffixed, or bare version", () => {
  assert.equal(extractVersionNumber("1.2.6"), "1.2.6");
  assert.equal(extractVersionNumber("agy 1.3.0"), "1.3.0");
  assert.equal(extractVersionNumber("v1.2.4"), "1.2.4");
  assert.equal(extractVersionNumber("1.2.4-beta"), "1.2.4");
  // Every part of a longer version is kept, not the first three.
  assert.equal(extractVersionNumber("1.2.11.1"), "1.2.11.1");
  assert.equal(extractVersionNumber("agy v1.2.11.1-rc2"), "1.2.11.1");
  assert.equal(extractVersionNumber("unknown"), null);
  assert.equal(extractVersionNumber(""), null);
  assert.equal(extractVersionNumber(null), null);
  assert.equal(extractVersionNumber(undefined), null);
});

// F93. agy updates itself silently, and every contract line is stamped with
// the version it was checked on. The floor refuses an agy that is too old; a
// newer one than the contract was last verified on still runs, but setup says
// so, so drift is noticed instead of discovered mid-run.
test("the verified version is the one the runtime contract is stamped with", () => {
  assert.equal(compareVersions(VERIFIED_AGY_VERSION, MIN_AGY_VERSION), 1);
  const runtime = read("skills/agy-cli-runtime/SKILL.md");
  assert.ok(
    runtime.includes(`Re-checked on agy ${VERIFIED_AGY_VERSION}`),
    `skills/agy-cli-runtime/SKILL.md is not stamped with ${VERIFIED_AGY_VERSION}`
  );
});

test("newerThanVerified is true only above the verified version", () => {
  assert.equal(newerThanVerified(VERIFIED_AGY_VERSION), false);
  assert.equal(newerThanVerified("1.2.4"), false);
  assert.equal(newerThanVerified("99.0.0"), true);
  assert.equal(newerThanVerified("not a version"), false);
  assert.equal(newerThanVerified(null), false);
});

function readyReport(version) {
  return buildReport({
    cwd: os.tmpdir(),
    node: { available: true, detail: "v22.0.0" },
    agy: {
      available: true,
      detail: `agy ${version}`,
      path: "/usr/bin/agy",
      version,
      minimumVersion: MIN_AGY_VERSION,
      meetsMinimum: true,
      verifiedVersion: VERIFIED_AGY_VERSION,
      newerThanVerified: newerThanVerified(version)
    },
    agySettings: { toolPermission: "always-proceed" },
    gateOn: true,
    checkAuth: () => ({ available: true, loggedIn: true, detail: "ok", failureKind: null, durationSeconds: 1 }),
    checkToolPermissions: () => ({ available: true, detail: "ok", deniedActions: [], command: null, read: null, durationSeconds: 1 })
  });
}

test("an agy newer than the verified version stays ready and gets a drift warning", () => {
  const report = readyReport("99.0.0");
  assert.equal(report.ready, true);
  assert.equal(report.nextSteps.length, 1);
  assert.match(report.nextSteps[0], /agy 99\.0\.0 is newer than/);
  assert.ok(report.nextSteps[0].includes(VERIFIED_AGY_VERSION));
});

test("an agy at the verified version gets no drift warning", () => {
  const report = readyReport(VERIFIED_AGY_VERSION);
  assert.equal(report.ready, true);
  assert.deepEqual(report.nextSteps, []);
});

test("the floor still wins over the drift warning", () => {
  const report = buildReport({
    cwd: os.tmpdir(),
    node: { available: true, detail: "v22.0.0" },
    agy: { available: true, version: "1.1.28", minimumVersion: MIN_AGY_VERSION, meetsMinimum: false, newerThanVerified: false },
    agySettings: { toolPermission: "request-review" },
    gateOn: false,
    checkAuth: () => assert.fail("the auth probe ran below the floor"),
    checkToolPermissions: () => assert.fail("the tool probe ran below the floor")
  });
  assert.equal(report.nextSteps.length, 1);
  assert.match(report.nextSteps[0], /below the 1\.2\.4/);
});

// F121. Every probe passes `--add-dir <workspace root>` and runs with the
// workspace root as its cwd, the way every other agy run in the plugin does.
// The setup script is run end to end against a stub agy that logs the argv and
// the cwd it was started with; nothing here reaches the real agy.
test("each setup probe passes --add-dir and runs in the workspace root", { skip: process.platform === "win32" }, () => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-setup-probe-")));
  scratchDirs.push(scratch);
  const workspace = path.join(scratch, "repo");
  const subdir = path.join(workspace, "src", "deep");
  fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
  fs.mkdirSync(subdir, { recursive: true });
  const bin = path.join(scratch, "bin");
  fs.mkdirSync(bin);
  const log = path.join(scratch, "calls.log");
  fs.writeFileSync(
    path.join(bin, "agy"),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "${MIN_AGY_VERSION}"; exit 0; fi
printf '%s\t%s\n' "$PWD" "$*" >> "${log}"
echo '{"conversation_id":"c","status":"SUCCESS","response":"OK /tmp","duration_seconds":1,"num_turns":1}'
`,
    { mode: 0o755 }
  );

  const run = spawnSync(process.execPath, [path.join(ROOT, "scripts", "agy-setup.mjs")], {
    cwd: subdir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: scratch, CLAUDE_PROJECT_DIR: "" }
  });
  assert.equal(run.status, 0, run.stderr);

  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => {
    const [cwd, argv] = line.split("\t");
    return { cwd, argv };
  });
  // The auth probe, the command probe and the read probe.
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.cwd, workspace, `a probe ran in ${call.cwd}, not the workspace root`);
    assert.ok(call.argv.includes(`--add-dir ${workspace} `), `a probe's argv has no --add-dir ${workspace}: ${call.argv}`);
    assert.equal(call.argv.split("--add-dir").length, 2, "a probe passed --add-dir more than once");
  }
});

// The setup script run end to end against a stub agy that logs the cwd and argv
// of every probe. Returns the parsed report and the logged probe calls.
function runSetupWithStub({ projectDir, cwd, prepare } = {}) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-setup-run-")));
  scratchDirs.push(scratch);
  const bin = path.join(scratch, "bin");
  fs.mkdirSync(bin);
  const log = path.join(scratch, "calls.log");
  fs.writeFileSync(
    path.join(bin, "agy"),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "${MIN_AGY_VERSION}"; exit 0; fi
printf '%s\t%s\n' "$PWD" "$*" >> "${log}"
echo '{"conversation_id":"c","status":"SUCCESS","response":"OK /tmp","duration_seconds":1,"num_turns":1}'
`,
    { mode: 0o755 }
  );
  const context = { scratch };
  const restore = prepare ? prepare(context) : null;
  try {
    const run = spawnSync(process.execPath, [path.join(ROOT, "scripts", "agy-setup.mjs")], {
      cwd: cwd ?? scratch,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        HOME: scratch,
        CLAUDE_PROJECT_DIR: typeof projectDir === "function" ? projectDir(context) : projectDir ?? ""
      }
    });
    let calls = [];
    try {
      calls = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => {
        const [probeCwd, argv] = line.split("\t");
        return { cwd: probeCwd, argv };
      });
    } catch {}
    return { run, report: JSON.parse(run.stdout), calls, scratch };
  } finally {
    restore?.();
  }
}

// A CLAUDE_PROJECT_DIR that does not exist, or cannot be entered, makes the
// probe's spawn fail before agy starts. That used to read as a non-zero exit
// and send the user to sign in again.
test("a workspace root agy cannot start in is reported as a spawn error, not a sign-in problem", { skip: process.platform === "win32" }, () => {
  const missing = runSetupWithStub({ projectDir: ({ scratch }) => path.join(scratch, "does-not-exist") });
  assert.equal(missing.report.ready, false);
  assert.equal(missing.report.auth.failureKind, "spawn-error");
  assert.match(missing.report.auth.detail, /does-not-exist: spawn-error \(ENOENT\)/);
  assert.equal(missing.calls.length, 0, "a probe reached the stub agy");
  assert.equal(missing.report.nextSteps.length, 1);
  assert.match(missing.report.nextSteps[0], /could not be started in the workspace root .*does-not-exist/);
  assert.match(missing.report.nextSteps[0], /CLAUDE_PROJECT_DIR/);
  assert.match(missing.report.nextSteps[0], /not a sign-in problem/);
  assert.doesNotMatch(missing.report.nextSteps[0], /once interactively|failed without naming a cause/);
});

test("a workspace root that cannot be entered is reported as a spawn error", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  let locked;
  const result = runSetupWithStub({
    projectDir: ({ scratch }) => path.join(scratch, "locked"),
    prepare: ({ scratch }) => {
      locked = path.join(scratch, "locked");
      fs.mkdirSync(locked);
      fs.chmodSync(locked, 0o600);
      return () => fs.chmodSync(locked, 0o700);
    }
  });
  assert.equal(result.report.auth.failureKind, "spawn-error");
  assert.match(result.report.auth.detail, /spawn-error \(EACCES\)/);
  assert.equal(result.calls.length, 0);
});

// With a workspace root it cannot write to, setup used to plant the read
// probe's marker under /tmp, outside the one directory the probe adds with
// --add-dir, so a pass there said nothing about repository reads. The read
// probe is now skipped and says so; the command probe still runs and decides.
test("an unwritable workspace root skips the read probe instead of probing a temp file", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  let workspace;
  const result = runSetupWithStub({
    projectDir: ({ scratch }) => path.join(scratch, "repo"),
    prepare: ({ scratch }) => {
      workspace = path.join(scratch, "repo");
      fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
      fs.chmodSync(workspace, 0o555);
      return () => fs.chmodSync(workspace, 0o755);
    }
  });
  assert.equal(result.run.status, 0, result.run.stderr);
  const { toolPermissions } = result.report;
  assert.equal(toolPermissions.read.skipped, "workspace-not-writable");
  assert.equal(toolPermissions.read.available, true);
  assert.match(toolPermissions.read.detail, /read probe skipped: no marker file could be written in the workspace root .*repo \(EACCES\)/);
  assert.equal(toolPermissions.available, toolPermissions.command.available);
  // The auth probe and the command probe only, both in the workspace root.
  assert.equal(result.calls.length, 2);
  for (const call of result.calls) {
    assert.equal(call.cwd, workspace);
    assert.doesNotMatch(call.argv, /probe\.txt|file viewing tool/);
  }
});
