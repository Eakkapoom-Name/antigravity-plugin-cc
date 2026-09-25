import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import {
  buildArgs,
  buildStreamInput,
  DEFAULT_PRINT_TIMEOUT,
  DEFAULT_SPAWN_TIMEOUT_MS,
  deniedActions,
  denialConstraintPrompt,
  effortRejected,
  interpretPromptRun,
  interpretSlashCommandRun,
  normalizeStreamOutput,
  parseAgyError,
  printTimeoutMs,
  runIsolated,
  runPromptWithDenialRecovery,
  runSlashCommand,
  SPAWN_TIMEOUT_MARGIN_MS,
  spawnTimeoutMs
} from "../scripts/lib/agy.mjs";
import {
  buildCmdInvocation,
  quoteForCmd,
  resolveCommand,
  runCommand
} from "../scripts/lib/process.mjs";
import { collectDiff, defaultBranch, resolveScope, untrackedFiles } from "../scripts/lib/git.mjs";
import { scanForSecrets } from "../scripts/lib/secrets.mjs";
import { parseReviewArguments, parseTransferArguments, review } from "../scripts/agy-companion.mjs";
import { read, ROOT } from "./helpers.mjs";

// F69. Every temp directory made here is removed once the file's tests are
// done, the way companion.test.mjs and output-path.test.mjs already clean up.
const scratchDirs = [];
after(() => {
  for (const dir of scratchDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Captured verbatim from agy 1.2.2. The terminal event carries the same object
// --output-format json produces, which is why the rest of the plugin did not
// have to learn a second result shape.
const REAL_RESULT_EVENT = JSON.stringify({
  event: "result",
  result: {
    conversation_id: "5c072f23-16a4-4aa5-8c26-8df256f68bd8",
    status: "SUCCESS",
    response: "OK\n",
    duration_seconds: 2.4,
    num_turns: 1,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      thinking_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 0
    }
  }
});

test("the prompt is carried on stdin as one NDJSON user event", () => {
  const line = buildStreamInput("hello");
  assert.ok(line.endsWith("\n"));
  assert.deepEqual(JSON.parse(line), {
    event: "user",
    message: { role: "user", content: "hello" }
  });
});

// agy rejected {"type":"user",...} with `stream input message is missing the
// "event" field`, so the key name is load-bearing.
test("the stdin event uses the event key agy requires", () => {
  const parsed = JSON.parse(buildStreamInput("x"));
  assert.ok("event" in parsed, "agy rejects a message without an event field");
  assert.ok(!("type" in parsed));
});

test("a megabyte-scale prompt still produces one line and never an argument", () => {
  const huge = "x".repeat(5 * 1024 * 1024);
  const line = buildStreamInput(huge);
  assert.equal(line.split("\n").filter(Boolean).length, 1);
  assert.equal(JSON.parse(line).message.content.length, huge.length);
  // The whole point of F5: nothing about the prompt reaches argv.
  assert.ok(!buildArgs({}).some((arg) => arg.length > 64));
});

test("the result event is reduced to the documented shape", () => {
  const normalized = normalizeStreamOutput(
    `{"event":"init","conversation_id":"x","init":{}}\n{"event":"step_update"}\n${REAL_RESULT_EVENT}\n`
  );
  assert.equal(normalized.ok, true);
  assert.deepEqual(Object.keys(normalized.result).sort(), [
    "conversation_id",
    "duration_seconds",
    "num_turns",
    "response",
    "status",
    "usage"
  ]);
  assert.equal(normalized.result.response, "OK\n");
  assert.deepEqual(normalized.events, ["init", "step_update", "result"]);
});

test("a stream with no result event is a failure, not an empty success", () => {
  const normalized = normalizeStreamOutput('{"event":"init","conversation_id":"x"}\n');
  assert.equal(normalized.ok, false);
  assert.equal(normalized.result.status, "ERROR");
  assert.match(normalized.result.error, /no result event/);
});

test("an error result is not reported as ok", () => {
  const normalized = normalizeStreamOutput(
    '{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"boom","duration_seconds":0,"num_turns":0,"usage":{}}}'
  );
  assert.equal(normalized.ok, false);
  assert.equal(normalized.result.error, "boom");
});

test("non-JSON noise on the stream does not discard a usable result", () => {
  const normalized = normalizeStreamOutput(`warning: something\n${REAL_RESULT_EVENT}\n`);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.result.status, "SUCCESS");
});

test("empty output is a failure rather than a throw", () => {
  for (const value of ["", null, undefined, "   "]) {
    assert.equal(normalizeStreamOutput(value).ok, false);
  }
});

test("buildArgs always selects the stdin transport", () => {
  const args = buildArgs({});
  assert.deepEqual(args.slice(0, 5), [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "-p="
  ]);
  assert.ok(args.includes("--print-timeout"));
});

test("buildArgs omits every optional flag unless asked", () => {
  const args = buildArgs({});
  for (const flag of ["--mode", "--model", "--effort", "--json-schema", "--conversation", "-c", "--add-dir"]) {
    assert.ok(!args.includes(flag), `${flag} was passed without being requested`);
  }
});

test("buildArgs passes the routing and runtime flags it is given", () => {
  const args = buildArgs({
    mode: "accept-edits",
    model: "some-model",
    effort: "high",
    jsonSchema: "/tmp/schema.json",
    addDir: ["/tmp/a", "/tmp/b"]
  });
  assert.ok(args.includes("accept-edits"));
  assert.ok(args.includes("some-model"));
  assert.ok(args.includes("high"));
  assert.ok(args.includes("/tmp/schema.json"));
  assert.equal(args.filter((arg) => arg === "--add-dir").length, 2);
});

test("an explicit conversation id wins over continue", () => {
  const args = buildArgs({ conversationId: "abc", continueConversation: true });
  assert.ok(args.includes("--conversation"));
  assert.ok(args.includes("abc"));
  // -c picks agy's globally most recent conversation, which another terminal
  // may have advanced, so a known id must never be downgraded to it.
  assert.ok(!args.includes("-c"));
});

test("resolveCommand finds a real executable and rejects a missing one", () => {
  assert.ok(resolveCommand("node"), "node should resolve on PATH");
  assert.equal(resolveCommand("definitely-not-a-real-binary-xyz"), null);
  assert.equal(resolveCommand(""), null);
});

test("resolveCommand walks PATHEXT so Windows shims resolve", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-path-"));
  scratchDirs.push(dir);
  fs.writeFileSync(path.join(dir, "faketool.CMD"), "echo hi");
  const env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  const resolved = resolveCommand("faketool", env);
  if (process.platform === "win32") {
    assert.equal(resolved, path.join(dir, "faketool.CMD"));
  } else {
    // On Unix the extension walk is deliberately disabled, so a bare name must
    // not silently pick up a .CMD file.
    assert.equal(resolved, null);
  }
});

function scratchGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-git-"));
  scratchDirs.push(dir);
  spawnSync("git", ["init", "-q", "."], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@e.x"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-qm", "base"], { cwd: dir });
  return dir;
}

// The scanner reads git's own unified format, so every diff pins that format
// against the user's config: no color escapes, no external diff driver, no
// textconv filter, the default a/ b/ prefixes, and the one-line submodule form
// that still carries a `diff --git` header.
const PINNED_DIFF_FLAGS = [
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--submodule=short"
];

test("scope selection maps arguments onto the right git command", () => {
  assert.deepEqual(resolveScope("staged", ROOT).args, ["diff", ...PINNED_DIFF_FLAGS, "--cached"]);
  assert.deepEqual(resolveScope("", ROOT).args, ["diff", ...PINNED_DIFF_FLAGS, "HEAD"]);
  assert.deepEqual(resolveScope("some-ref", ROOT).args, ["diff", ...PINNED_DIFF_FLAGS, "--end-of-options", "some-ref...HEAD"]);
  assert.equal(resolveScope("branch", ROOT).kind, "branch");
});

test("a working tree change is collected as a real diff", () => {
  const dir = scratchGitRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
  const collected = collectDiff("", dir);
  assert.equal(collected.ok, true);
  assert.equal(collected.empty, false);
  assert.match(collected.diff, /-one/);
  assert.match(collected.diff, /\+two/);
});

// Git's funcname heuristic copies the nearest earlier line that starts with a
// letter into the hunk header, so a key line followed by blank lines ends up
// after the closing `@@` of a hunk that edits a later line.
test("a secret git copies into a hunk header from a real diff is caught", () => {
  const dir = scratchGitRepo();
  const secretLine = "AWS_SECRET_ACCESS_KEY=" + "k".repeat(40);
  fs.writeFileSync(path.join(dir, ".env"), `${secretLine}\n\n\n\n\n\n\n\nplain=1\nother\n`);
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-qm", "env"], { cwd: dir });
  fs.writeFileSync(path.join(dir, ".env"), `${secretLine}\n\n\n\n\n\n\n\nplain=2\nother\n`);
  const collected = collectDiff("", dir);
  assert.equal(collected.ok, true);
  // The fixture, not the scanner, is wrong if this first check fails.
  assert.match(collected.diff, /^@@ .* @@ AWS_SECRET_ACCESS_KEY=/m);
  assert.ok(!/^[-+ ]AWS_SECRET_ACCESS_KEY=/m.test(collected.diff), "the key line is a content line; this test needs it only in the header");
  const { hits } = scanForSecrets(collected.diff, { diff: true });
  assert.equal(hits.length, 1, JSON.stringify(hits));
  assert.equal(hits[0].side, "hunk-header");
  assert.equal(hits[0].file, ".env");
  assert.equal(hits[0].kind, "secret-assignment");
});

function scratchRepoWithSecretChange() {
  const dir = scratchGitRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), `one\nkey = "${"AKIA" + "IOSFODNN7EXAMPLE"}"\n`);
  return dir;
}

test("a repo configured for color.ui=always still yields a plain, scannable diff", () => {
  const dir = scratchRepoWithSecretChange();
  spawnSync("git", ["config", "color.ui", "always"], { cwd: dir });
  spawnSync("git", ["config", "color.diff", "always"], { cwd: dir });
  // Prefix config would name the file `w/a.txt`; the pinned prefixes keep it `a.txt`.
  spawnSync("git", ["config", "diff.mnemonicPrefix", "true"], { cwd: dir });
  const collected = collectDiff("", dir);
  assert.equal(collected.ok, true);
  assert.ok(!collected.diff.includes("\x1b"), "the diff carries ANSI escapes");
  const scan = scanForSecrets(collected.diff, { diff: true });
  assert.equal(scan.diffHeaders, 1);
  assert.equal(scan.hits.length, 1, JSON.stringify(scan.hits));
  assert.equal(scan.hits[0].file, "a.txt");
  assert.equal(scan.hits[0].side, "added");
});

// With diff.suppressBlankEmpty a blank context line is printed as an empty
// line, not a lone space, and the scanner would stop counting it.
test("a repo with diff.suppressBlankEmpty still numbers hits by the real line", () => {
  const dir = scratchGitRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n\nthree\n");
  spawnSync("git", ["commit", "-qam", "blank"], { cwd: dir });
  spawnSync("git", ["config", "diff.suppressBlankEmpty", "true"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), `one\n\nthree\nkey = "${"AKIA" + "IOSFODNN7EXAMPLE"}"\n`);
  const collected = collectDiff("", dir);
  const scan = scanForSecrets(collected.diff, { diff: true });
  assert.equal(scan.hits.length, 1, JSON.stringify(scan.hits));
  assert.equal(scan.hits[0].line, 4);
});

