import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { parseFlaggedArguments, review, search, transfer, whisper } from "../scripts/agy-companion.mjs";

const AWS = "AKIA" + "IOSFODNN7EXAMPLE";

function scratchRepo(addedLine) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-companion-"));
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "--quiet");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  git("add", "-A");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init");
  fs.writeFileSync(path.join(dir, "a.txt"), `one\n${addedLine}\n`);
  return dir;
}

function withWorkspace(dir, fn) {
  const previous = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = dir;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PROJECT_DIR;
    } else {
      process.env.CLAUDE_PROJECT_DIR = previous;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const fakeRun = (calls) => (prompt, options) => {
  calls.push({ prompt, options });
  return { result: { conversation_id: "c", status: "SUCCESS", response: "No findings." }, events: [], deniedActions: [], stderr: "", ok: true, failure: null };
};

test("a review whose diff carries a credential shape is blocked before agy runs", () => {
  const calls = [];
  const out = withWorkspace(scratchRepo(`key = "${AWS}"`), () =>
    review({ argument: "", adversarial: false, run: fakeRun(calls), available: () => true })
  );
  assert.equal(calls.length, 0);
  assert.equal(out.ok, false);
  assert.equal(out.failure, "secrets");
  assert.equal(out.hits[0].kind, "aws-access-key-id");
  assert.ok(!JSON.stringify(out).includes(AWS), "the value leaked into the report");
});

test("--allow-secret lets a known fixture through and the run is isolated", () => {
  const calls = [];
  const dir = scratchRepo(`key = "${AWS}"  # fixture`);
  const out = withWorkspace(dir, () =>
    review({ argument: "--allow-secret fixture$", adversarial: false, run: fakeRun(calls), available: () => true })
  );
  assert.equal(out.ok, true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].options.cwd.startsWith(os.tmpdir()));
  assert.ok(!JSON.stringify(calls[0].options).includes(dir), "the repo path reached agy");
  assert.match(calls[0].prompt, /whole evidence/);
});

function scratchBrief(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-brief-"));
  const file = path.join(dir, "brief.md");
  fs.writeFileSync(file, content);
  return { dir, file };
}

