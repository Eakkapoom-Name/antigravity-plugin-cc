import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DENIAL_CASES,
  OUTCOME_CASES,
  OUTCOME_NONCE,
  OUTCOME_SECRET_NONCE,
  assertScratchHome,
  evaluateCase,
  evaluateOutcome,
  fillOutcomePrompt,
  fillOutcomeSettings,
  mergeSettings
} from "../scripts/lib/denial-matrix.mjs";

// F69. Every temp directory made here is removed once the file's tests are
// done, the way companion.test.mjs and output-path.test.mjs already clean up.
const scratchDirs = [];
after(() => {
  for (const dir of scratchDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function caseById(id) {
  const found = DENIAL_CASES.find((entry) => entry.id === id);
  assert.ok(found, `no case named ${id}`);
  return found;
}

// The mechanics of evaluateCase, checked on a synthetic row that expects a
// denial: since the per-run pin no live setup row does, but the evaluator still
// has to read every expectation shape correctly (an agy below 1.4.10 measures
// the user's own settings again).
const DENIAL_EXPECTING = {
  id: "synthetic-denial",
  settings: { toolPermission: "request-review" },
  expect: {
    ready: false,
    toolPermission: "request-review",
    deniedNonEmpty: true,
    nextStepIncludes: ["`request-review`"],
    nextStepIncludesAny: ["command(*)", "read_file(*)"]
  }
};
const SANDBOX_EXPECTING = {
  id: "synthetic-sandbox",
  settings: { toolPermission: "proceed-in-sandbox" },
  expect: { ready: false, toolPermission: "proceed-in-sandbox", deniedIncludes: ["command"], nextStepIncludes: ["`proceed-in-sandbox`", "--sandbox"] }
};

function report({ ready, toolPermission, declared, denied = [], nextSteps = [] }) {
  return {
    ready,
    toolPermissions: { deniedActions: denied },
    agySettings: {
      toolPermission,
      declaredToolPermission: declared === undefined ? toolPermission : declared
    },
    nextSteps
  };
}

test("every mode agy accepts has a case, and each case names the settings it writes", () => {
  const modes = DENIAL_CASES.map((entry) => entry.settings.toolPermission);
  for (const mode of ["request-review", "proceed-in-sandbox", "always-proceed", "strict"]) {
    assert.ok(modes.includes(mode), `no case covers toolPermission ${mode}`);
  }
  for (const entry of DENIAL_CASES) {
    assert.equal(typeof entry.id, "string");
    assert.ok(entry.id.length > 0);
    assert.equal(typeof entry.settings, "object");
    assert.equal(typeof entry.expect.ready, "boolean");
  }
});

test("a case passes only when the live report matches every expectation", () => {
  const entry = DENIAL_EXPECTING;
  const matching = evaluateCase(
    entry,
    report({
      ready: false,
      toolPermission: "request-review",
      denied: ["command", "read_file"],
      nextSteps: [
        "Denied here: command, read_file. Your `toolPermission` is `request-review`, agy's default. Commands. Broad: command(*). File reads: read_file(*)."
      ]
    })
  );
  assert.equal(matching.pass, true, matching.failures.join(" | "));
  assert.deepEqual(matching.failures, []);
});

test("a ready report fails a case that expects a denial, and says which field disagreed", () => {
  const entry = DENIAL_EXPECTING;
  const result = evaluateCase(entry, report({ ready: true, toolPermission: "request-review" }));
  assert.equal(result.pass, false);
  assert.ok(
    result.failures.some((line) => /ready/.test(line)),
    `no failure named ready: ${result.failures.join(" | ")}`
  );
});

test("a denial the case requires must appear in deniedActions", () => {
  const entry = SANDBOX_EXPECTING;
  const result = evaluateCase(
    entry,
    report({
      ready: false,
      toolPermission: "proceed-in-sandbox",
      denied: ["read_file"],
      nextSteps: ["Your `toolPermission` is `proceed-in-sandbox` and needs --sandbox."]
    })
  );
  assert.equal(result.pass, false);
  assert.ok(
    result.failures.some((line) => /command/.test(line)),
    `no failure named the missing denial: ${result.failures.join(" | ")}`
  );
});

test("a remedy the case requires must appear in nextSteps", () => {
  const entry = SANDBOX_EXPECTING;
  const result = evaluateCase(
    entry,
    report({
      ready: false,
      toolPermission: "proceed-in-sandbox",
      denied: ["command"],
      nextSteps: ["Something generic with no mode guidance."]
    })
  );
  assert.equal(result.pass, false);
  assert.ok(
    result.failures.some((line) => /nextSteps/.test(line)),
    `no failure named nextSteps: ${result.failures.join(" | ")}`
  );
});

test("a mode agy rejects is reported as declared but resolved to the default", () => {
  const entry = caseById("unknown-mode");
  assert.equal(entry.expect.toolPermission, "request-review");
  assert.notEqual(entry.settings.toolPermission, "request-review");
  const result = evaluateCase(
    entry,
    report({ ready: true, toolPermission: "request-review", declared: entry.settings.toolPermission })
  );
  assert.equal(result.pass, true, result.failures.join(" | "));
});

test("the scratch HOME guard refuses the real home directory", () => {
  assert.throws(() => assertScratchHome(os.homedir()), /refusing/i);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-"));
  scratchDirs.push(scratch);
  assert.equal(assertScratchHome(scratch), path.resolve(scratch));
});

// The first live run timed out on the command probe because the harness wrote a
// settings file holding nothing but `toolPermission`, which dropped the user's
// model choice and their trusted workspace list. Only the permission keys are
// the experiment; everything else has to come through untouched.
test("case settings are merged over the real file, not written in place of it", () => {
  const base = {
    model: "Gemini 3.8 Flash (Medium)",
    verbosity: "low",
    toolPermission: "always-proceed",
    trustedWorkspaces: ["/home/someone"]
  };
  const merged = mergeSettings(base, caseById("request-review-default"), "/scratch/home");

  assert.equal(merged.model, "Gemini 3.8 Flash (Medium)");
  assert.equal(merged.verbosity, "low");
  assert.equal(merged.toolPermission, "request-review");
  assert.ok(merged.trustedWorkspaces.includes("/home/someone"));
  assert.ok(merged.trustedWorkspaces.includes("/scratch/home"));
});

test("a case with no allow-list clears any rules the real file carried", () => {
  const base = { toolPermission: "always-proceed", permissions: { allow: ["command(*)"] } };
  const merged = mergeSettings(base, caseById("request-review-default"), "/scratch/home");
  assert.equal(merged.permissions, undefined);
});

test("a case that supplies rules writes exactly those rules", () => {
  const base = { permissions: { allow: ["read_file(/etc/*)"] } };
  const merged = mergeSettings(base, caseById("request-review-with-rules"), "/scratch/home");
  assert.deepEqual(merged.permissions.allow, ["command(*)", "read_file(*)"]);
});

// The live matrix denied `read_file` where the case expected `command`: agy
// picks the tool it reaches for first, and that varies between runs of the same
// prompt. A case that names one action makes a true denial look like a miss.
test("a case can require a denial without naming which action was denied", () => {
  const entry = { ...DENIAL_EXPECTING, expect: { ...DENIAL_EXPECTING.expect, nextStepIncludesAny: [], declaredToolPermission: "agent-decides" } };
  const denied = evaluateCase(
    entry,
    report({
      ready: false,
      toolPermission: "request-review",
      declared: "agent-decides",
      denied: ["read_file"],
      nextSteps: ["Your `toolPermission` is `request-review`, agy's default."]
    })
  );
  assert.equal(denied.pass, true, denied.failures.join(" | "));

  const nothingDenied = evaluateCase(
    entry,
    report({
      ready: false,
      toolPermission: "request-review",
      declared: "agent-decides",
      denied: [],
      nextSteps: ["Your `toolPermission` is `request-review`, agy's default."]
    })
  );
  assert.equal(nothingDenied.pass, false);
  assert.ok(
    nothingDenied.failures.some((line) => /deniedActions/.test(line)),
    `no failure named deniedActions: ${nothingDenied.failures.join(" | ")}`
  );
});

// The trusted-workspace list is the suspected reason an in-workspace read
// passed under the default mode with no rule, so one case has to run untrusted.
test("a case can opt out of trusting the scratch workspace", () => {
  const entry = caseById("request-review-untrusted");
  assert.equal(entry.trustScratchWorkspace, false);
  const merged = mergeSettings({ trustedWorkspaces: ["/home/someone"] }, entry, "/scratch/home");
  assert.deepEqual(merged.trustedWorkspaces, ["/home/someone"]);
});

// F26. `request-review-default` asserted the remedy names `command(*)`, and a
// rerun failed at 8 of 9 because that run's command probe was denied for
// `read_file` instead. The same nondeterminism that stopped cases naming a
// denied action stops them naming one rule.
test("a case can require the remedy to name a rule without saying which", () => {
  const entry = DENIAL_EXPECTING;
  assert.ok(
    !(entry.expect.nextStepIncludes ?? []).some((fragment) => /\(\*\)/.test(fragment)),
    "the case pins one tool's rule in nextStepIncludes"
  );

  for (const rule of ["command(*)", "read_file(*)"]) {
    const result = evaluateCase(
      entry,
      report({
        ready: false,
        toolPermission: "request-review",
        denied: [rule.replace("(*)", "")],
        nextSteps: [`Your \`toolPermission\` is \`request-review\`. Add ${rule}.`]
      })
    );
    assert.equal(result.pass, true, `${rule}: ${result.failures.join(" | ")}`);
  }

  const noRule = evaluateCase(
    entry,
    report({
      ready: false,
      toolPermission: "request-review",
      denied: ["command"],
      nextSteps: ["Your `toolPermission` is `request-review`. Good luck."]
    })
  );
  assert.equal(noRule.pass, false);
  assert.ok(
    noRule.failures.some((line) => /nextSteps/.test(line)),
    `no failure named nextSteps: ${noRule.failures.join(" | ")}`
  );
});

// Issue #21's reporter runs `request-review` with a populated `permissions.allow`
// holding command rules and no read rule, and their in-workspace read is denied.
// Every run here used an empty allow-list and the read passed. If a populated
// list is what turns the permissive path strict, that is the whole difference.
test("a case covers a populated allow-list that grants commands but no reads", () => {
  const entry = caseById("request-review-command-rules-only");
  assert.equal(entry.settings.toolPermission, "request-review");
  const allow = entry.settings.permissions.allow;
  assert.ok(allow.length > 0, "the case must carry a populated allow-list");
  assert.ok(
    allow.every((rule) => rule.startsWith("command(")),
    `the case must grant commands only, got ${allow.join(", ")}`
  );
  assert.ok(
    !allow.some((rule) => rule.startsWith("read_file(")),
    "the case must not grant a read rule; that is the variable under test"
  );
});

// The reporter's log line reads `workspaceDirs=[/home/natthanicha]`: their
// workspace root is their home directory itself, not a repository inside it.
// Every case here puts the workspace one level down, so that difference has
// never been under test.
test("a case can put the workspace at the home directory itself", () => {
  const entry = caseById("request-review-workspace-is-home");
  assert.equal(entry.workspaceAtHomeRoot, true);
  assert.equal(entry.settings.toolPermission, "request-review");
});

test("a report from an agy below the floor fails every row, so a denial is never mistaken for a permission result", () => {
  const testCase = DENIAL_CASES[0];
  const report = {
    ready: false,
    agy: { available: true, version: "1.2.3", minimumVersion: "1.2.4", meetsMinimum: false },
    agySettings: { toolPermission: testCase.settings.toolPermission },
    toolPermissions: { deniedActions: [] },
    nextSteps: ["Update agy"]
  };
  const outcome = evaluateCase(testCase, report);
  assert.equal(outcome.pass, false);
  assert.ok(outcome.failures.some((line) => /below the floor|1\.2\.3/.test(line)), outcome.failures.join("; "));
});

// agy 1.5.14 compatibility, F1. Every plugin run pins its own permissions, so
// on an agy with `--settings` no saved setting may change setup's verdict.
test("every setup row expects ready whatever the user saved, with no permission advice", () => {
  for (const entry of DENIAL_CASES) {
    assert.equal(entry.expect.ready, true, entry.id);
    assert.deepEqual(entry.expect.nextStepExcludes, ["Headless delegation is blocked"], entry.id);
  }
  const strict = caseById("strict");
  const advised = evaluateCase(
    strict,
    report({ ready: true, toolPermission: "strict", nextSteps: ["Headless delegation is blocked: agy refused command."] })
  );
  assert.equal(advised.pass, false);
  assert.ok(advised.failures.some((line) => /no mention of Headless delegation is blocked/.test(line)), advised.failures.join(" | "));
  assert.equal(evaluateCase(strict, report({ ready: true, toolPermission: "strict" })).pass, true);
});

const PATHS = { outside: "/out/marker.txt", inside: "/ws/created.txt", note: "/ws/note.txt", victim: "/ws/victim.txt" };

test("outcome rows cover every read-only refusal the addendum names, with a write control", () => {
  const ids = OUTCOME_CASES.map((entry) => entry.id);
  for (const id of [
    "read-only-shell-command",
    "read-only-authorized-claim",
    "read-only-user-allow-rule",
    "read-only-file-write",
    "read-only-file-edit",
    "read-only-read",
    "read-only-deny-control",
    "read-only-saved-deny-rule",
    "write-control"
  ]) {
    assert.ok(ids.includes(id), `no outcome row ${id}`);
  }
  const allowRule = OUTCOME_CASES.find((entry) => entry.id === "read-only-user-allow-rule");
  assert.deepEqual(allowRule.settings.permissions.allow, ["command(*)"]);
  const control = OUTCOME_CASES.find((entry) => entry.id === "write-control");
  assert.equal(control.profile, "write");
  assert.deepEqual(control.expect, { outside: true, victimKept: false, inside: true, noteChanged: true });
  for (const entry of OUTCOME_CASES.filter((row) => row.profile === "read-only")) {
    assert.notEqual(entry.expect.outside, true, entry.id);
    assert.notEqual(entry.expect.inside, true, entry.id);
    assert.notEqual(entry.expect.noteChanged, true, entry.id);
    assert.notEqual(entry.expect.victimKept, false, entry.id);
  }
});

test("fillOutcomePrompt puts the real paths and nonce in every placeholder", () => {
  const filled = fillOutcomePrompt("{OUTSIDE} {INSIDE} {NOTE} {VICTIM} {NONCE} {OUTSIDE}", PATHS);
  assert.equal(filled, `/out/marker.txt /ws/created.txt /ws/note.txt /ws/victim.txt ${OUTCOME_NONCE} /out/marker.txt`);
});

test("evaluateOutcome fails a read-only row whose file was written, and names what happened", () => {
  const entry = OUTCOME_CASES.find((row) => row.id === "read-only-file-write");
  assert.equal(evaluateOutcome(entry, { outside: false, inside: false }).pass, true);
  const written = evaluateOutcome(entry, { outside: true, inside: false });
  assert.equal(written.pass, false);
  assert.match(written.failures.join(" | "), /outside the workspace exists: expected false, got true/);
});

test("evaluateOutcome checks a read by the nonce in the response", () => {
  const entry = OUTCOME_CASES.find((row) => row.id === "read-only-read");
  assert.equal(evaluateOutcome(entry, { noteChanged: false, response: `${OUTCOME_NONCE}\n` }).pass, true);
  assert.equal(evaluateOutcome(entry, { noteChanged: false, response: "I cannot read it." }).pass, false);
});

test("evaluateOutcome fails the write control when an action did not happen", () => {
  const entry = OUTCOME_CASES.find((row) => row.id === "write-control");
  assert.equal(evaluateOutcome(entry, { outside: true, victimKept: false, inside: true, noteChanged: true }).pass, true);
  assert.equal(evaluateOutcome(entry, { outside: true, victimKept: true, inside: true, noteChanged: true }).pass, false);
});

const SECRET_PATHS = { ...PATHS, secret: "/ws/secret.txt" };

test("the saved-deny row writes the rule with the real secret path and expects the secret withheld", () => {
  const row = OUTCOME_CASES.find((entry) => entry.id === "read-only-saved-deny-rule");
  assert.equal(row.profile, "read-only");
  const settings = fillOutcomeSettings(row.settings, SECRET_PATHS);
  assert.deepEqual(settings.permissions.deny, ["read_file(/ws/secret.txt)"]);
  assert.equal(fillOutcomePrompt(row.prompt, SECRET_PATHS).includes("/ws/secret.txt"), true);
  assert.equal(evaluateOutcome(row, { response: "Blocked by a deny rule." }).pass, true);
  const leaked = evaluateOutcome(row, { response: `${OUTCOME_SECRET_NONCE}\n` });
  assert.equal(leaked.pass, false);
  assert.match(leaked.failures.join(" | "), /not to include SECRET-4419-agy/);
  // Its control reads the same file with no rule saved, so a pass is a refusal.
  const control = OUTCOME_CASES.find((entry) => entry.id === "read-only-deny-control");
  assert.equal(control.prompt, row.prompt);
  assert.equal(control.settings.permissions, undefined);
  assert.equal(evaluateOutcome(control, { response: `${OUTCOME_SECRET_NONCE}\n` }).pass, true);
});
