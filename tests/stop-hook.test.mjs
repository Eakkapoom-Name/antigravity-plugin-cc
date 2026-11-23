import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { judgeReview, parseReviewResponse } from "../scripts/lib/stop-review.mjs";
import { emptyResult } from "../scripts/lib/agy.mjs";
import { setGate } from "../scripts/lib/state.mjs";
import { ROOT, read } from "./helpers.mjs";

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

// agy 1.5.14 compatibility, F1: the gate reviews the repository with the
// previous turn as untrusted input, so it runs under the read-only profile:
// plan mode with request-review and commands and file writes denied, the
// captain's model plus the deny list measured on 1.5.14. A fake agy on PATH
// reports 1.5.14 and records the argv of the review run, so the test sees what
// the hook really passes.
test("the hook runs agy under the read-only profile", { skip: process.platform === "win32" }, () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agy-stop-hook-"));
  try {
    const root = path.join(scratch, "repo");
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    const dataDir = path.join(scratch, "data");
    fs.mkdirSync(dataDir);
    const bin = path.join(scratch, "bin");
    fs.mkdirSync(bin);
    const argvFile = path.join(scratch, "argv.txt");
    fs.writeFileSync(
      path.join(bin, "agy"),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.5.14; exit 0; fi\nprintf \'%s\\n\' "$@" > "$AGY_ARGV_FILE"\ncat > /dev/null\n',
      { mode: 0o755 }
    );

    const previous = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    try {
      setGate(root, true);
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_PLUGIN_DATA;
      } else {
        process.env.CLAUDE_PLUGIN_DATA = previous;
      }
    }

    const hook = spawnSync(process.execPath, [path.join(ROOT, "scripts", "stop-review-gate-hook.mjs")], {
      input: JSON.stringify({ cwd: root, last_assistant_message: "Edited src/a.js." }),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        CLAUDE_PLUGIN_DATA: dataDir,
        AGY_ARGV_FILE: argvFile
      }
    });
    assert.equal(hook.status, 0, hook.stderr);
    assert.ok(fs.existsSync(argvFile), "the hook never ran the review through agy");

    const argv = fs.readFileSync(argvFile, "utf8").split("\n").slice(0, -1);
    assert.ok(argv.includes("-p="), `not a print-mode run: ${argv.join(" ")}`);
    const settings = argv.indexOf("--settings");
    assert.notEqual(settings, -1, `no --settings in ${argv.join(" ")}`);
    assert.deepEqual(JSON.parse(argv[settings + 1]), {
      toolPermission: "request-review",
      agentMode: "auto",
      permissions: { allow: [], deny: ["write_file(*)", "command(*)", "mcp(*)", "execute_url(*)"] }
    });
    assert.equal(argv[argv.indexOf("--mode") + 1], "plan", `read-only gate mode: ${argv.join(" ")}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("a print timeout blocks with a timeout reason, not a model error", () => {
  const judged = judgeReview(run({ ok: false, failure: "timeout", result: emptyResult({ status: "SUCCESS", response: "partial", finished_reason: "print_timeout" }) }));
  assert.equal(judged.ok, false);
  assert.match(judged.reason, /timed out before it finished/);
});
