import test from "node:test";
import assert from "node:assert/strict";

import { SECRET_KINDS, scanForSecrets } from "../scripts/lib/secrets.mjs";

// Every fixture is assembled at runtime so this file never holds a key-shaped
// literal that GitHub push protection or a secret scanner would flag.
const AWS = "AKIA" + "IOSFODNN7EXAMPLE"; // AWS's own documented example id
const GH = "ghp_" + "x".repeat(36);
const GH_PAT = "github_pat_" + "A".repeat(22) + "_" + "b".repeat(30);
const SLACK = "xoxb-" + "1".repeat(12) + "-" + "a".repeat(24);
const GOOGLE = "AIza" + "S".repeat(35);
const BEARER = "Bearer " + "t".repeat(40);
const PEM = "-----BEGIN " + "RSA PRIVATE KEY-----";
const ASSIGN = "DATABASE_PASSWORD=" + "p".repeat(24);
const URL_PASSWORD = "hunter2" + "example" + "pw"; // short on purpose: a URL password has no length floor
const CRED_URL = `postgres://app:${URL_PASSWORD}@db.internal:5432/app`;

const positives = [
  ["aws-access-key-id", `const id = "${AWS}";`],
  ["github-token", `token: ${GH}`],
  ["github-token", `token: ${GH_PAT}`],
  ["slack-token", `SLACK_TOKEN=${SLACK}`],
  ["google-api-key", `key=${GOOGLE}`],
  ["authorization-header", `Authorization: ${BEARER}`],
  ["private-key-block", PEM],
  ["secret-assignment", ASSIGN],
  // The identifier carries none of the secret-assignment words, so only the
  // URL shape itself can catch this (F34).
  ["credential-url", `DATABASE_URL=${CRED_URL}`],
  ["credential-url", `const url = "https://deploy:${URL_PASSWORD}@registry.example";`],
  ["credential-url", `redis://:${URL_PASSWORD}@cache:6379/0`]
];

for (const [kind, line] of positives) {
  test(`scanForSecrets flags a ${kind}`, () => {
    const { hits } = scanForSecrets(`first line\n${line}\n`);
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.equal(hits[0].kind, kind);
    assert.equal(hits[0].line, 2);
    assert.ok(hits[0].sample.length <= 24);
    assert.ok(!hits[0].sample.includes("x".repeat(20)), "the sample carries the value");
  });
}

test("every kind the scanner knows is named in SECRET_KINDS", () => {
  const seen = new Set(positives.map(([kind]) => kind));
  for (const kind of seen) {
    assert.ok(SECRET_KINDS.includes(kind), kind);
  }
});

const negatives = [
  "API_KEY=<your-api-key>",
  "SECRET_TOKEN=${SECRET_TOKEN}",
  "PASSWORD=changeme",
  "TOKEN=xxxxxxxxxxxxxxxxxxxx",
  "digest: sha256:" + "0".repeat(64),
  "const SECRET_NAME = 'short';",
  "Authorization: Bearer <token>",
  "AKIA is the prefix, not a key",
  // URL shapes with no password in them, or a placeholder where one would be.
  "DATABASE_URL=postgres://db.internal:5432/app",
  "https://host:8080/path?x=a@b",
  "ssh://git@github.com/org/repo",
  "git@github.com:org/repo.git",
  "DATABASE_URL=postgres://app:${DB_PASSWORD}@db.internal/app",
  "DATABASE_URL=postgres://app:$DB_PASSWORD@db.internal/app",
  "DATABASE_URL=postgres://app:<password>@db.internal/app",
  "mail me at someone@example.com or see http://example.com:80/"
];

for (const line of negatives) {
  test(`scanForSecrets ignores ${line.slice(0, 30)}`, () => {
    assert.deepEqual(scanForSecrets(line).hits, []);
  });
}

