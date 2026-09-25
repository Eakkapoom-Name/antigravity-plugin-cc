import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { extractImagePath, image, parseFlaggedArguments, quotaRunError, research, review, search, transfer, whisper } from "../scripts/agy-companion.mjs";
import { read } from "./helpers.mjs";

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

// A diff whose shape the scanner does not recognize (no `diff --git` header
// at all, here because every line starts with an ANSI color escape) cannot be
// trusted as scanned, so it never reaches agy. The other shapes below carry a
// `diff --git` header but no hunk, and still go through.
function collected(diff) {
  return () => ({ ok: true, scope: { label: "working tree against HEAD" }, diff, error: null, empty: diff.trim().length === 0 });
}

function reviewWith(diff, adversarial = false) {
  const calls = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-companion-"));
  const out = withWorkspace(dir, () =>
    review({ argument: "", adversarial, run: fakeRun(calls), available: () => true, collect: collected(diff) })
  );
  return { out, calls };
}

test("a diff of unrecognized shape is refused, not sent unscanned", () => {
  const esc = "\x1b";
  const colored = [
    `${esc}[1mdiff --git a/a.txt b/a.txt${esc}[m`,
    `${esc}[1mindex aaa..bbb 100644${esc}[m`,
    `${esc}[1m--- a/a.txt${esc}[m`,
    `${esc}[1m+++ b/a.txt${esc}[m`,
    `${esc}[36m@@ -1 +1,2 @@${esc}[m`,
    " one",
    `${esc}[32m+two${esc}[m`,
    ""
  ].join("\n");
  for (const adversarial of [false, true]) {
    const { out, calls } = reviewWith(colored, adversarial);
    assert.equal(calls.length, 0, "agy ran on an unrecognized diff");
    assert.equal(out.ok, false);
    assert.equal(out.failure, "diff-shape");
    assert.match(out.error, /diff shape not recognized, refusing to send it unscanned/);
  }
});