test("a repo with diff.external or a textconv filter still yields git's own diff", { skip: process.platform === "win32" }, () => {
  const dir = scratchRepoWithSecretChange();
  const script = path.join(dir, "..", `${path.basename(dir)}-driver.sh`);
  scratchDirs.push(script);
  fs.writeFileSync(script, "#!/bin/sh\necho nothing to see here\n", { mode: 0o755 });
  spawnSync("git", ["config", "diff.external", script], { cwd: dir });
  spawnSync("git", ["config", "diff.hide.textconv", script], { cwd: dir });
  fs.writeFileSync(path.join(dir, ".gitattributes"), "a.txt diff=hide\n");
  const collected = collectDiff("", dir);
  assert.equal(collected.ok, true);
  assert.ok(!collected.diff.includes("nothing to see here"), "an external driver or textconv shaped the diff");
  const scan = scanForSecrets(collected.diff, { diff: true });
  assert.equal(scan.diffHeaders, 1);
  assert.equal(scan.hits.length, 1, JSON.stringify(scan.hits));
  assert.equal(scan.hits[0].file, "a.txt");
});

test("a clean tree reports empty rather than inventing a review", () => {
  const dir = scratchGitRepo();
  const collected = collectDiff("", dir);
  assert.equal(collected.ok, true);
  assert.equal(collected.empty, true);
});

test("untracked files are reported separately, since no diff contains them", () => {
  const dir = scratchGitRepo();
  fs.writeFileSync(path.join(dir, "new.txt"), "hello\n");
  assert.equal(collectDiff("", dir).empty, true);
  assert.deepEqual(untrackedFiles(dir), ["new.txt"]);
});

test("defaultBranch resolves to a branch that exists", () => {
  const dir = scratchGitRepo();
  const branch = defaultBranch(dir);
  assert.ok(["main", "master"].includes(branch), `unexpected default branch ${branch}`);
});

// F124. `ref.split("/").pop()` turned `refs/remotes/origin/release/2026` into
// `2026`; the fix strips only the `refs/remotes/origin/` prefix. A clone's
// `origin/HEAD` is set from the source repository's checked-out branch, with
// no push involved.
function scratchClone(branchName) {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "agy-clone-src-"));
  scratchDirs.push(source);
  spawnSync("git", ["init", "-q", "."], { cwd: source });
  spawnSync("git", ["config", "user.email", "t@e.x"], { cwd: source });
  spawnSync("git", ["config", "user.name", "t"], { cwd: source });
  spawnSync("git", ["checkout", "-q", "-b", branchName], { cwd: source });
  fs.writeFileSync(path.join(source, "f.txt"), "x\n");
  spawnSync("git", ["add", "-A"], { cwd: source });
  spawnSync("git", ["commit", "-qm", "c"], { cwd: source });
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), "agy-clone-"));
  scratchDirs.push(clone);
  spawnSync("git", ["clone", "-q", source, clone]);
  return clone;
}

test("defaultBranch keeps a slashed default branch name intact", () => {
  const clone = scratchClone("release/2026");
  assert.equal(defaultBranch(clone), "release/2026");
});

// A remote can name its default branch `--output=<path>` (git's ref rules
// allow a leading `-`), and that name reached `git diff` as an option, writing
// a file. The name is refused as a default branch, and the revision is placed
// after `--end-of-options` in any case.
test("defaultBranch refuses an option-shaped default branch from the remote", () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "agy-clone-src-"));
  scratchDirs.push(source);
  spawnSync("git", ["init", "-q", "."], { cwd: source });
  spawnSync("git", ["config", "user.email", "t@e.x"], { cwd: source });
  spawnSync("git", ["config", "user.name", "t"], { cwd: source });
  spawnSync("git", ["symbolic-ref", "HEAD", "refs/heads/--output=pwn"], { cwd: source });
  fs.writeFileSync(path.join(source, "f.txt"), "x\n");
  spawnSync("git", ["add", "-A"], { cwd: source });
  spawnSync("git", ["commit", "-qm", "c"], { cwd: source });
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), "agy-clone-"));
  scratchDirs.push(clone);
  spawnSync("git", ["clone", "-q", source, clone]);
  const head = spawnSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd: clone, encoding: "utf8" });
  assert.equal(head.stdout.trim(), "refs/remotes/origin/--output=pwn", "the fixture no longer reproduces an option-shaped origin/HEAD");
  assert.ok(!defaultBranch(clone).startsWith("-"));
  collectDiff("branch", clone);
  assert.ok(!fs.readdirSync(clone).some((name) => name.startsWith("pwn")), "git diff wrote a file named by the remote's branch");
});

test("a base ref that looks like an option is never read as one", () => {
  const dir = scratchGitRepo();
  const out = collectDiff("--output=pwn", dir);
  assert.equal(out.ok, false);
  assert.ok(!fs.readdirSync(dir).some((name) => name.startsWith("pwn")));
});

// F125. Only `staged`, `branch`, or a token git resolves to a real commit is
// a scope; an ordinary sentence's first word (`check`) used to be swallowed
// as one just for looking word-shaped.
test("review arguments split into a scope and free-text focus", () => {
  const dir = scratchGitRepo();
  assert.deepEqual(parseReviewArguments("staged", dir), { scope: "staged", focus: "", allowSecret: [] });
  assert.deepEqual(parseReviewArguments("branch check the error paths", dir), {
    scope: "branch",
    focus: "check the error paths",
    allowSecret: []
  });
  assert.deepEqual(parseReviewArguments("", dir), { scope: "", focus: "", allowSecret: [] });
});