// F76. The whole diff leaves on stdin, removed and context lines included, so
// every content line is scanned. An added or context hit is numbered in the
// new file (the line a user can open); a removed hit has no new-file line, so
// it is numbered in the old file from the `@@ -a,b` side, and `side` says
// which numbering applies.
test("in diff mode removed and context lines are scanned too, a removed hit numbered in the old file", () => {
  const diff = [
    "diff --git a/x b/x",
    "index aaa..bbb 100644",
    "--- a/x",
    "+++ b/x",
    "@@ -10,3 +20,3 @@",
    ` const same = 1;`,
    `-const old = "${AWS}";`,
    ` const ctx = "${GH}";`,
    `+const added = "${GOOGLE}";`
  ].join("\n");
  const { hits } = scanForSecrets(diff, { diff: true });
  assert.equal(hits.length, 3, JSON.stringify(hits));
  // Old file: line 10 is the first context line, 11 the removal, 12 the
  // second context line. New file: 20 context, 21 context, 22 the addition.
  assert.deepEqual(
    hits.map(({ kind, line, file, side }) => ({ kind, line, file, side })),
    [
      { kind: "aws-access-key-id", line: 11, file: "x", side: "removed" },
      { kind: "github-token", line: 21, file: "x", side: "context" },
      { kind: "google-api-key", line: 22, file: "x", side: "added" }
    ]
  );
});

// The commonest F76 case: the commit that deletes a file holding a key. The
// new side is /dev/null, so the hit must be named by the old path or it has
// no file at all.
test("a removed hit in a deleted file is named by the old path", () => {
  const diff = [
    "diff --git a/creds.txt b/creds.txt",
    "deleted file mode 100644",
    "index aaa..0000000",
    "--- a/creds.txt",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-# old credentials",
    `-AWS_ACCESS_KEY_ID=${AWS}`
  ].join("\n");
  const { hits } = scanForSecrets(diff, { diff: true });
  assert.equal(hits.length, 1, JSON.stringify(hits));
  assert.equal(hits[0].kind, "aws-access-key-id");
  assert.equal(hits[0].file, "creds.txt");
  assert.equal(hits[0].line, 2);
  assert.equal(hits[0].side, "removed");
});

// A removed content line whose own text starts with `--` (a CLI flag, an SQL
// comment) renders as `---...` inside a hunk. Past the header zone that is
// content, and excluding it would blind the scan on exactly the lines F76
// widened it to cover.
test("a ---shaped removed content line mid-hunk is still scanned", () => {
  const diff = [
    "diff --git a/run.sh b/run.sh",
    "index aaa..bbb 100644",
    "--- a/run.sh",
    "+++ b/run.sh",
    "@@ -3,2 +3,1 @@",
    " deploy \\",
    `--- --key ${AWS}`
  ].join("\n");
  const { hits } = scanForSecrets(diff, { diff: true });
  assert.equal(hits.length, 1, JSON.stringify(hits));
  assert.equal(hits[0].file, "run.sh");
  assert.equal(hits[0].line, 4);
  assert.equal(hits[0].side, "removed");
});

// A hit's location must be the line in the file a user can actually open,
// not an offset into the raw diff text (which counts `diff --git`, `index`
// and `@@` header lines, and resets to 0 for every file after the first).
test("a hit in the second file of a multi-file diff reports that file and a real line number", () => {
  const diff = [
    "diff --git a/one.txt b/one.txt",
    "index aaa..bbb 100644",
    "--- a/one.txt",
    "+++ b/one.txt",
    "@@ -1,2 +1,2 @@",
    " unchanged",
    "-old line",
    "+new line without a secret",
    "diff --git a/two.txt b/two.txt",
    "index ccc..ddd 100644",
    "--- a/two.txt",
    "+++ b/two.txt",
    "@@ -5,2 +5,3 @@",
    " context5",
    `+const key = "${AWS}";`,
    " context6"
  ].join("\n");
  const { hits } = scanForSecrets(diff, { diff: true });
  assert.equal(hits.length, 1, JSON.stringify(hits));
  assert.equal(hits[0].kind, "aws-access-key-id");
  assert.equal(hits[0].file, "two.txt");
  // The hunk opens at new-file line 5; one context line, then the added
  // line, so the added line is new-file line 6, not the raw offset (15) the
  // line sits at within the diff text above.
  assert.equal(hits[0].line, 6);
});

