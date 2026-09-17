import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import {
  buildArgs,
  buildStreamInput,
  deniedActions,
  effortRejected,
  normalizeStreamOutput
} from "../scripts/lib/agy.mjs";
import {
  buildCmdInvocation,
  quoteForCmd,
  resolveCommand,
  runCommand
} from "../scripts/lib/process.mjs";
import { collectDiff, defaultBranch, resolveScope, untrackedFiles } from "../scripts/lib/git.mjs";
import { parseReviewArguments, parseTransferArguments } from "../scripts/agy-companion.mjs";
import { ROOT } from "./helpers.mjs";

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
  spawnSync("git", ["init", "-q", "."], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@e.x"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-qm", "base"], { cwd: dir });
  return dir;
}

test("scope selection maps arguments onto the right git command", () => {
  assert.deepEqual(resolveScope("staged", ROOT).args, ["diff", "--cached"]);
  assert.deepEqual(resolveScope("", ROOT).args, ["diff", "HEAD"]);
  assert.deepEqual(resolveScope("some-ref", ROOT).args, ["diff", "some-ref...HEAD"]);
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

test("review arguments split into a scope and free-text focus", () => {
  assert.deepEqual(parseReviewArguments("staged"), { scope: "staged", focus: "" });
  assert.deepEqual(parseReviewArguments("branch check the error paths"), {
    scope: "branch",
    focus: "check the error paths"
  });
  assert.deepEqual(parseReviewArguments(""), { scope: "", focus: "" });
  assert.deepEqual(parseReviewArguments("  main  "), { scope: "main", focus: "" });
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