test("parseReviewArguments accepts a real ref as scope, including a slashed one", () => {
  const dir = scratchGitRepo();
  assert.deepEqual(parseReviewArguments("  HEAD  ", dir), { scope: "HEAD", focus: "", allowSecret: [] });
  spawnSync("git", ["branch", "release/2026"], { cwd: dir });
  assert.deepEqual(parseReviewArguments("release/2026 look here", dir), {
    scope: "release/2026",
    focus: "look here",
    allowSecret: []
  });
});

test("parseReviewArguments treats a word git cannot resolve as focus, not scope", () => {
  const dir = scratchGitRepo();
  assert.deepEqual(parseReviewArguments("check the error handling", dir), {
    scope: "",
    focus: "check the error handling",
    allowSecret: [],
    scopeNote: "`check` is not a branch, tag or commit here; reviewed the working tree and kept it in the focus"
  });
});

// F125 follow-up. A short hex English word (`dead`, `cafe`, `added`, `2024`)
// can resolve as an abbreviated commit id and was then swallowed as a
// scope. A token counts only when git names it as a ref, or when it is at
// least 7 hex digits and resolves to a commit.
test("parseReviewArguments does not read a short commit-id prefix as a scope", () => {
  const dir = scratchGitRepo();
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  const short = sha.slice(0, 4);
  const legacy = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${short}^{commit}`], { cwd: dir });
  assert.equal(legacy.status, 0, "the fixture no longer reproduces a short prefix resolving as a commit");
  const parsed = parseReviewArguments(`${short} is the area to look at`, dir);
  assert.equal(parsed.scope, "");
  assert.equal(parsed.focus, `${short} is the area to look at`);
  assert.equal(parseReviewArguments(`${sha.slice(0, 7)} look here`, dir).scope, sha.slice(0, 7));
  assert.equal(parseReviewArguments(sha, dir).scope, sha);
  assert.equal(parseReviewArguments("deadbeefdeadbeef look here", dir).scope, "");
});

test("parseReviewArguments accepts a named branch or tag even when it is a hex word", () => {
  const dir = scratchGitRepo();
  spawnSync("git", ["branch", "dead"], { cwd: dir });
  spawnSync("git", ["tag", "cafe"], { cwd: dir });
  assert.deepEqual(parseReviewArguments("dead look here", dir), { scope: "dead", focus: "look here", allowSecret: [] });
  assert.deepEqual(parseReviewArguments("cafe", dir), { scope: "cafe", focus: "", allowSecret: [] });
});

// A mistyped ref (`mian`) used to fail loudly as a scope; now it silently
// becomes focus, so the payload carries a note the command relays.
test("a review whose first word looks like a ref but is not one says so in the payload", () => {
  const dir = scratchGitRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
  const previous = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = dir;
  const scopes = [];
  let out;
  try {
    out = review({
      argument: "mian check the parser",
      adversarial: false,
      run: () => ({ result: { conversation_id: "c", status: "SUCCESS", response: "No findings." }, events: [], deniedActions: [], stderr: "", ok: true, failure: null }),
      available: () => true,
      collect: (scope, cwd) => {
        scopes.push(scope);
        return collectDiff(scope, cwd);
      }
    });
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PROJECT_DIR;
    } else {
      process.env.CLAUDE_PROJECT_DIR = previous;
    }
  }
  assert.deepEqual(scopes, [""]);
  assert.equal(out.scopeNote, "`mian` is not a branch, tag or commit here; reviewed the working tree and kept it in the focus");
});

test("parseReviewArguments lifts repeatable --allow-secret out of the focus text", () => {
  const parsed = parseReviewArguments("staged --allow-secret fixture$ check the auth path --allow-secret EXAMPLE");
  assert.equal(parsed.scope, "staged");
  assert.equal(parsed.focus, "check the auth path");
  assert.deepEqual(parsed.allowSecret, ["fixture$", "EXAMPLE"]);
  assert.deepEqual(parseReviewArguments("").allowSecret, []);
});

// Resolving a Windows shim is only half the job. Windows cannot exec a .cmd
// image, and Node refuses to try since the fix for CVE-2024-27980, so the file
// has to reach cmd.exe. This ran green on Linux CI while being broken on
// Windows, because nothing here actually executed a .cmd.
test("a .cmd target is handed to cmd.exe rather than exec'd directly", () => {
  const invocation = buildCmdInvocation("C:\\tools\\agy.cmd", ["--flag", "value"], {
    ComSpec: "C:\\Windows\\system32\\cmd.exe"
  });
  assert.equal(invocation.file, "C:\\Windows\\system32\\cmd.exe");
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(invocation.args[3], /^".*"$/);
  assert.ok(invocation.args[3].includes("agy.cmd"));
});

test("quoting survives spaces, quotes and trailing backslashes", () => {
  assert.equal(quoteForCmd("plain"), '"plain"');
  assert.equal(quoteForCmd("has space"), '"has space"');
  assert.equal(quoteForCmd('say "hi"'), '"say \\"hi\\""');
  // A trailing backslash before the closing quote would escape it, so they are
  // doubled.
  assert.equal(quoteForCmd("C:\\path\\"), '"C:\\path\\\\"');
});

// The real check. It only means anything on the Windows CI leg, which is the
// whole reason that leg exists.
test("a real .cmd executes and receives its arguments intact", { skip: process.platform !== "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cmd-"));
  scratchDirs.push(dir);
  const shim = path.join(dir, "echoargs.cmd");
  fs.writeFileSync(shim, "@echo off\r\necho ARG1=[%~1]\r\necho ARG2=[%~2]\r\n");

  const result = runCommand(shim, ["plain value", "with space"], { encoding: "utf8" });
  assert.equal(result.error, undefined, `spawning the .cmd failed: ${result.error?.code}`);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /ARG1=\[plain value\]/);
  assert.match(result.stdout, /ARG2=\[with space\]/);
});

test("a resolved .cmd on PATH is executable, not just findable", { skip: process.platform !== "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cmdpath-"));
  scratchDirs.push(dir);
  fs.writeFileSync(path.join(dir, "faketool.cmd"), "@echo off\r\necho ran ok\r\n");
  const previous = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${previous}`;
  try {
    const result = runCommand("faketool", [], { encoding: "utf8" });
    assert.equal(result.error, undefined, `resolved but could not execute: ${result.error?.code}`);
    assert.match(result.stdout, /ran ok/);
  } finally {
    process.env.PATH = previous;
  }
});

