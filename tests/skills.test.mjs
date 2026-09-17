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

const CLI_RUNTIME = read("skills/agy-cli-runtime/SKILL.md");

// Issue #21: a headless run can return SUCCESS, exit 0, a non-empty response,
// and a `denied_actions` array saying the one tool call it needed was refused.
// The empty-response rule does not fire, so that shape has to be its own rule.
test("result handling treats a non-empty denied_actions array as a failure", () => {
  assert.match(RESULT_HANDLING, /`denied_actions`/);
  assert.match(RESULT_HANDLING, /even when `status` is `SUCCESS`/);
  assert.match(RESULT_HANDLING, /read_file/);
  assert.match(RESULT_HANDLING, /ViewFile/);
});

test("result handling names read_file(*) next to command rules", () => {
  assert.match(RESULT_HANDLING, /read_file\(\*\)/);
  assert.match(RESULT_HANDLING, /command\(/);
});

test("result handling makes the settings edit a manual step outside an auto mode session", () => {
  assert.match(RESULT_HANDLING, /by hand/);
  assert.match(RESULT_HANDLING, /Create Unsafe Agents/);
  // The agent must stop and hand over, not attempt the edit or the skip flag.
  assert.match(RESULT_HANDLING, /do not attempt/i);
  assert.match(RESULT_HANDLING, /--dangerously-skip-permissions/);
});

test("result handling documents the operator-runs-commands fallback", () => {
  // The reporter finished the delegation without any permission change by
  // running the shell steps themselves and inlining every file agy would have
  // read. That is the only route left when the settings edit is blocked.
  assert.match(RESULT_HANDLING, /inline/i);
  assert.match(RESULT_HANDLING, /no shell and no file-read access/);
});

test("runtime contract records the effort and model incompatibility", () => {
  assert.match(CLI_RUNTIME, /--effort is not supported for model/);
  assert.match(CLI_RUNTIME, /without `--effort`/);
});

test("runtime contract records the interactive-mode gotchas", () => {
  assert.match(CLI_RUNTIME, /-i=/);
  assert.match(CLI_RUNTIME, /TTY/);
});

test("runtime contract documents denied_actions in the result shape", () => {
  assert.match(CLI_RUNTIME, /denied_actions/);
  assert.match(CLI_RUNTIME, /read_file\(\*\)/);
});

// F18. `--mode plan` was documented as unexplored. It was run on 1.2.4 and did
// not stay plan-only in print mode, which is why the rescue flow does not
// expose it and read-only runs keep omitting --mode instead.
test("runtime contract records what --mode plan actually did and does not expose it", () => {
  assert.ok(!/Unexplored here/.test(CLI_RUNTIME), "the runtime skill still calls --mode plan unexplored");
  assert.match(CLI_RUNTIME, /`--mode plan`/);
  assert.match(CLI_RUNTIME, /edited .* in the same turn/);
  assert.match(CLI_RUNTIME, /not exposed/);
});

// F22. Both skills claimed in-workspace reads pass without a rule. That held
// only because this machine runs always-proceed; issue #21 disproved it.
for (const [label, source] of [["result handling", RESULT_HANDLING], ["runtime contract", CLI_RUNTIME]]) {
  test(`${label} no longer claims in-workspace reads are auto-approved`, () => {
    assert.ok(
      !/reads inside the workspace[^.]*(passed|were auto-approved)/i.test(source),
      `${label} still claims in-workspace reads pass without a rule`
    );
  });

  test(`${label} names toolPermission as the deciding setting`, () => {
    assert.match(source, /`toolPermission`/);
    assert.match(source, /always-proceed/);
    assert.match(source, /request-review/);
  });
}

test("runtime contract records that agy has no per-invocation permission flag", () => {
  // Checked against agy 1.2.4: no --tool-permission flag and no environment
  // variable, so the mode cannot be overridden for one run.
  assert.match(CLI_RUNTIME, /no .*flag|cannot be overridden|per-invocation/i);
});

// F24. Correcting 0.6.4's false claim went one step too far: both skills then
// said the default mode refuses reads, which three live runs disproved.
for (const [label, source] of [["result handling", RESULT_HANDLING], ["runtime contract", CLI_RUNTIME]]) {
  test(`${label} does not claim the default mode refuses in-workspace reads`, () => {
    assert.ok(
      !/request-review[^.]*refuse[sd]? reads/i.test(source),
      `${label} still says request-review refuses reads`
    );
    assert.match(source, /read of a file inside the workspace was allowed/i);
    // The reporter did see one denied, so the measurement must not be presented
    // as the whole truth either.
    assert.match(source, /issue #21/);
  });
}

// F21. The companion resumes a denied conversation once by itself. The skill has
// to say what the resulting `recovery` field means, or a recovered run reads as
// a plain success and the missing rule never reaches the user.
test("result handling explains the automatic resume after a denial", () => {
  assert.match(RESULT_HANDLING, /`recovery`/);
  assert.match(RESULT_HANDLING, /conversation_id/);
  // One resume is automatic; a second, with file contents inlined, is a choice
  // only the caller can make, because agy never says which file it wanted.
  assert.match(RESULT_HANDLING, /once/i);
  assert.match(RESULT_HANDLING, /inline/i);
});

// A resumed turn that ran without a denial is not the same as a finished task:
// the live probe came back `recovered: true` with the model saying it could not
// do the work without the tool it was refused.
test("result handling says what recovered actually means", () => {
  assert.match(RESULT_HANDLING, /recovered.{0,120}without (a|another) denial/is);
  assert.ok(
    !/`recovery.recovered: true`\. The work was done/.test(RESULT_HANDLING),
    "result handling still equates a resumed turn with a finished task"
  );
});