test("binary-only, mode-only and rename-only diffs still go through", () => {
  const shapes = [
    ["diff --git a/b.bin b/b.bin", "index 1111111..2222222 100644", "Binary files a/b.bin and b/b.bin differ", ""],
    ["diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755", ""],
    ["diff --git a/old.txt b/new.txt", "similarity index 100%", "rename from old.txt", "rename to new.txt", ""]
  ];
  for (const lines of shapes) {
    const { out, calls } = reviewWith(lines.join("\n"));
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(calls.length, 1, lines[0]);
  }
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

// F60. The command docs tell the model how to render a `hits[]` entry: the
// full `<file>:<line> <kind> (<sample>)` form, or just `<line> <kind>
// (<sample>)` when `file` is missing. A review hit always has a file (a git
// diff always carries its `+++` header), a transfer hit never does (the brief
// is scanned as plain text), so both real payloads are checked against the
// wording of the doc that renders them.
test("the documented hit forms match the real review and transfer payloads", () => {
  const reviewOut = withWorkspace(scratchRepo(`key = "${AWS}"`), () =>
    review({ argument: "", adversarial: false, run: fakeRun([]), available: () => true })
  );
  assert.equal(reviewOut.failure, "secrets");
  const reviewHit = reviewOut.hits[0];
  assert.equal(reviewHit.file, "a.txt");
  assert.equal(typeof reviewHit.line, "number");
  assert.equal(typeof reviewHit.kind, "string");
  assert.equal(typeof reviewHit.sample, "string");
  assert.equal(reviewHit.side, "added");

  const { dir, file } = scratchBrief(`Handoff notes.\nkey = "${AWS}"\n`);
  let transferHit;
  try {
    const transferOut = transfer({ argument: file, run: fakeRun([]), available: () => true });
    assert.equal(transferOut.failure, "secrets");
    transferHit = transferOut.hits[0];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(!("file" in transferHit), "a transfer hit must not carry a file key");
  assert.equal(typeof transferHit.line, "number");
  assert.equal(typeof transferHit.kind, "string");
  assert.equal(typeof transferHit.sample, "string");

  const full = "`<file>:<line> <kind> (<sample>)`";
  const fallback = "just `<line> <kind> (<sample>)` when `file` is missing";
  for (const name of ["review.md", "adversarial-review.md"]) {
    const source = read(`commands/${name}`);
    assert.ok(source.includes(full), `${name} does not document the full hit form`);
    assert.ok(source.includes(fallback), `${name} does not document the file-missing fallback`);
  }
  const transferDoc = read("commands/transfer.md");
  assert.ok(transferDoc.includes("`<line> <kind> (<sample>)`"), "transfer.md does not document the file-less hit form");
  assert.ok(!transferDoc.includes("<file>:"), "transfer.md documents a file that its hits never carry");
});

test("parseFlaggedArguments splits named flags from the free text", () => {
  // A flag repeats only when the caller declares it repeatable, which is the
  // one shape `--allow-secret` needs and no other consumer of this parser has.
  const parsed = parseFlaggedArguments(
    "--model gemini --effort high what is a monad --allow-secret a --allow-secret b",
    ["--model", "--effort", "--allow-secret"],
    ["--allow-secret"]
  );
  assert.deepEqual(parsed.flags, { model: "gemini", effort: "high", allowSecret: ["a", "b"] });
  assert.equal(parsed.rest, "what is a monad");
  assert.equal(parsed.error, undefined);
  assert.deepEqual(parseFlaggedArguments("", ["--model"]), { flags: {}, rest: "" });
  assert.equal(parseFlaggedArguments("--model", ["--model"]).rest, "");
});

// The same input without the repeatable declaration is a refusal, not an
// array: an array reaches `buildArgs` as a non-string argv entry, and
// `spawnSync` then rejects the whole run with a message naming none of this.
test("parseFlaggedArguments refuses a repeated flag that was not declared repeatable", () => {
  const parsed = parseFlaggedArguments("--allow-secret a --allow-secret b diff", ["--allow-secret"]);
  assert.equal(parsed.error, "--allow-secret was given more than once; it takes a single value.");
  assert.deepEqual(
    parseFlaggedArguments("--model a --model b hi", ["--model"]).error,
    "--model was given more than once; it takes a single value."
  );
});

test("whisper refuses an empty prompt without spending a run", () => {
  const calls = [];
  const out = whisper("--model x", fakeRun(calls), () => true);
  assert.equal(out.ok, false);
  assert.match(out.error, /needs a prompt/);
  assert.equal(calls.length, 0);
});

// A repeated scalar flag is refused by name before a run is spent. The old
// array behaviour put `["a", "b"]` into `options.model`, which reached argv as
// a non-string and failed inside spawnSync with ERR_INVALID_ARG_TYPE, reported
// to the user as a generic failure naming neither the flag nor the repeat.
test("whisper refuses --model given twice, by name, without spending a run", () => {
  const calls = [];
  const out = whisper("--model a --model b why is the sky blue", fakeRun(calls), () => true);
  assert.equal(out.ok, false);
  assert.equal(out.error, "--model was given more than once; it takes a single value.");
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
// about a port number. The reason keeps the address the parser produced and
// adds that the number was read as one, since the user never typed
// "0.0.1.187" and would otherwise be told about an address out of nowhere.
// The hint is for the slash-free form only: "http://443" spelled out an
// authority, so its author meant a host, not a port.
test("a port-like bare number in a query parses to an address and is refused", async () => {
  const calls = [];
  const out = await search("the port http:443 thing", fakeRun(calls), () => true);
  assert.equal(out.ok, false);
  assert.equal(out.failure, "url-blocked");
  assert.equal(out.mode, "search");
  assert.match(out.error, /address 0\.0\.1\.187 is a local or reserved address/);
  assert.match(out.error, /the number 443 after "http:" was read as an address/);
  assert.match(out.error, /reword/);
  assert.equal(calls.length, 0);

  const slashed = await search("check http://443 now", fakeRun(calls), () => true);
  assert.equal(slashed.ok, false);
  assert.match(slashed.error, /address 0\.0\.1\.187 is a local or reserved address/);
  assert.doesNotMatch(slashed.error, /was read as an address/, "the hint is for the slash-free form only");
  assert.equal(calls.length, 0);
});

// The DNS skip is for a sentence that mentions a scheme bare ("read about
// http:scheme handling"). A dotless token that goes on to name a path, a
// port or a query is spelled like a fetch target, not like prose, so it
// keeps its lookup and is judged on the answer, the way the fetch path
// always did. Before this, every slash-free dotless token skipped the
// resolver, so "http:intranet/admin" in a query reached agy unresolved.
test("a dotless host with a path, port or query after it in a query is still resolved", async () => {
  for (const argument of [
    "open http:intranet/admin for me",
    "open http:intranet:8080 for me",
    "open http:intranet?page=1 for me"
  ]) {
    const calls = [];
    const lookedUpHosts = [];
    const lookup = async (host) => {
      lookedUpHosts.push(host);
      return [{ address: "10.0.0.5", family: 4 }];
    };
    const out = await search(argument, fakeRun(calls), () => true, lookup);
    assert.equal(out.ok, false, argument);
    assert.equal(out.failure, "url-blocked", argument);
    assert.match(out.error, /host intranet resolves to 10\.0\.0\.5/, argument);
    assert.deepEqual(lookedUpHosts, ["intranet"], argument);
    assert.equal(calls.length, 0, argument);
  }
});

// "http:/host" and "http:\host" spell an authority the same way "http://host"
// does: the WHATWG parser takes any number of leading slashes or backslashes
// as the authority marker. They keep their lookup like the two-slash form;
// only the form with no slash at all is a prose mention.
test("a single-slash or backslash authority in a query is still resolved", async () => {
  for (const argument of ["open http:/intranet for me", "open http:\\intranet for me"]) {
    const calls = [];
    const lookedUpHosts = [];
    const lookup = async (host) => {
      lookedUpHosts.push(host);
      return [{ address: "10.0.0.5", family: 4 }];
    };
    const out = await search(argument, fakeRun(calls), () => true, lookup);
    assert.equal(out.ok, false, argument);
    assert.equal(out.failure, "url-blocked", argument);
    assert.match(out.error, /host intranet resolves to 10\.0\.0\.5/, argument);
    assert.deepEqual(lookedUpHosts, ["intranet"], argument);
    assert.equal(calls.length, 0, argument);
  }
});

// A possessive glued to a bare host ("http://127.0.0.1's page") used to
// leave the host as "127.0.0.1's", which is not an IP literal, so the
// refusal came from the resolver failing on that name rather than from the
// address check, and the reason text said so. The strip takes the "'s" the
// same way it takes a trailing comma: the literal is refused for what it is,
// with no resolver call.
test("a possessive after a blocked literal in a query is stripped before the address check", async () => {
  for (const argument of [
    "see http://127.0.0.1's page",
    "see (http://127.0.0.1's) page",
    "see http://127.0.0.1's, then stop"
  ]) {
    const calls = [];
    const lookup = async () => {
      throw new Error(`no DNS lookup should be needed to refuse ${argument}`);
    };
    const out = await search(argument, fakeRun(calls), () => true, lookup);
    assert.equal(out.ok, false, argument);
    assert.equal(out.failure, "url-blocked", argument);
    assert.match(out.error, /address 127\.0\.0\.1 is a local or reserved address/, argument);
    assert.equal(calls.length, 0, argument);
  }
});

// The same strip on a public host: "example.com's" never resolved (no DNS
// name holds an apostrophe), so this query used to be refused as a
// resolver failure. It now judges example.com, the host agy would fetch.
test("a possessive after a public host in a query is stripped before the lookup", async () => {
  const calls = [];
  const lookedUpHosts = [];
  const lookup = async (host) => {
    lookedUpHosts.push(host);
    return [{ address: "93.184.216.34", family: 4 }];
  };
  const out = await search("see https://example.com's page", fakeRun(calls), () => true, lookup);
  assert.equal(out.ok, true);
  assert.equal(out.mode, "search");
  assert.equal(calls.length, 1);
  assert.deepEqual(lookedUpHosts, ["example.com"], "the possessive should have been stripped from the host before resolving");
});

// F100. The strip above takes the ASCII possessive "'s" only. A query typed
// with a curly apostrophe (the character autocorrect and most phone
// keyboards actually produce) leaves the host as "127.0.0.1’s", which
// the URL parser IDNA-encodes into a real hostname the address check never
// fires on, so the refusal would come from the resolver failing on that
// name instead: the same misleading-reason class this file's ASCII test
// above fixed.
test("a curly possessive after a blocked literal in a query is stripped before the address check", async () => {
  const argument = "see http://127.0.0.1’s page";
  const calls = [];
  const lookup = async () => {
    throw new Error(`no DNS lookup should be needed to refuse ${argument}`);
  };
  const out = await search(argument, fakeRun(calls), () => true, lookup);
  assert.equal(out.ok, false);
  assert.equal(out.failure, "url-blocked");
  assert.match(out.error, /address 127\.0\.0\.1 is a local or reserved address/);
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
    assert.equal(calls[0].options.printTimeout, "8m");
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

// `--out` twice used to be joined by String() into the single path
// "a.md,b.md", which resolveOutputPath then accepted as an ordinary relative
// name: the report landed in a file neither of the two the user named.
test("research refuses --out given twice instead of writing to the joined path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-research-"));
  const calls = [];
  try {
    const out = research("--out a.md --out b.md topic", fakeRun(calls), () => true, root);
    assert.equal(out.ok, false);
    assert.equal(out.error, "--out was given more than once; it takes a single value.");
    assert.equal(calls.length, 0);
    assert.ok(!fs.existsSync(path.join(root, "a.md,b.md")));
    assert.ok(!fs.existsSync(path.join(root, "a.md")));
    assert.ok(!fs.existsSync(path.join(root, "b.md")));
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

// F82. `resolveOutputPath` already checked --out before the run started, and
// the write itself uses "wx" so it never silently overwrites, but neither of
// those stops an `ok: true` run whose response is empty from creating a
// zero-byte file and reporting `outPath` as if a report had been written:
// the user is told the file exists and finds nothing in it, and the empty
// name is now occupied for a rerun.
test("research skips the --out write and says so when the response is empty", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-research-"));
  try {
    const out = research(
      "--out r.md topic",
      () => ({ result: { conversation_id: "c", status: "SUCCESS", response: "" }, events: [], deniedActions: [], stderr: "", ok: true, failure: null }),
      () => true,
      root
    );
    assert.equal(out.ok, true);
    assert.equal(out.outPath, undefined);
    assert.match(out.outError, /empty/);
    assert.ok(!fs.existsSync(path.join(root, "r.md")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("research skips the --out write when the response is whitespace only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-research-"));
  try {
    const out = research(
      "--out r.md topic",
      () => ({ result: { conversation_id: "c", status: "SUCCESS", response: "  \n\n  " }, events: [], deniedActions: [], stderr: "", ok: true, failure: null }),
      () => true,
      root
    );
    assert.equal(out.ok, true);
    assert.equal(out.outPath, undefined);
    assert.match(out.outError, /empty/);
    assert.ok(!fs.existsSync(path.join(root, "r.md")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// F70. resolveOutputPath proved the parent was inside the workspace before
// the run started, but the run itself can take minutes, and a parent
// directory swapped for a symlink to somewhere else in that window is not
// caught by the "wx" write, which follows the symlink to reach the final
// path component the same way the initial check's realpathSync did. The
// re-check immediately before the write must catch it instead.
test("research re-checks containment immediately before the write and refuses a parent swapped for a symlink", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-research-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agy-outside-"));
  try {
    fs.mkdirSync(path.join(root, "sub"));
    const out = research(
      "--out sub/r.md topic",
      (prompt, options) => {
        fs.rmSync(path.join(root, "sub"), { recursive: true, force: true });
        fs.symlinkSync(outside, path.join(root, "sub"));
        return fakeRun([])(prompt, options);
      },
      () => true,
      root
    );
    assert.equal(out.ok, true);
    assert.equal(out.outPath, undefined);
    assert.match(out.outError, /inside the workspace/);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// Every temp directory these image tests create is removed in a finally
// block, on both the pass and the fail path, so the suite adds nothing to the
// /tmp/agy-* pile a stray test helper elsewhere has already left behind.
function fakeBrain() {
  const brain = fs.mkdtempSync(path.join(os.tmpdir(), "agy-brain-"));
  const conv = path.join(brain, "e0920187-99dc-44bb-9631-e145ab5ede24");
  fs.mkdirSync(conv);
  const file = path.join(conv, "agy-probe.png");
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return { brain, file };
}

test("extractImagePath accepts the one-line path agy returns when it sits under brain", () => {
  const { brain, file } = fakeBrain();
  try {
    assert.deepEqual(extractImagePath(`${file}\n`, brain), { ok: true, path: fs.realpathSync(file) });
    assert.equal(extractImagePath(`Saved your image to ${file} as requested.`, brain).ok, true);
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
  }
});

test("extractImagePath refuses paths outside brain, symlinks out, missing files, and other extensions", () => {
  const { brain } = fakeBrain();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agy-outside-"));
  try {
    const elsewhere = path.join(outside, "x.png");
    fs.writeFileSync(elsewhere, "x");
    assert.equal(extractImagePath(elsewhere, brain).ok, false);
    const link = path.join(brain, "link.png");
    fs.symlinkSync(elsewhere, link);
    assert.equal(extractImagePath(link, brain).ok, false);
    assert.equal(extractImagePath(path.join(brain, "missing.png"), brain).ok, false);
    assert.equal(extractImagePath("no path here", brain).ok, false);
    const txt = path.join(brain, "notes.txt");
    fs.writeFileSync(txt, "x");
    assert.equal(extractImagePath(txt, brain).ok, false);
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// The second check, on the resolved path rather than the response text. A
// response naming a non-image directly ("notes.txt") never reaches it: the
// response pattern rejects that first, for a different reason. Only a name
// that passes the pattern and resolves, inside brain, to something that is not
// an image gets there, which is a *.png symlink to a non-image sibling. The
// copy would otherwise be made and reported as an image.
test("extractImagePath refuses a png symlink inside brain that resolves to a non-image", () => {
  const { brain } = fakeBrain();
  try {
    const real = path.join(brain, "real.bin");
    fs.writeFileSync(real, Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const link = path.join(brain, "x.png");
    fs.symlinkSync(real, link);
    const found = extractImagePath(link, brain);
    assert.equal(found.ok, false);
    assert.match(found.reason, /does not resolve to an image/);
    assert.match(found.reason, /real\.bin/);
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
  }
});

// A string-prefix check on the unresolved text would pass this: the path
// spells "brain/..." only up to the point where ".." walks back out. Only
// realpathSync on both sides, which is what extractImagePath actually does,
// catches that the file it names is a sibling of brain, not a child of it.
// The bare relative path pins the companion behaviour of never accepting one:
// the path pattern itself requires a leading "/" or a drive letter.
test("extractImagePath refuses a path that escapes brain via .. and a bare relative path", () => {
  const { brain } = fakeBrain();
  const escaped = path.join(brain, "..", `${path.basename(brain)}-escaped.png`);
  fs.writeFileSync(escaped, "x");
  try {
    assert.equal(extractImagePath(escaped, brain).ok, false);
    assert.equal(extractImagePath("relative/agy-probe.png", brain).ok, false);
  } finally {
    fs.rmSync(escaped, { force: true });
    fs.rmSync(brain, { recursive: true, force: true });
  }
});

// The pattern is matched without the global flag, so only the first path in
// the response is ever considered; a valid path later in the text does not
// rescue a response that named an outside path first. That is the strict
// reading of a one-line output contract, and it is pinned here so a future
// change to "scan every candidate" is a deliberate one, not a drift.
test("extractImagePath is governed by the first path in the response, not a later valid one", () => {
  const { brain, file } = fakeBrain();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agy-outside-"));
  try {
    const decoy = path.join(outside, "decoy.png");
    fs.writeFileSync(decoy, "x");
    const response = `First I considered ${decoy}, then saved the real one to ${file}`;
    assert.equal(extractImagePath(response, brain).ok, false);
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// F72. The reverse of the case above: a legitimate path under brain named
// first, with an outside decoy mentioned later in the same response, is the
// accepted direction (only the first match is ever considered), verified
// correct by execution but not pinned here until now.
test("extractImagePath accepts the first path even when a decoy follows it", () => {
  const { brain, file } = fakeBrain();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agy-outside-"));
  try {
    const decoy = path.join(outside, "decoy.png");
    fs.writeFileSync(decoy, "x");
    const response = `Saved the real one to ${file}, and for reference also considered ${decoy}`;
    assert.deepEqual(extractImagePath(response, brain), { ok: true, path: fs.realpathSync(file) });
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("image refuses an empty description without spending a run", () => {
  const calls = [];
  const out = image("--model x", fakeRun(calls), () => true);
  assert.equal(out.ok, false);
  assert.match(out.error, /needs a description/);
  assert.equal(calls.length, 0);
});

// The name says isolated, so the assertions prove it the same way the
// whisper, search, and research isolation tests do: a temp cwd reached the
// stub, and neither the workspace root nor the repository path ever did.
// Model, effort, and timeout passthrough are checked too, but alone they
// would not show the run was isolated at all.
test("image runs isolated, passes model/effort/timeout through, and copies to --out inside the workspace", () => {
  const { brain, file } = fakeBrain();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-img-root-"));
  const calls = [];
  try {
    const run = (prompt, options) => {
      calls.push({ prompt, options });
      return { result: { conversation_id: "c", status: "SUCCESS", response: `${file}\n` }, events: [], deniedActions: [], stderr: "", ok: true, failure: null };
    };
    const out = image("--model m --effort low --out hero.png a blue square", run, () => true, root, brain);
    assert.equal(out.ok, true);
    assert.match(calls[0].prompt, /a blue square/);
    assert.equal(out.imagePath, fs.realpathSync(file));
    assert.equal(out.outPath, path.join(fs.realpathSync(root), "hero.png"));
    assert.ok(fs.existsSync(out.outPath));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.model, "m");
    assert.equal(calls[0].options.effort, "low");
    assert.equal(calls[0].options.printTimeout, "5m");
    assert.ok(calls[0].options.cwd.startsWith(os.tmpdir()));
    assert.ok(!JSON.stringify(calls[0].options).includes(root), "the workspace root reached agy");
    assert.ok(!JSON.stringify(calls[0].options).includes(process.cwd()), "the repository path reached agy");
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("image without --out reports the brain path and copies nothing", () => {
  const { brain, file } = fakeBrain();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-img-root-"));
  try {
    const run = () => ({ result: { status: "SUCCESS", response: file }, events: [], deniedActions: [], stderr: "", ok: true, failure: null });
    const out = image("a blue square", run, () => true, root, brain);
    assert.equal(out.ok, true);
    assert.equal(out.imagePath, fs.realpathSync(file));
    assert.equal(out.outPath, undefined);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("image with a response that names no valid file is a failure that copies nothing", () => {
  const { brain } = fakeBrain();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-img-root-"));
  try {
    const run = () => ({ result: { status: "SUCCESS", response: "I cannot generate images." }, events: [], deniedActions: [], stderr: "", ok: true, failure: null });
    const out = image("--out x.png a square", run, () => true, root, brain);
    assert.equal(out.ok, false);
    assert.equal(out.failure, "no-image");
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// resolveOutputPath already checked hero.png was free before the run started,
// but the run itself can take minutes; something else can occupy the name in
// the meantime. The image agy produced (and that passed the containment
// check) is not worth throwing away over a copy that lost that race, so
// imagePath survives on the payload and only the copy is reported as failed,
// mirroring research's --out race handling.
test("image keeps imagePath when the --out copy loses a race", () => {
  const { brain, file } = fakeBrain();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-img-root-"));
  try {
    const out = image(
      "--out hero.png a blue square",
      () => {
        fs.writeFileSync(path.join(root, "hero.png"), "raced");
        return { result: { status: "SUCCESS", response: `${file}\n` }, events: [], deniedActions: [], stderr: "", ok: true, failure: null };
      },
      () => true,
      root,
      brain
    );
    assert.equal(out.ok, true);
    assert.equal(out.imagePath, fs.realpathSync(file));
    assert.equal(out.outPath, undefined);
    assert.match(out.outError, /EEXIST/);
    assert.equal(fs.readFileSync(path.join(root, "hero.png"), "utf8"), "raced");
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// F73. agy names the file it wrote under its own artifacts directory; the
// companion only copies it to --out, so nothing ties the copy's bytes to
// the extension the user typed. fakeBrain's file carries a PNG signature,
// so a --out name ending .jpg is the mismatch: a one-line warning in the
// payload, not a refusal or rename, keeping resolveOutputPath itself
// content-agnostic.
test("image warns when the copied file's bytes do not match the --out extension", () => {
  const { brain, file } = fakeBrain();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-img-root-"));
  try {
    const out = image(
      "--out hero.jpg a blue square",
      () => ({ result: { status: "SUCCESS", response: `${file}\n` }, events: [], deniedActions: [], stderr: "", ok: true, failure: null }),
      () => true,
      root,
      brain
    );
    assert.equal(out.ok, true);
    assert.equal(out.outPath, path.join(fs.realpathSync(root), "hero.jpg"));
    assert.match(out.warning, /png/i);
    assert.match(out.warning, /jpg|jpeg/i);
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("image carries no warning when the copied file's bytes match the --out extension", () => {
  const { brain, file } = fakeBrain();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-img-root-"));
  try {
    const out = image(
      "--out hero.png a blue square",
      () => ({ result: { status: "SUCCESS", response: `${file}\n` }, events: [], deniedActions: [], stderr: "", ok: true, failure: null }),
      () => true,
      root,
      brain
    );
    assert.equal(out.ok, true);
    assert.equal(out.warning, undefined);
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// F73. image.md tells the model which payload keys to relay on success
// (imagePath, outPath); a warning key the doc never mentions would be
// exactly as silent to the user as the mismatch was before this fix, just
// one layer up. Checked against the real payload key a mismatch actually
// produces, not just the doc's own wording.
test("image.md documents the warning key a real extension mismatch produces", () => {
  const { brain, file } = fakeBrain();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-img-root-"));
  try {
    const out = image(
      "--out hero.jpg a blue square",
      () => ({ result: { status: "SUCCESS", response: `${file}\n` }, events: [], deniedActions: [], stderr: "", ok: true, failure: null }),
      () => true,
      root,
      brain
    );
    assert.equal(typeof out.warning, "string");
    const source = read("commands/image.md");
    assert.match(source, /`warning`/, "image.md does not mention the warning key");
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// F70. Same re-check as research's, on the copy instead of the write: the
// containment check resolveOutputPath already ran is not repeated right
// before the copy, so a parent swapped for a symlink to somewhere else
// while the run was in flight is not caught, and COPYFILE_EXCL follows the
// symlink the same way "wx" does.
test("image re-checks containment immediately before the copy and refuses a parent swapped for a symlink", () => {
  const { brain, file } = fakeBrain();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-img-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agy-outside-"));
  try {
    fs.mkdirSync(path.join(root, "sub"));
    const out = image(
      "--out sub/hero.png a blue square",
      () => {
        fs.rmSync(path.join(root, "sub"), { recursive: true, force: true });
        fs.symlinkSync(outside, path.join(root, "sub"));
        return { result: { status: "SUCCESS", response: `${file}\n` }, events: [], deniedActions: [], stderr: "", ok: true, failure: null };
      },
      () => true,
      root,
      brain
    );
    assert.equal(out.ok, true);
    assert.equal(out.outPath, undefined);
    assert.match(out.outError, /inside the workspace/);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// F93. An agy run that ends on a model or agent error (exit 3 since 1.2.6)
// comes back as failure "agy-error" with the parsed AGY_ERROR line. The command
// payload has to carry it, or the caller only sees a generic failure.
test("a companion payload forwards the AGY_ERROR of a failed run", () => {
  const agyError = { status: "UNAVAILABLE", code: 503 };
  const out = whisper(
    "what is 2+2",
    () => ({
      result: { status: "ERROR", response: "partial", conversation_id: "c1" },
      events: ["result"],
      deniedActions: [],
      stderr: `AGY_ERROR: ${JSON.stringify(agyError)}`,
      ok: false,
      failure: "agy-error",
      agyError
    }),
    () => true
  );
  assert.equal(out.ok, false);
  assert.equal(out.failure, "agy-error");
  assert.deepEqual(out.agyError, agyError);
  assert.equal(out.result.response, "partial");
});

// F102 review. quota's error was `stderr || "... (timeout)"`, so a timeout
// that left any stderr behind never said it was a timeout. The failure kind
// is now appended whether or not stderr is empty.
test("quota names the failure kind even when agy wrote stderr", () => {
  assert.equal(
    quotaRunError({ ok: false, stderr: "partial output", failure: "timeout" }),
    "partial output (timeout)"
  );
  assert.equal(
    quotaRunError({ ok: false, stderr: "", failure: "timeout" }),
    "the /usage call failed (timeout)"
  );
  assert.equal(
    quotaRunError({ ok: false, stderr: "not json", failure: "invalid-json" }),
    "not json (invalid-json)"
  );
});

test("quota.md tells the model what a timeout failure means", () => {
  const source = read("commands/quota.md");
  assert.match(source, /\(timeout\)/);
});