// /agy:transfer documents --model and --effort. The companion parses them out
// of the argument string so they reach agy as flags instead of being taken for
// part of the brief path.
test("transfer arguments separate the brief path from the routing flags", () => {
  assert.deepEqual(parseTransferArguments("/tmp/brief.md"), {
    briefPath: "/tmp/brief.md",
    model: undefined,
    effort: undefined
  });
  assert.deepEqual(parseTransferArguments("/tmp/brief.md --model fast --effort high"), {
    briefPath: "/tmp/brief.md",
    model: "fast",
    effort: "high"
  });
  // Flags first still finds the path.
  assert.equal(parseTransferArguments("--model fast /tmp/brief.md").briefPath, "/tmp/brief.md");
  // A flag with no value must not swallow the path or invent one.
  assert.deepEqual(parseTransferArguments("/tmp/brief.md --model"), {
    briefPath: "/tmp/brief.md",
    model: undefined,
    effort: undefined
  });
  assert.equal(parseTransferArguments("").briefPath, "");
});

// Captured verbatim from agy 1.2.4 with a settings file allowing only
// `command(pwd)`, asking it to read /etc/hostname. The status is SUCCESS, the
// exit code was 0, and only `denied_actions` says nothing happened. Issue #21
// reported the same shape with a non-empty response, which is the case the old
// empty-response rule cannot see.
const DENIED_READ_RESULT = {
  conversation_id: "fa93f7f2-4c03-45a4-a767-11d695cf9a18",
  status: "SUCCESS",
  response: "Reading required docs first.\n",
  duration_seconds: 6.49,
  num_turns: 1,
  usage: {
    input_tokens: 33681,
    output_tokens: 134,
    thinking_tokens: 87,
    cache_read_tokens: 0,
    total_tokens: 33815
  },
  denied_actions: [{ action: "read_file", display_name: "ViewFile" }]
};

test("a result with denied actions is a failure even when status is SUCCESS", () => {
  const normalized = normalizeStreamOutput(
    `${JSON.stringify({ event: "result", result: DENIED_READ_RESULT })}\n`
  );
  assert.equal(normalized.ok, false);
  assert.deepEqual(normalized.deniedActions, ["read_file"]);
  // The result itself is preserved: the caller still needs conversation_id.
  assert.equal(normalized.result.conversation_id, DENIED_READ_RESULT.conversation_id);
});

test("deniedActions lists the denied tool names and tolerates their absence", () => {
  assert.deepEqual(deniedActions(DENIED_READ_RESULT), ["read_file"]);
  assert.deepEqual(
    deniedActions({
      denied_actions: [
        { action: "command", display_name: "RunCommand" },
        { action: "read_file", display_name: "ViewFile" }
      ]
    }),
    ["command", "read_file"]
  );
  assert.deepEqual(deniedActions({ status: "SUCCESS", response: "OK" }), []);
  assert.deepEqual(deniedActions({ denied_actions: [] }), []);
  assert.deepEqual(deniedActions(null), []);
  assert.deepEqual(deniedActions({ denied_actions: "garbage" }), []);
});

// Captured verbatim from agy 1.2.4: `--effort high` with a model that does not
// take an effort exits 1 before any model call, printing this result on stdout.
// Dropping the flag and rerunning costs no quota, so it is worth recognising.
test("an effort rejection is recognised from the result agy prints before running", () => {
  const rejected = {
    conversation_id: "",
    status: "ERROR",
    response: "",
    error:
      'invalid model selection (--model "claude-opus-4-6-thinking" --effort "high"): --effort is not supported for model "claude-opus-4-6-thinking"',
    duration_seconds: 0,
    num_turns: 0
  };
  assert.equal(effortRejected(rejected), true);
  assert.equal(effortRejected({ status: "ERROR", error: "boom" }), false);
  assert.equal(effortRejected(DENIED_READ_RESULT), false);
  assert.equal(effortRejected(null), false);
});

// F21. agy ends the conversation stream the moment it soft-denies, so the model
// never sees the refusal and cannot adapt. The conversation itself survives: a
// second turn on the same `conversation_id` keeps the task context and can
// finish the job under a stated constraint. That is the reporter's manual
// workaround in GitHub issue #21, and it is what this automates.

function denied(conversationId, actions = ["read_file"]) {
  return {
    result: { status: "SUCCESS", conversation_id: conversationId, response: "", denied_actions: actions },
    deniedActions: actions,
    ok: false,
    failure: "denied",
    stderr: ""
  };
}

function succeeded(conversationId, response = "done") {
  return {
    result: { status: "SUCCESS", conversation_id: conversationId, response },
    deniedActions: [],
    ok: true,
    failure: null,
    stderr: ""
  };
}

test("the constraint prompt names every denied tool and forbids retrying it", () => {
  const prompt = denialConstraintPrompt(["read_file", "command"]);
  assert.match(prompt, /read_file/);
  assert.match(prompt, /command/);
  assert.match(prompt, /without/i);
  // The model has to be able to say it is stuck rather than silently guessing.
  assert.match(prompt, /say (so|what)/i);
});