// A content line whose own text starts with two literal plus signs renders,
// once the diff's own leading `+` marker is added, as `+++ something`: the
// same three characters a real file header starts with. Round 1 of this fix
// treated any such line as a header by prefix alone, which reset the file
// and line tracking mid-hunk and misattributed every later hit in that hunk.
// This line must still be excluded from scanning (the existing, unchanged
// contract: a line starting with `+++` is never scanned), but it must not be
// mistaken for a header, and it must still advance the line count, since it
// occupies a real line in the new file.
test("a +++-shaped content line mid-hunk does not reset file or line tracking", () => {
  const diff = [
    "diff --git a/notes.txt b/notes.txt",
    "index aaa..bbb 100644",
    "--- a/notes.txt",
    "+++ b/notes.txt",
    "@@ -1,2 +1,4 @@",
    " line one",
    " line two",
    "+++ this looks like a header but is only added content",
    `+const leaked = "${AWS}";`
  ].join("\n");
  const { hits } = scanForSecrets(diff, { diff: true });
  assert.equal(hits.length, 1, JSON.stringify(hits));
  assert.equal(hits[0].kind, "aws-access-key-id");
  // Not reset to null/a bogus name: still the one real file in this diff.
  assert.equal(hits[0].file, "notes.txt");
  // New file line 1 and 2 are the two context lines; line 3 is the
  // +++-shaped content line (still counted, just not scanned); line 4 is
  // the secret. Not 1 (a reset newLine) and not the raw diff offset (9).
  assert.equal(hits[0].line, 4);
});

// `\ No newline at end of file` is a real line git emits mid-hunk whenever
// the OLD version of the file it follows lacked a trailing newline. It does
// not start with `-`, so it is not a removal, but it also does not occupy
// any line of the NEW file (it is a note about the line just shown, not a
// line itself) and must not advance the new-file line counter.
test("the no-newline-at-end-of-file marker does not advance the new-file line count", () => {
  const diff = [
    "diff --git a/notes.txt b/notes.txt",
    "index aaa..bbb 100644",
    "--- a/notes.txt",
    "+++ b/notes.txt",
    "@@ -1,2 +1,3 @@",
    " one",
    "-two",
    "\\ No newline at end of file",
    "+two",
    `+const leaked = "${AWS}";`
  ].join("\n");
  const { hits } = scanForSecrets(diff, { diff: true });
  assert.equal(hits.length, 1, JSON.stringify(hits));
  assert.equal(hits[0].file, "notes.txt");
  // New file: line 1 "one", line 2 "two", line 3 the secret. Not line 4,
  // which is what counting the marker line as a new-file line would give.
  assert.equal(hits[0].line, 3);
});

test("a non-diff scan still numbers lines within the text, with no file field at all", () => {
  const { hits } = scanForSecrets(`first\nsecond\nconst id = "${AWS}";\n`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 3);
  assert.ok(!("file" in hits[0]), "a non-diff hit must not carry a file key");
  assert.ok(!("side" in hits[0]), "a non-diff hit must not carry a side key");
});

test("a diff hit before any +++ header degrades to no file instead of throwing", () => {
  const diff = [`+const leaked = "${AWS}";`].join("\n");
  assert.doesNotThrow(() => scanForSecrets(diff, { diff: true }));
  const { hits } = scanForSecrets(diff, { diff: true });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "aws-access-key-id");
  assert.equal(hits[0].file, null);
  assert.equal(hits[0].side, "added");
});

test("a removed hit before any hunk header degrades to the raw offset and no file", () => {
  const diff = ["context", `-const leaked = "${AWS}";`].join("\n");
  const { hits } = scanForSecrets(diff, { diff: true });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
  assert.equal(hits[0].file, null);
  assert.equal(hits[0].side, "removed");
});

test("an allow pattern drops a hit whose line matches it", () => {
  const text = `fixture = "${AWS}"  # test fixture`;
  assert.equal(scanForSecrets(text).hits.length, 1);
  assert.deepEqual(scanForSecrets(text, { allow: ["test fixture$"] }).hits, []);
});

