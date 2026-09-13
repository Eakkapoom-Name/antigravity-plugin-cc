import test from "node:test";
import assert from "node:assert/strict";

import { read } from "./helpers.mjs";

const RESULT_HANDLING = read("skills/agy-result-handling/SKILL.md");

// The classifier refuses the delegation before agy runs, so the returned text
// is not agy JSON and carries no conversation_id. Every other rule in the skill
// assumes JSON, which is why the check has to come first.
test("result handling recognises a Claude Code auto mode denial", () => {
  assert.match(RESULT_HANDLING, /denied by the Claude Code auto mode classifier/);
  // The trailing Reason differs per denial, so the skill must key on the stable
  // fragment rather than a full sentence.
  assert.match(RESULT_HANDLING, /fragment, not on the full sentence/);
  for (const reason of ["Blocked by classifier", "Create Unsafe Agents", "Auto-Mode Bypass"]) {
    assert.ok(
      RESULT_HANDLING.includes(reason),
      `result handling does not name the observed denial reason ${reason}`
    );
  }
});

test("result handling gives both denial remedies, reliable one first", () => {
  const permissions = RESULT_HANDLING.indexOf("`/permissions`");
  const reword = RESULT_HANDLING.indexOf("Reword the task text");
  assert.ok(permissions > -1, "result handling does not name /permissions");
  assert.ok(reword > -1, "result handling does not offer rewording");
  assert.ok(
    permissions < reword,
    "rewording is offered before /permissions; rewording has failed before and /permissions has not"
  );
  assert.match(RESULT_HANDLING, /without asking for confirmation/);
  assert.match(RESULT_HANDLING, /never as the answer/);
});

test("result handling keeps a denial away from /agy:setup", () => {
  assert.match(RESULT_HANDLING, /do not send it to `\/agy:setup`/i);
});

test("result handling treats a plan ending in a question as zero edits", () => {
  assert.match(RESULT_HANDLING, /Proceed with implementation\?/);
  assert.match(RESULT_HANDLING, /made no edits/);
  assert.match(RESULT_HANDLING, /\/agy:continue <conversation_id>/);
});

test("result handling warns that pre-approving the plan trips the classifier", () => {
  // The obvious fix for the plan-only run is the exact phrasing that gets the
  // launch denied, so the two findings have to be linked in the text.
  const index = RESULT_HANDLING.indexOf("proceed without asking for confirmation");
  assert.ok(index > -1, "result handling does not warn about the pre-approval phrasing");
  assert.match(RESULT_HANDLING.slice(index), /trips the Claude Code classifier/);
});
