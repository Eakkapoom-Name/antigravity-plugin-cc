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

// Runs the real hook on `root` with the gate on and a fake agy first on PATH.
// The fake reports 1.5.14 to `--version`; on the review run it records its
// argv and the stdin it was handed, then answers with `response`. Returns the
// hook's spawn result, the recorded argv (null when agy was never asked to
// review), and the prompt text agy received.
function runHookWithFakeAgy(scratch, root, response, message = "Edited src/a.js.") {
  const dataDir = path.join(scratch, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const bin = path.join(scratch, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const argvFile = path.join(scratch, "argv.txt");
  const stdinFile = path.join(scratch, "stdin.txt");
  const result = JSON.stringify({ event: "result", result: emptyResult({ status: "SUCCESS", response }) });
  fs.writeFileSync(
    path.join(bin, "agy"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.5.14; exit 0; fi\nprintf '%s\\n' "$@" > "$AGY_ARGV_FILE"\ncat > "$AGY_STDIN_FILE"\nprintf '%s\\n' '${result.replace(/'/g, "'\\''")}'\n`,
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
    input: JSON.stringify({ cwd: root, last_assistant_message: message }),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      CLAUDE_PLUGIN_DATA: dataDir,
      AGY_ARGV_FILE: argvFile,
      AGY_STDIN_FILE: stdinFile
    }
  });
  const argv = fs.existsSync(argvFile) ? fs.readFileSync(argvFile, "utf8").split("\n").slice(0, -1) : null;
  let prompt = null;
  if (fs.existsSync(stdinFile)) {
    const line = fs.readFileSync(stdinFile, "utf8").split("\n").find((entry) => entry.trim());
    prompt = JSON.parse(line).message.content;
  }
  return { hook, argv, prompt };
}

// A real repository with one committed file, `a.js`.
function gitRepo(scratch) {
  const root = path.join(scratch, "repo");
  fs.mkdirSync(root);
  const git = (...args) => {
    const out = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
  };
  git("init", "--quiet");
  fs.writeFileSync(path.join(root, "a.js"), "const kept = 1;\n");
  git("add", "a.js");
  git("commit", "--quiet", "--no-verify", "-m", "init");
  return root;
}