test("an invalid allow pattern is an error, not a silent pass", () => {
  assert.throws(() => scanForSecrets("x", { allow: ["("] }), /allow pattern/);
});

// F33. A syntactically valid pattern with a quantifier nested inside a
// quantified group compiles cleanly and then hangs on an ordinary long line
// (`(a+)+$` takes seconds on 26 characters). The input here is one character
// so an unguarded run fails fast instead of hanging the suite.
// `[^]*(a+)+$` is valid JavaScript (`[^]` is a complete class matching any
// character) and must not hide the nesting behind a class the walker reads
// the POSIX way, where a leading `]` would be literal.
const pathologicalAllow = ["(a+)+$", "(a*)*", "(a{1,5})+", "((ab)+)*", "(x+y)+", "^(\\d+)+$", "[^]*(a+)+$", "[]*(a+)+$"];

for (const source of pathologicalAllow) {
  test(`an allow pattern with nested quantifiers is refused: ${source}`, () => {
    assert.throws(() => scanForSecrets("x", { allow: [source] }), /allow pattern/);
  });
}

// Shapes that only look nested: a quantifier inside a character class, an
// escaped paren, a bounded outer quantifier, or quantifiers side by side.
const benignAllow = ["test fixture$", "[a+]+", "\\(a+\\)+", "(a+)?", "(abc)+", "a+b+", "(a{3})+", "(?:x|y)*z"];

for (const source of benignAllow) {
  test(`an allow pattern without nested quantifiers still compiles: ${source}`, () => {
    assert.doesNotThrow(() => scanForSecrets("x", { allow: [source] }));
  });
}

// The credential-url pattern has a scheme run and a userinfo run side by
// side; both are bounded or disjoint, so a line built to put a word boundary
// before every scheme character must still scan in linear time. Generous
// bound: the CI has a Windows leg.
test("a long adversarial line scans in bounded time", () => {
  const lines = [
    "a.".repeat(100000),
    "a-".repeat(100000),
    "a+".repeat(100000),
    "a:".repeat(100000),
    "http://" + "a:".repeat(100000),
    "http://" + "a".repeat(100000) + ":" + "b".repeat(100000)
  ];
  const started = process.hrtime.bigint();
  for (const line of lines) {
    scanForSecrets(line);
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 1000, `six adversarial lines took ${elapsedMs.toFixed(0)} ms`);
});

// The password in a URL is the whole point of the credential-url kind, so its
// sample must be the length alone, never a window of the value.
test("credential-url sample carries no characters of the password", () => {
  const { hits } = scanForSecrets(CRED_URL);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "credential-url");
  assert.equal(hits[0].sample, `(${URL_PASSWORD.length} chars)`);
  for (let i = 0; i + 6 <= URL_PASSWORD.length; i += 1) {
    assert.ok(!hits[0].sample.includes(URL_PASSWORD.slice(i, i + 6)), "sample leaks a window of the password");
  }
});

// A secret-assignment or authorization-header match has no fixed, non-secret
// prefix ahead of the value: the whole capture is the secret. sample must
// therefore report the length alone, never any of the value's characters.
test("secret-assignment sample carries no characters of the secret", () => {
  const secretValue = "q".repeat(10) + "z".repeat(10) + "9".repeat(4);
  const { hits } = scanForSecrets(`DATABASE_PASSWORD=${secretValue}`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "secret-assignment");
  assert.equal(hits[0].sample, `(${secretValue.length} chars)`);
  for (let i = 0; i + 6 <= secretValue.length; i += 1) {
    assert.ok(
      !hits[0].sample.includes(secretValue.slice(i, i + 6)),
      "sample leaks a window of the value"
    );
  }
});

test("authorization-header sample carries no characters of the token", () => {
  const token = "m".repeat(12) + "5".repeat(12) + "k".repeat(12);
  const { hits } = scanForSecrets(`Authorization: Bearer ${token}`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "authorization-header");
  assert.equal(hits[0].sample, `(${token.length} chars)`);
  for (let i = 0; i + 6 <= token.length; i += 1) {
    assert.ok(!hits[0].sample.includes(token.slice(i, i + 6)), "sample leaks a window of the token");
  }
});

