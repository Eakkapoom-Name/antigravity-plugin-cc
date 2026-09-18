import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { parseFlaggedArguments, research, review, search, transfer, whisper } from "../scripts/agy-companion.mjs";

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

// A multiword query is not a bare URL, so it used to skip guardFetchUrl
// entirely and hand the URL to agy inside a search prompt instead. The model
// would still read it, so this is the same guard the fetch path uses, just
// applied to every URL-shaped word in the query rather than to the whole
// argument.
test("search refuses a blocked url embedded in a multiword query", async () => {
  const calls = [];
  const out = await search("please check http://127.0.0.1/admin and report back", fakeRun(calls), () => true);
  assert.equal(out.ok, false);
  assert.equal(out.failure, "url-blocked");
  assert.equal(calls.length, 0);
});

// A whitespace-anchored token check misses a URL that is wrapped in
// punctuation, since the token itself does not begin with the scheme; the
// scheme can start anywhere in the query text.
test("search refuses a blocked url wrapped in punctuation inside a query", async () => {
  for (const argument of [
    "read (http://127.0.0.1/admin) please",
    'quote "http://127.0.0.1/admin" back to me',
    "open <http://127.0.0.1/admin> for me"
  ]) {
    const calls = [];
    const out = await search(argument, fakeRun(calls), () => true);
    assert.equal(out.ok, false, argument);
    assert.equal(out.failure, "url-blocked", argument);
    assert.equal(calls.length, 0, argument);
  }
});

// The multiword scan only checks http and https tokens: a query merely
// mentioning another scheme is prose, not a fetch target, and refusing it
// would be a false positive the user has no way to appeal.
test("a query mentioning a non-http scheme as text reaches the search path", async () => {
  const calls = [];
  const out = await search("what does ftp:// mean", fakeRun(calls), () => true);
  assert.equal(out.ok, true);
  assert.equal(out.mode, "search");
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /what does ftp:\/\/ mean/);
});

// The narrowing to http/https tokens must not reopen the punctuation-wrapped
// evasion the previous fix closed: a blocked http URL in parentheses still
// has to be refused.
test("a blocked http url wrapped in parentheses inside a query is still refused", async () => {
  const calls = [];
  const out = await search("please check (http://127.0.0.1/admin) now", fakeRun(calls), () => true);
  assert.equal(out.ok, false);
  assert.equal(out.failure, "url-blocked");
  assert.equal(calls.length, 0);
});

test("an ordinary multiword query with no url still reaches the search path", async () => {
  const calls = [];
  const out = await search("what is the current node lts version", fakeRun(calls), () => true);
  assert.equal(out.ok, true);
  assert.equal(out.mode, "search");
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /current node lts version/);
});

// `\S+` grabs trailing prose punctuation too, and a comma glued directly to
// a bare host (no path to separate it) becomes part of the hostname, which
// then fails to resolve and refuses an otherwise ordinary query. The stub
// `lookup` in the original version of this test ignored its `host`
// argument and always returned success, so it passed whether or not the
// comma was stripped; capturing and asserting the exact host is what makes
// this fail against the unfixed code, where the resolved host would be
// "example.com," with the comma still attached.
test("a query with a trailing comma after a public url still reaches the search path", async () => {
  const calls = [];
  const lookedUpHosts = [];
  const lookup = async (host) => {
    lookedUpHosts.push(host);
    return [{ address: "93.184.216.34", family: 4 }];
  };
  const out = await search("see https://example.com, then stop", fakeRun(calls), () => true, lookup);
  assert.equal(out.ok, true);
  assert.equal(out.mode, "search");
  assert.equal(calls.length, 1);
  assert.deepEqual(lookedUpHosts, ["example.com"], "the trailing comma should have been stripped from the host before resolving");
});

