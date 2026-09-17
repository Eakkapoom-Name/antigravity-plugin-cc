import test from "node:test";
import assert from "node:assert/strict";

import { judgeReview, parseReviewResponse } from "../scripts/lib/stop-review.mjs";
import { emptyResult } from "../scripts/lib/agy.mjs";
import { read } from "./helpers.mjs";

// The shape runPrompt returns, so the hook's decision can be tested against the
// same payloads the rest of the plugin sees.
function run(overrides) {
  return { ok: true, failure: null, deniedActions: [], stderr: "", events: [], ...overrides };
}

test("an ALLOW first line lets the stop through", () => {
  assert.equal(parseReviewResponse("ALLOW: no code changes\nmore text").ok, true);
});

test("a BLOCK first line blocks with agy's reason", () => {
  const judged = parseReviewResponse("BLOCK: the retry loop never terminates");
  assert.equal(judged.ok, false);
  assert.match(judged.reason, /never terminates/);
});

test("an empty or unexpected answer fails closed", () => {
  assert.equal(parseReviewResponse("").ok, false);
  assert.match(parseReviewResponse("").reason, /no output/);
  assert.equal(parseReviewResponse("Sure, here is my review").ok, false);
  assert.match(parseReviewResponse("Sure, here is my review").reason, /unexpected answer/);
});

// F20. A headless denial used to fall through to "no output" or "unexpected
// answer", both true and neither useful: the gate is blocked until a rule is
// added, and the reason has to say which one.
test("a denied tool call blocks with the rule to add, not a generic message", () => {
  const judged = judgeReview(
    run({
      ok: false,
      failure: "denied",
      deniedActions: ["read_file"],
      result: {
        ...emptyResult({ status: "SUCCESS", response: "Reading the diff now.\n" }),
        denied_actions: [{ action: "read_file", display_name: "ViewFile" }]
      }
    })
  );
  assert.equal(judged.ok, false);
  assert.match(judged.reason, /auto-denied/);
  assert.match(judged.reason, /read_file\(\*\)/);
  assert.match(judged.reason, /by hand/);
  assert.match(judged.reason, /gate off/);
  assert.ok(!/unexpected answer|no output/.test(judged.reason));
});

test("a denied command names the command rule", () => {
  const judged = judgeReview(
    run({
      ok: false,
      failure: "denied",
      deniedActions: ["command"],
      result: emptyResult({ status: "SUCCESS" })
    })
  );
  assert.match(judged.reason, /command\(\*\)/);
});

test("a missing agy skips the gate with a note rather than blocking", () => {
  const judged = judgeReview(run({ ok: false, failure: "missing", result: emptyResult() }));
  assert.equal(judged.ok, true);
  assert.match(judged.note, /not installed/);
});

test("a timeout blocks and says so", () => {
  const judged = judgeReview(run({ ok: false, failure: "timeout", result: emptyResult() }));
  assert.equal(judged.ok, false);
  assert.match(judged.reason, /timed out/);
});

test("a non-SUCCESS status blocks with the status and error", () => {
  const judged = judgeReview(
    run({ ok: false, failure: "failed", result: emptyResult({ status: "ERROR", error: "boom" }) })
  );
  assert.equal(judged.ok, false);
  assert.match(judged.reason, /ERROR/);
  assert.match(judged.reason, /boom/);
});

test("a successful run is judged on its first line", () => {
  assert.equal(judgeReview(run({ result: emptyResult({ status: "SUCCESS", response: "ALLOW: fine" }) })).ok, true);
  assert.equal(judgeReview(run({ result: emptyResult({ status: "SUCCESS", response: "BLOCK: nope" }) })).ok, false);
});

test("the hook runs agy through the shared runPrompt and judges through the shared module", () => {
  const source = read("scripts/stop-review-gate-hook.mjs");
  assert.match(source, /runPrompt\(/);
  assert.match(source, /from "\.\/lib\/stop-review\.mjs"/);
  // The argv call is what kept denied_actions invisible to the gate.
  assert.ok(!/runCommand\(\s*"agy"/.test(source), "the hook still spawns agy through runCommand");
});