// An environment-variable lookup is how a repository avoids putting a secret
// in the text at all, so it must never be treated as one, regardless of
// which language's accessor shape it uses or whether the name is quoted.
const envReferenceLines = [
  "API_KEY=process.env.STRIPE_KEY_NAME",
  'API_TOKEN=process.env["STRIPE_KEY_NAME_LONG_ENOUGH"]',
  'API_TOKEN=os.environ["FOO_TOKEN_NAME_LONG_ENOUGH"]',
  "API_TOKEN=os.environ[FOO_TOKEN_NAME_LONG_ENOUGH]",
  "API_TOKEN=os.getenv(FOO_TOKEN_NAME_LONG_ENOUGH)",
  'API_TOKEN=ENV["FOO_TOKEN_NAME_LONG_ENOUGH"]',
  "API_TOKEN=ENV[FOO_TOKEN_NAME_LONG_ENOUGH]",
  "API_TOKEN=$FOO_TOKEN_NAME_LONG_ENOUGH"
];

for (const line of envReferenceLines) {
  test(`scanForSecrets treats an environment lookup as a placeholder: ${line}`, () => {
    assert.deepEqual(scanForSecrets(line).hits, []);
  });
}

test("a real secret assigned under the same kind of identifier still hits", () => {
  const secretValue = "r".repeat(12) + "9".repeat(12);
  const { hits } = scanForSecrets(`API_TOKEN=${secretValue}`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "secret-assignment");
});

// A bare $NAME reference is excluded only when the whole value is the
// conventional shell-variable shape (upper case, digits, underscores). A
// mixed-case value that merely starts with $ is not a variable name by that
// convention, so it must still be treated as a secret.
test("a mixed-case value starting with $ still hits, it is not a bare variable name", () => {
  const mixedCaseSecret = "Secret" + "Api" + "Key" + "Abc" + "1234567890";
  const { hits } = scanForSecrets(`TOKEN=$${mixedCaseSecret}`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "secret-assignment");
});

test("a bare upper-case $NAME reference alone still produces no hit", () => {
  const varName = "STRIPE" + "_" + "KEY";
  assert.deepEqual(scanForSecrets(`API_KEY=$${varName}`).hits, []);
});

// F55. The cost of that narrowing, pinned so it stays a known one: a
// lower-case shell variable reference is not the conventional shape, so it
// is treated as a value and hits. Widening the branch would let a pure
// lower-case secret through, which is why the cost is accepted.
test("a lower-case $name reference hits, the accepted cost of the upper-case narrowing", () => {
  const varName = "my_stripe" + "_secret_key_name";
  const { hits } = scanForSecrets(`TOKEN=$${varName}`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "secret-assignment");
});

test("all seven non-bare-$ environment forms from round 1 still produce no hit", () => {
  for (const line of envReferenceLines.filter((line) => !line.includes("=$"))) {
    assert.deepEqual(scanForSecrets(line).hits, [], line);
  }
});

// A value that merely starts like an env lookup, then runs straight into
// secret-shaped material with no separator, must not be swallowed by a
// prefix match: anchoring ENV_REFERENCE at the end is what catches this.
test("a secret concatenated onto process.env with no separator still hits", () => {
  const secretTail = "Zz9x8" + "Y7wV6" + "uT5s4" + "R3qP2";
  const { hits } = scanForSecrets(`API_KEY=process.env${secretTail}`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "secret-assignment");
});

// Deferred observation from round 2 review: a quoted lookup such as
// os.environ["NAME"] is excluded only because its truncated capture never
// reaches the 16-character minimum, not because ENV_REFERENCE recognizes it.
// Anchoring both ends did not change this: the value never reaches
// ENV_REFERENCE at all. Covered explicitly here so the behavior stays
// intentional rather than incidental-and-untested.
test("a quoted env lookup still produces no hit, via the length minimum rather than ENV_REFERENCE", () => {
  const varName = "FOO" + "_" + "TOKEN" + "_" + "NAME_LONG_ENOUGH";
  assert.deepEqual(scanForSecrets(`API_TOKEN=os.environ["${varName}"]`).hits, []);
});