// transfer is the one remaining path where repository text leaves with the
// repository itself as agy's workspace (it is deliberately not isolated), so
// this is the one place where inspection of the source is not enough: the
// scan has to be proven to actually run and actually block before anything
// reaches the low-level runner (which is what would otherwise call
// `buildArgs` and spawn agy).
test("a transfer brief carrying a credential shape is blocked before agy runs", () => {
  const calls = [];
  const { dir, file } = scratchBrief(`Handoff notes.\nkey = "${AWS}"\n`);
  try {
    const out = transfer({ argument: file, run: fakeRun(calls), available: () => true });
    assert.equal(calls.length, 0, "buildArgs's caller must never be reached on a blocked brief");
    assert.equal(out.ok, false);
    assert.equal(out.failure, "secrets");
    assert.equal(out.hits[0].kind, "aws-access-key-id");
    assert.ok(!JSON.stringify(out).includes(AWS), "the value leaked into the report");
    assert.ok(fs.existsSync(file), "a blocked brief must survive for the user to edit and rerun");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a clean transfer brief proceeds and is removed after", () => {
  const calls = [];
  const { dir, file } = scratchBrief("Handoff notes with nothing sensitive in them.\n");
  try {
    const out = transfer({ argument: file, run: fakeRun(calls), available: () => true });
    assert.equal(out.ok, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].prompt, /Handoff notes with nothing sensitive/);
    assert.ok(!fs.existsSync(file), "a successful transfer removes the brief file");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseFlaggedArguments splits named flags from the free text", () => {
  const parsed = parseFlaggedArguments("--model gemini --effort high what is a monad --allow-secret a --allow-secret b", ["--model", "--effort", "--allow-secret"]);
  assert.deepEqual(parsed.flags, { model: "gemini", effort: "high", allowSecret: ["a", "b"] });
  assert.equal(parsed.rest, "what is a monad");
  assert.deepEqual(parseFlaggedArguments("", ["--model"]), { flags: {}, rest: "" });
  assert.equal(parseFlaggedArguments("--model", ["--model"]).rest, "");
});

test("whisper refuses an empty prompt without spending a run", () => {
  const calls = [];
  const out = whisper("--model x", fakeRun(calls), () => true);
  assert.equal(out.ok, false);
  assert.match(out.error, /needs a prompt/);
  assert.equal(calls.length, 0);
});

test("whisper renders the template and passes model and effort through an isolated run", () => {
  const calls = [];
  const out = whisper("--model m --effort low why is the sky blue", fakeRun(calls), () => true);
  assert.equal(out.ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /why is the sky blue/);
  assert.equal(calls[0].options.model, "m");
  assert.equal(calls[0].options.effort, "low");
  assert.equal(calls[0].options.printTimeout, "3m");
  assert.ok(calls[0].options.cwd.startsWith(os.tmpdir()));
  assert.ok(!JSON.stringify(calls[0].options).includes(process.cwd()), "the repository path reached agy");
  assert.equal(out.effortDropped, false);
});

test("whisper drops --effort once when the model rejects it, staying isolated on both tries", () => {
  const calls = [];
  const out = whisper("--effort high hi", (prompt, options) => {
    calls.push(options);
    if (options.effort) {
      return { result: { status: "ERROR", error: '--effort is not supported for model "x"' }, events: [], deniedActions: [], stderr: "", ok: false, failure: "failed" };
    }
    return { result: { status: "SUCCESS", response: "hello" }, events: [], deniedActions: [], stderr: "", ok: true, failure: null };
  }, () => true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].effort, undefined);
  assert.ok(calls[0].cwd.startsWith(os.tmpdir()));
  assert.ok(calls[1].cwd.startsWith(os.tmpdir()));
  assert.ok(!JSON.stringify(calls[0]).includes(process.cwd()), "the repository path reached agy on the first try");
  assert.ok(!JSON.stringify(calls[1]).includes(process.cwd()), "the repository path reached agy on the retry");
  assert.equal(out.effortDropped, true);
  assert.equal(out.ok, true);
});

// The name says isolation, so the assertions have to prove it: a temp cwd
// reached the stub, and the repository path never did. Model and timeout
// alone would not show the run was isolated at all.
test("search with a query renders the search template through an isolated run", async () => {
  const calls = [];
  const out = await search("--model m latest node lts", fakeRun(calls), () => true);
  assert.equal(out.ok, true);
  assert.equal(out.mode, "search");
  assert.match(calls[0].prompt, /latest node lts/);
  assert.match(calls[0].prompt, /Sources:/);
  assert.equal(calls[0].options.model, "m");
  assert.equal(calls[0].options.printTimeout, "3m");
  assert.ok(calls[0].options.cwd.startsWith(os.tmpdir()));
  assert.ok(!JSON.stringify(calls[0].options).includes(process.cwd()), "the repository path reached agy");
});

test("search with a url renders the fetch template after the guard passes", async () => {
  const calls = [];
  const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  const out = await search("https://example.com/", fakeRun(calls), () => true, lookup);
  assert.equal(out.ok, true);
  assert.equal(out.mode, "fetch");
  assert.match(calls[0].prompt, /https:\/\/example\.com\//);
});

test("search with a blocked url never reaches agy", async () => {
  const calls = [];
  const out = await search("http://127.0.0.1/admin", fakeRun(calls), () => true);
  assert.equal(out.ok, false);
  assert.equal(out.failure, "url-blocked");
  assert.equal(calls.length, 0);
});

test("search refuses an empty argument", async () => {
  const out = await search("", fakeRun([]), () => true);
  assert.equal(out.ok, false);
  assert.match(out.error, /query or a URL/);
});
