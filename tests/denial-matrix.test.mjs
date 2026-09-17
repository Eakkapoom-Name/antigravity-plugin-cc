import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DENIAL_CASES,
  assertScratchHome,
  evaluateCase,
  mergeSettings
} from "../scripts/lib/denial-matrix.mjs";

function caseById(id) {
  const found = DENIAL_CASES.find((entry) => entry.id === id);
  assert.ok(found, `no case named ${id}`);
  return found;
}

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
  const entry = caseById("request-review-default");
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
  const entry = caseById("request-review-default");
  const result = evaluateCase(entry, report({ ready: true, toolPermission: "request-review" }));
  assert.equal(result.pass, false);
  assert.ok(
    result.failures.some((line) => /ready/.test(line)),
    `no failure named ready: ${result.failures.join(" | ")}`
  );
});

test("a denial the case requires must appear in deniedActions", () => {
  const entry = caseById("proceed-in-sandbox");
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
  const entry = caseById("proceed-in-sandbox");
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
    report({
      ready: false,
      toolPermission: "request-review",
      declared: entry.settings.toolPermission,
      denied: ["command"],
      nextSteps: ["Your `toolPermission` is `request-review`, agy's default. command(*) read_file(*)"]
    })
  );
  assert.equal(result.pass, true, result.failures.join(" | "));
});

test("the scratch HOME guard refuses the real home directory", () => {
  assert.throws(() => assertScratchHome(os.homedir()), /refusing/i);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-"));
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
  const entry = caseById("unknown-mode");
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
  const entry = caseById("request-review-default");
  assert.ok(
    !(entry.expect.nextStepIncludes ?? []).some((fragment) => /\(\*\)/.test(fragment)),
    "the default case still pins one tool's rule in nextStepIncludes"
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