// A literal IP address never reaches a DNS lookup, so the unfixed version of
// this test also refused the query, but only because a real
// dns.promises.lookup call for the garbled host "127.0.0.1," fails: the
// reason text said so was a DNS failure, not that 127.0.0.1 was correctly
// recognised as a reserved address. Asserting the exact reason is what
// makes this fail against the unfixed code.
test("a blocked url followed by a comma inside a query is still refused", async () => {
  const calls = [];
  const out = await search("see http://127.0.0.1, then stop", fakeRun(calls), () => true);
  assert.equal(out.ok, false);
  assert.equal(out.failure, "url-blocked");
  assert.equal(calls.length, 0);
  assert.match(
    out.error,
    /address 127\.0\.0\.1 is a local or reserved address/,
    "the comma should have been stripped, leaving a clean literal-address block rather than a DNS resolution failure"
  );
});

// http and https are WHATWG "special schemes": Node's URL parser accepts
// them with no "//" at all ("http:127.0.0.1") and with backslashes in place
// of slashes ("http:\127.0.0.1"), both resolving to the same address as the
// slashed form. This is the same bypass class finding 1 closed, on both the
// fetch path (the whole argument is one such token) and the query scan (one
// word of a multiword query is).
test("search refuses a colon-only url with no slashes on the fetch path", async () => {
  const calls = [];
  const out = await search("http:127.0.0.1", fakeRun(calls), () => true);
  assert.equal(out.ok, false);
  assert.equal(out.failure, "url-blocked");
  assert.equal(out.mode, "fetch");
  assert.equal(calls.length, 0);
});

test("search refuses a backslash-form url with no slashes on the fetch path", async () => {
  const calls = [];
  const out = await search("http:\\127.0.0.1", fakeRun(calls), () => true);
  assert.equal(out.ok, false);
  assert.equal(out.failure, "url-blocked");
  assert.equal(out.mode, "fetch");
  assert.equal(calls.length, 0);
});

test("search refuses a colon-only url with no slashes embedded in a query", async () => {
  const calls = [];
  const out = await search("please fetch http:127.0.0.1 for me", fakeRun(calls), () => true);
  assert.equal(out.ok, false);
  assert.equal(out.failure, "url-blocked");
  assert.equal(out.mode, "search");
  assert.equal(calls.length, 0);
});

// A query repeating the same host in several URLs resolves it once, not
// once per mention.
test("search dedupes repeated mentions of the same host in a query", async () => {
  const calls = [];
  let lookups = 0;
  const lookup = async () => {
    lookups += 1;
    return [{ address: "93.184.216.34", family: 4 }];
  };
  const out = await search(
    "compare https://example.com/a and https://example.com/b and https://example.com/c",
    fakeRun(calls),
    () => true,
    lookup
  );
  assert.equal(out.ok, true);
  assert.equal(lookups, 1, "the same host should only be resolved once");
  assert.equal(calls.length, 1);
});

// A query naming more distinct hosts than the cap is refused outright
// rather than resolving an unbounded list of hosts one at a time.
test("search refuses a query naming more distinct hosts than the cap", async () => {
  const calls = [];
  let lookups = 0;
  const lookup = async () => {
    lookups += 1;
    return [{ address: "93.184.216.34", family: 4 }];
  };
  const manyHosts = Array.from({ length: 25 }, (_, i) => `https://host${i}.example.com/`).join(" ");
  const out = await search(manyHosts, fakeRun(calls), () => true, lookup);
  assert.equal(out.ok, false);
  assert.equal(out.failure, "url-blocked");
  assert.equal(calls.length, 0);
  assert.equal(lookups, 20, "expected exactly the cap's worth of lookups before refusing");
});

// `]` is itself trailing punctuation, so stripping it the same way a
// trailing comma is stripped would cut a bracketed IPv6 literal's own
// closing bracket off, leaving something that fails to parse at all: this
// is the public-IPv6-literal-in-a-query must-pass case.
test("a public bracketed ipv6 literal in a query still reaches the search path", async () => {
  const calls = [];
  const lookup = async () => {
    throw new Error("a literal address must not be resolved");
  };
  const out = await search("check http://[2606:4700::1111] now", fakeRun(calls), () => true, lookup);
  assert.equal(out.ok, true);
  assert.equal(out.mode, "search");
  assert.equal(calls.length, 1);
});