test("a run that was not denied is returned untouched, with no second turn", () => {
  const calls = [];
  const out = runPromptWithDenialRecovery(
    "do the thing",
    {},
    (prompt, options) => {
      calls.push({ prompt, options });
      return succeeded("conv-1");
    }
  );
  assert.equal(calls.length, 1);
  assert.equal(out.ok, true);
  assert.equal(out.recovery, undefined);
});

test("a denial is resumed once, on the same conversation, under a stated constraint", () => {
  const calls = [];
  const out = runPromptWithDenialRecovery(
    "read src/index.js and summarize it",
    { cwd: "/repo", addDir: ["/repo"] },
    (prompt, options) => {
      calls.push({ prompt, options });
      return calls.length === 1 ? denied("conv-7") : succeeded("conv-7", "summary");
    }
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.conversationId, "conv-7");
  assert.equal(calls[1].options.cwd, "/repo");
  assert.match(calls[1].prompt, /read_file/);
  assert.equal(out.ok, true);
  assert.equal(out.result.response, "summary");
  assert.equal(out.recovery.attempted, true);
  assert.deepEqual(out.recovery.deniedActions, ["read_file"]);
  assert.equal(out.recovery.recovered, true);
});

test("a denial with no conversation id cannot be resumed, so it is not tried", () => {
  const calls = [];
  const out = runPromptWithDenialRecovery("do the thing", {}, (prompt, options) => {
    calls.push({ prompt, options });
    return denied("");
  });
  assert.equal(calls.length, 1);
  assert.equal(out.failure, "denied");
  assert.equal(out.recovery, undefined);
});

test("a second denial ends it; the resumed turn is never itself resumed", () => {
  const calls = [];
  const out = runPromptWithDenialRecovery("do the thing", {}, (prompt, options) => {
    calls.push({ prompt, options });
    return denied("conv-9", ["command"]);
  });
  assert.equal(calls.length, 2);
  assert.equal(out.failure, "denied");
  assert.equal(out.recovery.attempted, true);
  assert.equal(out.recovery.recovered, false);
});

test("the caller can turn recovery off and get the first result back", () => {
  const calls = [];
  const out = runPromptWithDenialRecovery(
    "do the thing",
    { recoverFromDenial: false },
    (prompt, options) => {
      calls.push({ prompt, options });
      return denied("conv-3");
    }
  );
  assert.equal(calls.length, 1);
  assert.equal(out.recovery, undefined);
});

// Read-only commands hand agy a temp directory as its whole workspace. F30
// measured that run_command honours cwd on agy 1.2.5, so a run that cannot
// see the repo cannot write into it.
test("runIsolated gives agy a temp directory as cwd and the only --add-dir", () => {
  const calls = [];
  const out = runIsolated("summarize", { model: "m", cwd: "/repo", addDir: ["/repo"] }, (prompt, options) => {
    calls.push({ prompt, options });
    return { result: { conversation_id: "c1", status: "SUCCESS", response: "ok" }, events: [], deniedActions: [], stderr: "", ok: true, failure: null };
  });
  assert.equal(calls.length, 1);
  const { cwd, addDir, model } = calls[0].options;
  assert.ok(cwd.startsWith(os.tmpdir()), `cwd ${cwd} is not under the temp dir`);
  assert.deepEqual(addDir, [cwd]);
  assert.equal(model, "m");
  assert.ok(!JSON.stringify(calls[0].options).includes("/repo"), "the repo path leaked into the options");
  assert.equal(out.ok, true);
  assert.ok(!fs.existsSync(cwd), "the temp directory was not removed");

  // F54. The options are what the runner sees, but argv is what agy sees, so
  // the built argv is asserted too: one --add-dir, the temp dir, and no --mode.
  const argv = buildArgs(calls[0].options);
  const addDirFlags = argv.filter((arg) => arg === "--add-dir");
  assert.equal(addDirFlags.length, 1, `argv carries ${addDirFlags.length} --add-dir flags, not one`);
  assert.equal(argv[argv.indexOf("--add-dir") + 1], cwd);
  assert.ok(!argv.includes("--mode"), "argv carries --mode");
  assert.ok(!argv.join(" ").includes("/repo"), "the repo path leaked into argv");
});

test("runIsolated removes the temp directory after a failed run and after a throw", () => {
  let seen;
  const failed = runIsolated("x", {}, (_prompt, options) => {
    seen = options.cwd;
    return { result: { status: "ERROR" }, events: [], deniedActions: [], stderr: "boom", ok: false, failure: "failed" };
  });
  assert.equal(failed.ok, false);
  assert.ok(!fs.existsSync(seen));

  assert.throws(() =>
    runIsolated("x", {}, (_prompt, options) => {
      seen = options.cwd;
      throw new Error("spawn exploded");
    })
  , /spawn exploded/);
  assert.ok(!fs.existsSync(seen));
});

test("runIsolated never passes --mode through", () => {
  let seen;
  runIsolated("x", { mode: "accept-edits" }, (_prompt, options) => {
    seen = options;
    return { result: {}, events: [], deniedActions: [], stderr: "", ok: true, failure: null };
  });
  assert.equal(seen.mode, undefined);
});

// F53. Both fault branches of runIsolated need the filesystem to fail, so
// the two calls are stubbed on the shared `node:fs` object agy.mjs imports
// and restored in `finally` whatever the assertions do.
test("runIsolated reports an isolation failure when the temp directory cannot be made", () => {
  const original = fs.mkdtempSync;
  const calls = [];
  fs.mkdtempSync = () => {
    throw new Error("ENOSPC: no space left");
  };
  try {
    const out = runIsolated("x", {}, (prompt, options) => {
      calls.push({ prompt, options });
      return { result: {}, events: [], deniedActions: [], stderr: "", ok: true, failure: null };
    });
    assert.equal(calls.length, 0, "agy ran without an isolated directory");
    assert.equal(out.ok, false);
    assert.equal(out.failure, "isolation");
    assert.match(out.result.error, /could not create an isolated directory: ENOSPC/);
    assert.deepEqual(out.events, []);
    assert.deepEqual(out.deniedActions, []);
  } finally {
    fs.mkdtempSync = original;
  }
});