// agy 1.5.14 compatibility, F1: the gate reviews the repository with the
// previous turn as untrusted input, so it runs under the read-only profile:
// plan mode with request-review and commands and file writes denied, the
// captain's model plus the deny list measured on 1.5.14.
test("the hook runs agy under the read-only profile", { skip: process.platform === "win32" }, () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agy-stop-hook-"));
  try {
    const root = path.join(scratch, "repo");
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    const { hook, argv } = runHookWithFakeAgy(scratch, root, "ALLOW: nothing to review");
    assert.equal(hook.status, 0, hook.stderr);
    assert.ok(argv, "the hook never ran the review through agy");
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

// Under the read-only profile agy cannot run `git diff`, so the hook hands it
// the diff. The oracle is git's own unified format for the edit the test makes
// (`diff --git a/a.js b/a.js`, then the added line with a `+`), and a
// plausible wrong behaviour it rejects is a prompt that only tells agy to look
// at the working tree, which it can no longer do.
test("a turn with edits goes to agy with the working-tree diff, and a BLOCK answer blocks", { skip: process.platform === "win32" }, () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agy-stop-hook-"));
  try {
    const root = gitRepo(scratch);
    fs.writeFileSync(path.join(root, "a.js"), "const kept = 1;\nconst changed = 2;\n");
    fs.writeFileSync(path.join(root, "b.js"), "export {};\n");
    const { hook, prompt } = runHookWithFakeAgy(scratch, root, "BLOCK: the new constant is never used");
    assert.equal(hook.status, 0, hook.stderr);
    assert.ok(prompt, "the hook never handed agy a prompt");
    assert.match(prompt, /^diff --git a\/a\.js b\/a\.js$/m);
    assert.match(prompt, /^\+const changed = 2;$/m);
    assert.match(prompt, /^b\.js$/m, "the untracked file is not listed for agy to read");
    assert.match(prompt, /no command is available/);
    const decision = JSON.parse(hook.stdout);
    assert.equal(decision.decision, "block");
    assert.match(decision.reason, /the new constant is never used/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("a turn with no uncommitted change still reaches agy, and an ALLOW answer lets the stop through", { skip: process.platform === "win32" }, () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agy-stop-hook-"));
  try {
    const root = gitRepo(scratch);
    const { hook, prompt } = runHookWithFakeAgy(scratch, root, "ALLOW: status update only");
    assert.equal(hook.status, 0, hook.stderr);
    assert.ok(prompt, "the hook never handed agy a prompt");
    assert.ok(!/^diff --git/m.test(prompt), "a clean tree produced a diff section");
    assert.equal(hook.stdout, "", `the stop was blocked: ${hook.stdout}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// The same screen /agy:review uses keeps a diff carrying a credential shape
// from leaving, but the gate does not block on it: agy reviews by reading the
// changed files, and the stop is decided by agy's answer alone. The fixture is
// AWS's documented example access key id.
function withCredential(scratch) {
  const root = gitRepo(scratch);
  const key = "AKIA" + "IOSFODNN7EXAMPLE";
  fs.writeFileSync(path.join(root, "a.js"), `const kept = 1;\nconst id = "${key}";\n`);
  fs.writeFileSync(path.join(root, "b.js"), "export {};\n");
  return { root, key };
}

test("a credential in the diff withholds the diff and agy reviews the changed files by reading them", { skip: process.platform === "win32" }, () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agy-stop-hook-"));
  try {
    const { root, key } = withCredential(scratch);
    const { hook, prompt } = runHookWithFakeAgy(scratch, root, "BLOCK: the id is hard-coded");
    assert.equal(hook.status, 0, hook.stderr);
    assert.ok(prompt, "the gate did not run the review");
    assert.ok(!prompt.includes(key), "the credential reached agy");
    assert.ok(!/^diff --git/m.test(prompt), "diff text reached agy");
    assert.match(prompt, /withheld/);
    assert.match(prompt, /^a\.js$/m, "the changed file is not listed for agy to read");
    assert.match(prompt, /^b\.js$/m, "the untracked file is not listed for agy to read");
    const decision = JSON.parse(hook.stdout);
    assert.equal(decision.decision, "block");
    assert.match(decision.reason, /the id is hard-coded/);
    assert.ok(!/redact/i.test(decision.reason));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("a credential left from an earlier turn does not block a turn with no edits", { skip: process.platform === "win32" }, () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agy-stop-hook-"));
  try {
    const { root } = withCredential(scratch);
    const { hook, prompt } = runHookWithFakeAgy(scratch, root, "ALLOW: answered a question", "The function returns a list.");
    assert.equal(hook.status, 0, hook.stderr);
    assert.ok(prompt, "the gate did not run the review");
    assert.equal(hook.stdout, "", `the stop was blocked: ${hook.stdout}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// A repository with no commit yet has no HEAD to diff against, so every file
// the previous turn created is untracked; agy has to be told which they are.
test("a repository with no commit yet still lists its new files for agy", { skip: process.platform === "win32" }, () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agy-stop-hook-"));
  try {
    const root = path.join(scratch, "repo");
    fs.mkdirSync(root);
    assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: root }).status, 0);
    fs.writeFileSync(path.join(root, "new.js"), "export {};\n");
    const { hook, prompt } = runHookWithFakeAgy(scratch, root, "ALLOW: fine");
    assert.equal(hook.status, 0, hook.stderr);
    assert.ok(prompt, "the gate did not run the review");
    assert.match(prompt, /No diff is available/);
    assert.match(prompt, /^new\.js$/m, "the new file is not listed for agy to read");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("a print timeout blocks with a timeout reason, not a model error", () => {
  const judged = judgeReview(run({ ok: false, failure: "timeout", result: emptyResult({ status: "SUCCESS", response: "partial", finished_reason: "print_timeout" }) }));
  assert.equal(judged.ok, false);
  assert.match(judged.reason, /timed out before it finished/);
});