test("a blocked bracketed ipv6 literal in a query is still refused", async () => {
  const calls = [];
  const out = await search("check http://[fe80::1] now", fakeRun(calls), () => true);
  assert.equal(out.ok, false);
  assert.equal(out.failure, "url-blocked");
  assert.match(out.error, /fe80::1/);
  assert.equal(calls.length, 0);
});

// Deduping by host must only skip the DNS lookup, not the scheme and
// credentials checks: a query naming the same host twice, the second time
// with credentials, still has to refuse the second mention even though the
// first already passed.
test("a second mention of an already-checked host still gets its credentials checked", async () => {
  const calls = [];
  let lookups = 0;
  const lookup = async () => {
    lookups += 1;
    return [{ address: "93.184.216.34", family: 4 }];
  };
  const out = await search("see https://example.com/ and https://u:p@example.com/x", fakeRun(calls), () => true, lookup);
  assert.equal(out.ok, false);
  assert.equal(out.failure, "url-blocked");
  assert.match(out.error, /credentials/);
  assert.equal(calls.length, 0);
  assert.equal(lookups, 1, "the DNS lookup for the already-known host should still be deduped");
});

// A sentence that merely mentions a scheme still reaches the search path and
// still costs nothing: the token is parsed and guarded like any other, but a
// bare single-label host that is neither an IP literal nor a special-use
// name skips the resolver call, so no DNS lookup happens.
test("a colon-only scheme mention in a query reaches search with no dns lookup", async () => {
  const calls = [];
  let lookups = 0;
  const lookup = async () => {
    lookups += 1;
    return [{ address: "93.184.216.34", family: 4 }];
  };
  const out = await search("read about http:scheme handling", fakeRun(calls), () => true, lookup);
  assert.equal(out.ok, true);
  assert.equal(out.mode, "search");
  assert.equal(calls.length, 1);
  assert.equal(lookups, 0, "a bare scheme mention should not trigger a DNS lookup");
});

// Node's URL parser turns a bare number into an IPv4 address ("443" becomes
// "0.0.1.187", "2130706433" becomes "127.0.0.1"), so a port-like mention and
// the decimal spelling of loopback are the same token shape and cannot be
// told apart before the parse. Both are refused: the parsed host is what
// decides, and the cost of that is this one false positive on a sentence
// about a port number.
test("a port-like bare number in a query parses to an address and is refused", async () => {
  const calls = [];
  const out = await search("the port http:443 thing", fakeRun(calls), () => true);
  assert.equal(out.ok, false);
  assert.equal(out.failure, "url-blocked");
  assert.equal(out.mode, "search");
  assert.match(out.error, /address 0\.0\.1\.187 is a local or reserved address/);
  assert.equal(calls.length, 0);
});

// Each of these parses to a host the guard blocks, and none of them looks
// like one as text: a single leading slash leaves nothing before the first
// "/" to inspect, a backslash before a bracket means the token does not
// start with "[", and a dotless, decimal or hex host has no dot to test for.
// Deciding candidacy on the parsed URL rather than on the token's spelling
// is what catches them; every one of these reached agy unguarded at 5c4637c,
// where a string test stood in front of the parser.
test("a token that parses to a blocked host is refused however it is spelled", async () => {
  const cases = [
    ["please fetch http:/127.0.0.1 now", /address 127\.0\.0\.1 is a local or reserved address/],
    ["please fetch http:/localhost now", /host localhost is a local name/],
    ["please fetch https:/169.254.169.254 now", /address 169\.254\.169\.254 is a local or reserved address/],
    ["please fetch http:\\[::1] now", /address ::1 is a local or reserved address/],
    ["please fetch http:localhost now", /host localhost is a local name/],
    ["please fetch http:metadata now", /host metadata is a local name/],
    ["please fetch http:2130706433 now", /address 127\.0\.0\.1 is a local or reserved address/],
    ["please fetch http:0x7f000001 now", /address 127\.0\.0\.1 is a local or reserved address/],
    ["please fetch http:017700000001 now", /address 127\.0\.0\.1 is a local or reserved address/]
  ];
  for (const [argument, reason] of cases) {
    const calls = [];
    const lookup = async () => {
      throw new Error(`no DNS lookup should be needed to refuse ${argument}`);
    };
    const out = await search(argument, fakeRun(calls), () => true, lookup);
    assert.equal(out.ok, false, argument);
    assert.equal(out.failure, "url-blocked", argument);
    assert.equal(out.mode, "search", argument);
    assert.match(out.error, reason, argument);
    assert.equal(calls.length, 0, argument);
  }
});