test("runIsolated returns the run with a note when the temp directory cannot be removed", () => {
  const original = fs.rmSync;
  let seen;
  fs.rmSync = () => {
    throw new Error("EBUSY: resource busy");
  };
  try {
    const out = runIsolated("x", {}, (_prompt, options) => {
      seen = options.cwd;
      return { result: { status: "SUCCESS", response: "ok" }, events: [], deniedActions: [], stderr: "", ok: true, failure: null };
    });
    assert.equal(out.ok, true);
    assert.equal(out.result.response, "ok");
    assert.match(out.note, /isolated directory not removed: /);
    assert.ok(out.note.includes(seen), "the note does not name the directory");
    assert.match(out.note, /EBUSY/);
  } finally {
    fs.rmSync = original;
    if (seen) {
      fs.rmSync(seen, { recursive: true, force: true });
    }
  }
});

// F52. When the run itself threw, the error is rethrown, so the cleanup note
// has nowhere to go but the error: main() emits only `error.message`.
test("runIsolated carries the failed-cleanup note on a rethrown error", () => {
  const original = fs.rmSync;
  let seen;
  fs.rmSync = () => {
    throw new Error("EBUSY: resource busy");
  };
  try {
    assert.throws(
      () =>
        runIsolated("x", {}, (_prompt, options) => {
          seen = options.cwd;
          throw new Error("spawn exploded");
        }),
      (error) => {
        assert.match(error.message, /spawn exploded/);
        assert.match(error.message, /isolated directory not removed: /);
        assert.ok(error.message.includes(seen), "the note does not name the directory");
        return true;
      }
    );
  } finally {
    fs.rmSync = original;
    if (seen) {
      fs.rmSync(seen, { recursive: true, force: true });
    }
  }
});

// F95. A companion run under a 590000 ms Bash timeout needs agy's deadline
// plus its startup (up to 28 s seen on 1.2.9) to fit well inside it: 9m left
// 22 s, 8m leaves 82 s. The spawn timeout keeps its one minute over the print
// timeout and now also ends under the Bash timeout, so a hung agy comes back
// as a timeout failure instead of a backgrounded call.
test("companion runs default to an 8m print timeout under a 9 minute spawn timeout", () => {
  assert.equal(DEFAULT_PRINT_TIMEOUT, "8m");
  assert.equal(DEFAULT_SPAWN_TIMEOUT_MS, 9 * 60 * 1000);
  assert.ok(DEFAULT_SPAWN_TIMEOUT_MS < 590000);
  assert.deepEqual(buildArgs({}).slice(-2), ["--print-timeout", "8m"]);
});

// F93. Since agy 1.2.6 a headless turn that ends on a model or agent error
// exits 3 and prints a structured `AGY_ERROR: {...}` line on stderr; since
// 1.2.10 that also covers a run that streamed part of a response first, and
// the JSON result then carries the partial response. No run here has produced
// a real AGY_ERROR line, so this fixture is synthesized from the 1.2.6 and
// 1.2.10 changelog text (canonical status, error code, retryability, error
// ID) and its field names are unverified. The code keeps whatever JSON agy
// prints rather than depending on those names.
const AGY_ERROR_LINE =
  'AGY_ERROR: {"status":"UNAVAILABLE","code":503,"retryable":true,"error_id":"synthetic-1"}';

function partialResultStdout(response) {
  return `${JSON.stringify({
    event: "result",
    result: { conversation_id: "c-partial", status: "ERROR", response, error: "model error" }
  })}\n`;
}

test("parseAgyError reads the last AGY_ERROR line as JSON", () => {
  assert.deepEqual(parseAgyError(`noise\n${AGY_ERROR_LINE}\n`), {
    status: "UNAVAILABLE",
    code: 503,
    retryable: true,
    error_id: "synthetic-1"
  });
  assert.equal(parseAgyError("jetski: no output produced"), null);
  assert.equal(parseAgyError(""), null);
  assert.equal(parseAgyError(undefined), null);
});

test("parseAgyError keeps an AGY_ERROR line that is not JSON as its raw text", () => {
  assert.equal(parseAgyError("AGY_ERROR: model went away"), "model went away");
});

test("exit 3 with a partial response is a failure that keeps the response and the AGY_ERROR", () => {
  const out = interpretPromptRun({
    status: 3,
    stdout: partialResultStdout("Half an answer"),
    stderr: AGY_ERROR_LINE
  });
  assert.equal(out.ok, false);
  assert.equal(out.failure, "agy-error");
  assert.equal(out.result.response, "Half an answer");
  assert.equal(out.result.conversation_id, "c-partial");
  assert.equal(out.agyError.code, 503);
  assert.match(out.stderr, /AGY_ERROR:/);
});

test("exit 3 is a failure even when the result event says SUCCESS", () => {
  const out = interpretPromptRun({ status: 3, stdout: `${REAL_RESULT_EVENT}\n`, stderr: AGY_ERROR_LINE });
  assert.equal(out.ok, false);
  assert.equal(out.failure, "agy-error");
  assert.equal(out.result.response, "OK\n");
});

test("exit 3 with no result event carries the AGY_ERROR into the result error", () => {
  const out = interpretPromptRun({ status: 3, stdout: "", stderr: AGY_ERROR_LINE });
  assert.equal(out.ok, false);
  assert.equal(out.failure, "agy-error");
  assert.match(out.result.error, /AGY_ERROR/);
  assert.match(out.result.error, /UNAVAILABLE/);
});