// ftp is a WHATWG special scheme too: without this, "ftp:127.0.0.1" matched
// neither the "//" form nor the http/https colon-only form, so it reached
// agy as an unguarded search query instead of being refused for its scheme.
test("search refuses a colon-only ftp url on the fetch path", async () => {
  const calls = [];
  const out = await search("ftp:127.0.0.1", fakeRun(calls), () => true);
  assert.equal(out.ok, false);
  assert.equal(out.failure, "url-blocked");
  assert.equal(out.mode, "fetch");
  assert.match(out.error, /scheme ftp is not allowed/);
  assert.equal(calls.length, 0);
});

// The name says isolated, so the assertions prove it the same way the whisper
// and search isolation tests do: a temp cwd reached the stub, and the
// workspace root (research's stand-in for the repository path) never did.
// Model and timeout alone would not show the run was isolated at all.
test("research renders the report template, runs isolated, and writes --out only on success", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-research-"));
  const calls = [];
  try {
    const out = research("--effort high --out report.md rust async runtimes", fakeRun(calls), () => true, root);
    assert.equal(out.ok, true);
    assert.match(calls[0].prompt, /rust async runtimes/);
    assert.match(calls[0].prompt, /Sources/);
    assert.equal(calls[0].options.printTimeout, "9m");
    assert.equal(calls[0].options.effort, "high");
    assert.ok(calls[0].options.cwd.startsWith(os.tmpdir()));
    assert.ok(!JSON.stringify(calls[0].options).includes(root), "the workspace root reached agy");
    assert.ok(!JSON.stringify(calls[0].options).includes(process.cwd()), "the repository path reached agy");
    assert.equal(out.outPath, path.join(fs.realpathSync(root), "report.md"));
    assert.equal(fs.readFileSync(out.outPath, "utf8"), "No findings.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("research refuses a bad --out before running", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-research-"));
  const calls = [];
  try {
    const out = research("--out ../x.md topic", fakeRun(calls), () => true, root);
    assert.equal(out.ok, false);
    assert.equal(calls.length, 0);
    assert.match(out.error, /--out/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("research does not write when the run failed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-research-"));
  try {
    const out = research(
      "--out r.md topic",
      () => ({ result: { status: "ERROR" }, events: [], deniedActions: [], stderr: "", ok: false, failure: "failed" }),
      () => true,
      root
    );
    assert.equal(out.ok, false);
    assert.equal(out.outPath, undefined);
    assert.ok(!fs.existsSync(path.join(root, "r.md")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("research needs a topic and does not spend a run on an empty one", () => {
  const calls = [];
  const out = research("--model m", fakeRun(calls), () => true);
  assert.equal(out.ok, false);
  assert.match(out.error, /needs a topic/);
  assert.equal(calls.length, 0);
});

// resolveOutputPath already checked the target was free before the run
// started, but the run itself can take minutes; something else can occupy
// the name in the meantime. The report the run produced is not worth
// throwing away over a write that lost that race, so it survives on the
// payload and only the file write is reported as failed.
test("research keeps the report when the --out write loses a race", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-research-"));
  try {
    const out = research(
      "--out r.md topic",
      (prompt, options) => {
        fs.writeFileSync(path.join(root, "r.md"), "raced\n");
        return fakeRun([])(prompt, options);
      },
      () => true,
      root
    );
    assert.equal(out.ok, true);
    assert.equal(out.outPath, undefined);
    assert.match(out.outError, /EEXIST/);
    assert.equal(out.result.response, "No findings.");
    assert.equal(fs.readFileSync(path.join(root, "r.md"), "utf8"), "raced\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