test("exit 3 with no AGY_ERROR line is still an agy-error failure", () => {
  const out = interpretPromptRun({ status: 3, stdout: `${REAL_RESULT_EVENT}\n`, stderr: "" });
  assert.equal(out.ok, false);
  assert.equal(out.failure, "agy-error");
  assert.equal(out.agyError, null);
});

// agy 1.2.10 notes that multi-turn stream-json sessions "still warn and
// continue", so the stderr line can appear without exit 3.
test("an AGY_ERROR line on a zero exit is still a failure", () => {
  const out = interpretPromptRun({ status: 0, stdout: `${REAL_RESULT_EVENT}\n`, stderr: AGY_ERROR_LINE });
  assert.equal(out.ok, false);
  assert.equal(out.failure, "agy-error");
  assert.equal(out.agyError.status, "UNAVAILABLE");
});

test("a denial keeps its own failure name so recovery still fires", () => {
  const out = interpretPromptRun({
    status: 0,
    stdout: `${JSON.stringify({ event: "result", result: DENIED_READ_RESULT })}\n`,
    stderr: ""
  });
  assert.equal(out.failure, "denied");
  assert.deepEqual(out.deniedActions, ["read_file"]);
});

test("a clean exit with a SUCCESS result stays ok and reports no AGY_ERROR", () => {
  const out = interpretPromptRun({ status: 0, stdout: `${REAL_RESULT_EVENT}\n`, stderr: "" });
  assert.equal(out.ok, true);
  assert.equal(out.failure, null);
  assert.equal(out.agyError, null);
});

test("interpretPromptRun keeps the missing and timeout failures", () => {
  assert.equal(interpretPromptRun({ error: { code: "ENOENT" }, stdout: "", stderr: "" }).failure, "missing");
  assert.equal(interpretPromptRun({ error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" }).failure, "timeout");
});

// F79. A spawn timeout used to be a flat 9 minutes whatever printTimeout said,
// so a command that capped agy at 3 minutes still spawned with 9 minutes of
// slack: a hung agy sat past its own command's Bash timeout uncaught. The
// spawn timeout is now derived from the same printTimeout string agy's own
// --print-timeout flag gets, plus a fixed margin, so the two cannot drift.
test("printTimeoutMs parses the \"Nm\"/\"Ns\" shorthand passed to --print-timeout", () => {
  assert.equal(printTimeoutMs("8m"), 8 * 60 * 1000);
  assert.equal(printTimeoutMs("3m"), 3 * 60 * 1000);
  assert.equal(printTimeoutMs("90s"), 90 * 1000);
  assert.throws(() => printTimeoutMs("8"), /printTimeout must look like/);
  assert.throws(() => printTimeoutMs(undefined), /printTimeout must look like/);
});

test("spawnTimeoutMs keeps a fixed margin over the print timeout it is paired with", () => {
  assert.equal(SPAWN_TIMEOUT_MARGIN_MS, 60 * 1000);
  assert.equal(spawnTimeoutMs("8m"), printTimeoutMs("8m") + SPAWN_TIMEOUT_MARGIN_MS);
  assert.equal(spawnTimeoutMs("3m"), printTimeoutMs("3m") + SPAWN_TIMEOUT_MARGIN_MS);
  // DEFAULT_SPAWN_TIMEOUT_MS predates this helper; it must still agree with it.
  assert.equal(DEFAULT_SPAWN_TIMEOUT_MS, spawnTimeoutMs(DEFAULT_PRINT_TIMEOUT));
});

test("runPrompt derives its default spawn timeout from the print timeout it is given", () => {
  const source = read("scripts/lib/agy.mjs");
  const fn = source.match(/export function runPrompt[\s\S]*?\n}\n/);
  assert.ok(fn, "runPrompt not found");
  assert.match(fn[0], /timeout: options\.timeoutMs \?\? spawnTimeoutMs\(printTimeout\)/);
});

// F102. `runSlashCommand` passed agy a 2 minute --print-timeout but spawned
// with a flat 60 second Node timeout, below its own print timeout: a slow
// `/usage` was killed by Node before agy's deadline, and the failure was
// misreported as invalid JSON rather than a timeout.
test("interpretSlashCommandRun keeps the missing and timeout failures", () => {
  assert.equal(interpretSlashCommandRun({ error: { code: "ENOENT" }, stdout: "", stderr: "" }).failure, "missing");
  assert.equal(interpretSlashCommandRun({ error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" }).failure, "timeout");
  assert.equal(interpretSlashCommandRun({ stdout: "not json", stderr: "" }).failure, "invalid-json");
  const ok = interpretSlashCommandRun({ stdout: '{"a":1}', stderr: "" });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.payload, { a: 1 });
});

test("runSlashCommand's default spawn timeout exceeds its own default print timeout", () => {
  const source = read("scripts/lib/agy.mjs");
  const fn = source.match(/export function runSlashCommand[\s\S]*?\n}\n/);
  assert.ok(fn, "runSlashCommand not found");
  assert.match(fn[0], /printTimeout = options\.printTimeout \?\? "2m"/);
  assert.match(fn[0], /timeout: options\.timeoutMs \?\? spawnTimeoutMs\(printTimeout\)/);
  assert.ok(spawnTimeoutMs("2m") > printTimeoutMs("2m"));
});

test("runSlashCommand reports a real spawn timeout as a timeout, not invalid JSON", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-slash-timeout-"));
  scratchDirs.push(dir);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "agy"), "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous}`;
  try {
    const result = runSlashCommand("usage", { timeoutMs: 100 });
    assert.equal(result.ok, false);
    assert.equal(result.failure, "timeout");
  } finally {
    process.env.PATH = previous;
  }
});
