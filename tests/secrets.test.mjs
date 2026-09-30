import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { SECRET_KINDS, scanForSecrets } from "../scripts/lib/secrets.mjs";

// F69. Every temp directory made here is removed once the file's tests are
// done, the way agy-lib.test.mjs and companion.test.mjs already clean up.
const scratchDirs = [];
after(() => {
  for (const dir of scratchDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Every fixture is assembled at runtime so this file never holds a key-shaped
// literal that GitHub push protection or a secret scanner would flag.
const AWS = "AKIA" + "IOSFODNN7EXAMPLE"; // AWS's own documented example id
const GH = "ghp_" + "x".repeat(36);
const GH_PAT = "github_pat_" + "A".repeat(22) + "_" + "b".repeat(30);
const SLACK = "xoxb-" + "1".repeat(12) + "-" + "a".repeat(24);
const GOOGLE = "AIza" + "S".repeat(35);
const BEARER = "Bearer " + "t".repeat(40);
const STRIPE = "sk_" + "live_" + "a".repeat(24);
const JWT = "eyJ" + "hbGciOiJIUzI1NiJ9" + "." + "eyJ" + "zdWIiOiIxMjM0NTY3ODkwIn0" + "." + "dBjftJeZ4CVP_mB92K27uhbUJU1p1r";
const PEM = "-----BEGIN " + "RSA PRIVATE KEY-----";
const ASSIGN = "DATABASE_PASSWORD=" + "p".repeat(24);
const REAL = "Zq8vK2mW" + "9xR4tY7b" + "N3cL5hJ1"; // 24 mixed characters, no placeholder shape
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
  // F123. Shapes the scanner used to miss.
  ["stripe-secret-key", `const key = "${STRIPE}";`],
  ["jwt", `const jwt = "${JWT}";`],
  ["secret-assignment", '"API_KEY": "abcdefghijklmnopqrstu"'],
  ["secret-assignment", "password: hunter2hunter2hunter2"],
  ["secret-assignment", 'PASSWORD="my secret pass phrase"'],
  ["secret-assignment", "api_key: abcdefghijklmnopqrstu"],
  // The old kind is kept for a bearer JWT: authorization-header comes first.
  ["authorization-header", `Authorization: Bearer ${JWT}`],
  // Every match on a line is tried, so a placeholder, env reference or code
  // value that comes first no longer hides a real secret after it.
  ["secret-assignment", `API_TOKEN="\${{ secrets.X }}" DB_PASSWORD=${REAL}`],
  ["secret-assignment", `token="\${{ secrets.GH_TOKEN }}" API_KEY=${REAL}`],
  ["secret-assignment", `password="your-password-here-please" SECRET_KEY=${REAL}`],
  ["secret-assignment", `token=xxxxxxxxxxxxxxxxxxxxxxxx API_KEY=${REAL}`],
  ["secret-assignment", `TOKEN="<paste your token here>" SECRET=${REAL}`],
  ["secret-assignment", `{"password": "\${{ secrets.X }}", "api_key": "${REAL}"}`],
  ["secret-assignment", `token = generate_token_for(user); API_KEY=${REAL}`],
  // Quotes let an assignment sit inside a placeholder, so the search resumes
  // inside a quoted value rather than after it.
  ["secret-assignment", `TOKEN="<paste API_KEY=${REAL} here>"`],
  // Only the lower-case name branch reads a call as code: an upper-case name
  // with one still hits, as it always has (the F35 class).
  ["secret-assignment", "API_TOKEN = generate_token_for(user)"],
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
  // F123. Ordinary code around the widened keyword forms.
  "const password = getPassword();",
  "password: ${{ secrets.X }}",
  'password: "${{ secrets.DB_PASSWORD }}"',
  'PASSWORD="${{ secrets.DB_PASSWORD }}"',
  "token: null",
  'const tokenType = "some_long_string_value";',
  "sk_live_short",
  "eyJ.a.b is not a token, and neither is eyJhbGciOiJIUzI1NiJ9 alone",
  "TOKEN=xxxxxxxxxxxxxxxxxxxx",
  // Under a lower-case name, an unquoted value that reads as code (a call, a
  // subscript, a member path, a snake_case identifier) is not a secret.
  "self.token = generate_token_for(user)",
  "password = self.keyring.get_password(url, username)",
  'access_token = response.json()["access_token"]',
  "token = getAccessToken(scope);",
  "client_secret=self.consumer.secret,",
  "token_host: auth.example.internal",
  "password = private_key_password",
  "tokens = [dialect.word_fmt % i for i in words]",
  // Prose placeholders in a quoted value.
  'PASSWORD="your password here"',
  'PASSWORD="change me please now"',
  'PASSWORD="xxxxxxxx xxxxxxxx"',
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

// F59. A hand-rolled diff with no `diff --git` line never opens a header
// zone, so its `---`/`+++` lines are never read as file headers; a hit still
// reports the line it landed on (the bare `@@` header outside a zone still
// sets line numbers), just with no file name. Unreachable through this
// plugin's own diff-mode caller, which always feeds real `git diff` output
// starting with `diff --git`; pinned so the gap stays a documented one.
test("a hand-rolled diff missing the diff --git line loses file attribution but keeps the line number", () => {
  const diff = ["--- a/run.sh", "+++ b/run.sh", "@@ -3,2 +3,1 @@", " deploy \\", `--- --key ${AWS}`].join("\n");
  const { hits } = scanForSecrets(diff, { diff: true });
  assert.equal(hits.length, 1, JSON.stringify(hits));
  assert.equal(hits[0].file, null);
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
// It must not be mistaken for a header, and it must still advance the line
// count, since it occupies a real line in the new file. It was once also
// excluded from scanning by prefix alone, which let a secret on an added line
// starting with `++` leave unscanned: a `+++` line is only a file header
// inside the header zone, so past it the line is content and is scanned.
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
  // +++-shaped content line; line 4 is the secret. Not 1 (a reset newLine)
  // and not the raw diff offset (9).
  assert.equal(hits[0].line, 4);
});

test("an added content line starting with ++ is scanned, not skipped as a header", () => {
  const diff = [
    "diff --git a/notes.txt b/notes.txt",
    "index aaa..bbb 100644",
    "--- a/notes.txt",
    "+++ b/notes.txt",
    "@@ -1,1 +1,2 @@",
    " line one",
    `+++ counter; key = "${AWS}";`
  ].join("\n");
  const { hits } = scanForSecrets(diff, { diff: true });
  assert.equal(hits.length, 1, JSON.stringify(hits));
  assert.equal(hits[0].kind, "aws-access-key-id");
  assert.equal(hits[0].file, "notes.txt");
  assert.equal(hits[0].line, 2);
  assert.equal(hits[0].side, "added");
});

// Git's funcname heuristic copies a nearby line of the file into the text
// after a hunk header's closing `@@`: in a `.env`, that is often the line
// holding the key. That text leaves on stdin with the rest of the diff, so it
// is scanned, and reported with side "hunk-header" at the hunk's old-file
// start line (both hunks below have equal old and new starts, so this fixture
// alone does not discriminate the two; see the real-git test below for that),
// in the file the hunk belongs to.
test("text after a hunk header's closing @@ is scanned, in and past the header zone", () => {
  const secretLine = "AWS_SECRET_ACCESS_KEY=" + "k".repeat(40);
  const diff = [
    "diff --git a/.env b/.env",
    "index aaa..bbb 100644",
    "--- a/.env",
    "+++ b/.env",
    `@@ -6,4 +6,4 @@ ${secretLine}`,
    " ",
    "-plain=1",
    "+plain=2",
    `@@ -20,2 +20,2 @@ ${GH}`,
    "-other=1",
    "+other=2"
  ].join("\n");
  const { hits } = scanForSecrets(diff, { diff: true });
  assert.deepEqual(
    hits.map(({ kind, line, file, side }) => ({ kind, line, file, side })),
    [
      { kind: "secret-assignment", line: 6, file: ".env", side: "hunk-header" },
      { kind: "github-token", line: 20, file: ".env", side: "hunk-header" }
    ]
  );
  assert.ok(!JSON.stringify(hits).includes("k".repeat(16)), "the value leaked into the report");
});

test("a hunk-header hit in a deleted file is named by the old path", () => {
  const diff = [
    "diff --git a/creds.txt b/creds.txt",
    "deleted file mode 100644",
    "index aaa..0000000",
    "--- a/creds.txt",
    "+++ /dev/null",
    `@@ -1,2 +0,0 @@ key ${AWS}`,
    "-one",
    "-two"
  ].join("\n");
  const { hits } = scanForSecrets(diff, { diff: true });
  assert.equal(hits.length, 1, JSON.stringify(hits));
  assert.equal(hits[0].file, "creds.txt");
  assert.equal(hits[0].side, "hunk-header");
});

// F117. A hunk-header hit is copied from the old file, so it belongs at the
// old-file start line, not the new-file one. A real repo where an earlier
// hunk deletes 15 lines makes the two starts differ: the funcname-copied key
// sits at old line 24 (its true, old-file location is well above that, but
// the hunk's own old start is the bound the docs promise) and new line 9.
test("a hunk-header hit whose old and new starts differ is reported at the old start", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-secrets-git-"));
  scratchDirs.push(dir);
  spawnSync("git", ["init", "-q", "."], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@e.x"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  const lines = [];
  for (let i = 1; i <= 15; i += 1) {
    lines.push(`filler${i}`);
  }
  lines.push(`AWS_SECRET_ACCESS_KEY=${"k".repeat(40)}`);
  for (let i = 0; i < 10; i += 1) {
    lines.push("");
  }
  lines.push("plain=1");
  lines.push("tail");
  fs.writeFileSync(path.join(dir, "a.txt"), `${lines.join("\n")}\n`);
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-qm", "base"], { cwd: dir });

  const updated = lines.slice(15).map((l) => (l === "plain=1" ? "plain=2" : l));
  fs.writeFileSync(path.join(dir, "a.txt"), `${updated.join("\n")}\n`);

  const result = spawnSync(
    "git",
    ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"],
    { cwd: dir, encoding: "utf8" }
  );
  const diff = result.stdout;
  const starts = [...diff.matchAll(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/gm)].map((m) => [
    Number(m[1]),
    Number(m[2])
  ]);
  // The fixture, not the scanner, is wrong if there is no hunk where the two
  // starts actually differ.
  const differing = starts.find(([oldStart, newStart]) => oldStart !== newStart && oldStart > 0);
  assert.ok(differing, `no hunk with differing, non-zero old/new starts: ${JSON.stringify(starts)}`);

  // The key line itself also survives as a context line in the first hunk
  // (it is not one of the 15 deleted lines), so it is caught there too; only
  // the hunk-header hit is this test's concern.
  const { hits } = scanForSecrets(diff, { diff: true });
  const hunkHeaderHits = hits.filter((hit) => hit.side === "hunk-header");
  assert.equal(hunkHeaderHits.length, 1, JSON.stringify(hits));
  assert.equal(hunkHeaderHits[0].file, "a.txt");
  assert.equal(
    hunkHeaderHits[0].line,
    differing[0],
    "the hit should be reported at the old-file start, not the new-file one"
  );
});

// A header-zone line that is none of the lines git emits there (a stray line
// a diff driver or a hand edit put in) is still text that leaves, so it is
// scanned, side "header", numbered by its offset into the raw diff.
test("an unrecognized header-zone line is scanned as a safety net", () => {
  const diff = [
    "diff --git a/x b/x",
    `stray ${AWS}`,
    "index aaa..bbb 100644",
    "--- a/x",
    "+++ b/x",
    "@@ -1 +1 @@",
    "-a",
    "+b"
  ].join("\n");
  const { hits } = scanForSecrets(diff, { diff: true });
  assert.equal(hits.length, 1, JSON.stringify(hits));
  assert.equal(hits[0].side, "header");
  assert.equal(hits[0].line, 2);
});

// The recognized header lines stay unscanned, and none of them trips a
// pattern: no false positive on an ordinary multi-file diff's headers.
test("ordinary git header lines produce no hit", () => {
  const diff = [
    "diff --git a/.env b/.env",
    "new file mode 100644",
    "index 0000000..e69de29",
    "--- /dev/null",
    "+++ b/.env",
    "@@ -0,0 +1 @@",
    "+PLAIN=1",
    "diff --git a/old_SECRET_TOKEN_name.txt b/new_SECRET_TOKEN_name.txt",
    "similarity index 90%",
    "rename from old_SECRET_TOKEN_name.txt",
    "rename to new_SECRET_TOKEN_name.txt",
    "index 1234567..89abcde 100644",
    "--- a/old_SECRET_TOKEN_name.txt",
    "+++ b/new_SECRET_TOKEN_name.txt",
    "@@ -1,3 +1,3 @@ function main() {",
    " a",
    "-b",
    "+c",
    "diff --git a/bin.dat b/bin.dat",
    "old mode 100644",
    "new mode 100755",
    "index 1111111..2222222",
    "Binary files a/bin.dat and b/bin.dat differ",
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "index 3333333..0000000",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
    "\\ No newline at end of file",
    ""
  ].join("\n");
  const result = scanForSecrets(diff, { diff: true });
  assert.deepEqual(result.hits, []);
  assert.equal(result.diffHeaders, 4);
  assert.equal(result.hunks, 3);
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

// F101. secret-assignment's leading `[A-Z0-9_]*` run was unbounded, so a line
// of nothing but repeated name characters (no real identifier runs this
// long) was retried from every split point within it and went quadratic:
// 152.9 ms at 40,000 characters, measured before the fix. The keyword check
// is now a lookahead followed by one `[A-Z0-9_]+` run, which keeps this fast
// at ten times that length without capping the name's length on either side
// of the keyword (see the shapes below, which are still fast).
test("a long line of repeated secret-shaped name characters scans in bounded time", () => {
  const line = "SECRET_".repeat(60000); // 420,000 characters, no "=" or ":" anywhere
  const started = process.hrtime.bigint();
  const { hits } = scanForSecrets(line);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 1000, `the repeated-name line took ${elapsedMs.toFixed(0)} ms`);
  assert.deepEqual(hits, []);
});

// Leaving the trailing run unbounded must still be fast on a shape that
// stresses IT specifically: a single keyword followed by a long run of name
// characters with nothing to stop the trailing run early and no "=" or ":"
// anywhere, so it backtracks all the way to zero exactly once. One `\b`
// position, so the scan stays linear here too.
test("a single keyword followed by a long unbroken run of name characters scans in bounded time", () => {
  const line = "SECRET" + "A".repeat(1000000);
  const started = process.hrtime.bigint();
  const { hits } = scanForSecrets(line);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 1000, `the single-run line took ${elapsedMs.toFixed(0)} ms`);
  assert.deepEqual(hits, []);
});

// The linear-time rewrite must not narrow what a real secret assignment
// still catches: the same shape as every other secret-assignment positive in
// this file, just with a longer run of name characters on both sides of the
// keyword than the shortest fixtures above use (a 26-character prefix before
// the keyword and an 81-character suffix after it).
test("a secret assignment with a long identifier on both sides of the keyword is still flagged", () => {
  const secret = "Zz9x8" + "Y7wV6" + "uT5s4" + "R3qP2";
  const longSuffix = "_AND_A_LONG_SUFFIX_AFTER_IT".repeat(3); // 81 characters after the keyword
  const line = `MY_LONG_PREFIX_BEFORE_THE_API_KEY${longSuffix} = "${secret}"`;
  const { hits } = scanForSecrets(line);
  assert.equal(hits.length, 1, JSON.stringify(hits));
  assert.equal(hits[0].kind, "secret-assignment");
});

// F101 review: an earlier fix capped the run before the keyword at 64
// characters, which stopped flagging a real assignment whose name ran longer
// than that before the keyword. The pattern before the fix flagged it, so the
// linear-time rewrite must too.
test("a secret assignment with more than 64 name characters before the keyword is still flagged", () => {
  const secret = "Zz9x8" + "Y7wV6" + "uT5s4" + "R3qP2";
  const line = `${"A".repeat(80)}SECRET=${secret}`;
  const { hits } = scanForSecrets(line);
  assert.equal(hits.length, 1, JSON.stringify(hits));
  assert.equal(hits[0].kind, "secret-assignment");
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

// F123. The keyword group is matched in all upper case or all lower case, never
// mixed, so `password:` in YAML is caught while `tokenType`/`secretName` (the
// F35 false positives) stay quiet. The cost of the lower-case form is the same
// F35 class as ever: a long value under a lower-case name is a hit.
test("a lower-case keyword with a long value hits, the accepted F35-class cost", () => {
  const { hits } = scanForSecrets("token_url: https://example.com/oauth/token");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "secret-assignment");
});

test("a quoted value with spaces reports its length and none of its characters", () => {
  const { hits } = scanForSecrets('PASSWORD="my secret pass phrase"');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sample, "(21 chars)");
});

// The new branches are all linear: a quote with no partner is one pass to the
// end of the line, and a lower-case name is one lookahead run per word, like
// the upper-case form in F101. Bound is generous for the Windows CI leg.
test("the F123 shapes scan long adversarial lines in bounded time", () => {
  const lines = [
    'PASSWORD="' + "a ".repeat(500000),
    'TOKEN="'.repeat(150000),
    "TOKEN='".repeat(150000) + 'TOKEN="'.repeat(150000),
    "a".repeat(1000000),
    "password" + "a".repeat(1000000),
    "secret_".repeat(150000),
    "password".repeat(100000) + ":",
    "eyJ-".repeat(250000),
    "eyJa.eyJa. ".repeat(100000),
    "eyJ" + "a".repeat(1000000),
    "sk_live_" + "!".repeat(1000000),
    "sk_test_".repeat(100000)
  ];
  const started = process.hrtime.bigint();
  for (const line of lines) {
    scanForSecrets(line);
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 2000, `the F123 adversarial lines took ${elapsedMs.toFixed(0)} ms`);
});

// F35. Pinned as a known limit, not a defect to fix: a string constant that
// merely mentions a keyword in its name is indistinguishable from a secret by
// shape. F37 and F56 below are the same kind of limit.
test("a string constant under a keyword name hits, the accepted F35 false positive", () => {
  const { hits } = scanForSecrets('const SESSION_TOKEN_HEADER = "X-Custom-Auth-Token-Value";');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "secret-assignment");
});

// F37. The `Authorization:` prefix is optional, so a bare `Bearer` followed by
// 20 or more token characters hits even in prose. The word is rare outside
// this context.
test("a bare Bearer followed by a token-shaped run in prose hits, the accepted F37 cost", () => {
  const { hits } = scanForSecrets("Send it as Bearer abcdefghijklmnopqrstuvwx in the header.");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "authorization-header");
});

// F56. The other side of F55's narrowing: a real secret that is pure upper
// case, digits and underscores right after a bare `$` has the shape of a shell
// variable, so it passes.
test("an upper-case secret right after a bare $ produces no hit, the accepted F56 limit", () => {
  assert.deepEqual(scanForSecrets("TOKEN=$ABCD1234EFGH5678IJKL").hits, []);
});

// F111. Git copies a line from the file into the hunk header after its closing
// `@@`. An allow pattern written for the content line (`^\+NAME=`) must clear
// that copy too, or a known fixture still blocks the run.
test("an allow pattern anchored on a diff marker also clears the hunk-header copy of the line", () => {
  const fixture = "FIXTURE_TOKEN=" + "f".repeat(24);
  const diff = [
    "diff --git a/.env b/.env",
    "index aaa..bbb 100644",
    "--- a/.env",
    "+++ b/.env",
    `@@ -3,2 +3,3 @@ ${fixture}`,
    " keep",
    `+${fixture}`,
    " keep2"
  ].join("\n");
  const sides = (allow) => scanForSecrets(diff, { diff: true, allow }).hits.map((hit) => hit.side);
  assert.deepEqual(sides([]), ["hunk-header", "added"]);
  assert.deepEqual(sides(["^\\+FIXTURE_TOKEN="]), []);
  assert.deepEqual(sides(["^[-+]FIXTURE_TOKEN="]), []);
  assert.deepEqual(sides(["FIXTURE_TOKEN="]), []);
  // Tried bare too: a pattern with no marker clears the copy, not the `+` line.
  assert.deepEqual(sides(["^FIXTURE_TOKEN="]), ["added"]);
});

// F112. Git quotes a path with special characters as a C-style string (octal
// byte escapes are UTF-8) with the a/ or b/ prefix inside the quotes, and pads
// an unquoted path holding a space with a trailing tab. A hit names the path a
// user would type.
function fileOfHit(oldHeader, newHeader, marker = "+") {
  const diff = [
    "diff --git a/x b/x",
    "index aaa..bbb 100644",
    oldHeader,
    newHeader,
    "@@ -1,1 +1,1 @@",
    `${marker}API_TOKEN=${"q".repeat(24)}`
  ].join("\n");
  const { hits } = scanForSecrets(diff, { diff: true });
  assert.equal(hits.length, 1, JSON.stringify(hits));
  return hits[0].file;
}

test("a path with a space loses the trailing tab git pads it with", () => {
  assert.equal(fileOfHit("--- a/my file.txt\t", "+++ b/my file.txt\t"), "my file.txt");
});

test("a quoted non-ASCII path is unquoted and its octal escapes decoded as UTF-8", () => {
  assert.equal(
    fileOfHit('--- "a/f\\303\\257l\\303\\251.txt"', '+++ "b/f\\303\\257l\\303\\251.txt"'),
    "fïlé.txt"
  );
});

test("a quoted path with a double quote or a backslash is decoded", () => {
  assert.equal(fileOfHit('--- "a/say \\"hi\\".txt"', '+++ "b/say \\"hi\\".txt"'), 'say "hi".txt');
  assert.equal(fileOfHit('--- "a/a\\\\b.txt"', '+++ "b/a\\\\b.txt"'), "a\\b.txt");
});

test("a removed hit in a deleted file with a quoted path is named by the decoded old path", () => {
  assert.equal(fileOfHit('--- "a/f\\303\\257.txt"', "+++ /dev/null", "-"), "fï.txt");
});

// F114. `git diff` in an unresolved merge writes combined sections: `diff --cc`
// (or `diff --combined` for -c), a `@@@ -a,b -c,d +e,f @@@` hunk header, and
// one marker column per parent. This is the real output for a two-parent
// conflict in a file with a space in its name, with secrets planted in it.
function combinedDiff(header) {
  return [
    header,
    "index 62cf973,44130da..0000000",
    "--- a/my f.txt",
    "+++ b/my f.txt",
    "@@@ -1,6 -1,6 +1,10 @@@",
    "  one",
    "  two",
    "++<<<<<<< HEAD",
    ` +API_TOKEN=${"o".repeat(24)}`,
    "++=======",
    `+ API_TOKEN=${"t".repeat(24)}`,
    "++>>>>>>> side",
    `  API_KEY=${"c".repeat(24)}`,
    "  five",
    ` -PASSWORD=${"r".repeat(24)}`,
    " +sixty"
  ].join("\n");
}

for (const header of ["diff --cc my f.txt", "diff --combined my f.txt"]) {
  test(`a ${header.split(" ")[1]} section opens a header zone and numbers hits on the new side`, () => {
    const result = scanForSecrets(combinedDiff(header), { diff: true });
    assert.equal(result.diffHeaders, 1);
    assert.equal(result.hunks, 1);
    assert.deepEqual(
      result.hits.map(({ line, file, side }) => ({ line, file, side })),
      [
        { line: 4, file: "my f.txt", side: "added" },
        { line: 6, file: "my f.txt", side: "added" },
        { line: 8, file: "my f.txt", side: "context" },
        { line: 10, file: "my f.txt", side: "removed" }
      ]
    );
  });
}

test("a combined section followed by a regular one resets file and line tracking", () => {
  const diff = [
    combinedDiff("diff --cc my f.txt"),
    "diff --git a/other.txt b/other.txt",
    "index aaa..bbb 100644",
    "--- a/other.txt",
    "+++ b/other.txt",
    "@@ -1,1 +1,2 @@",
    " keep",
    `+SECRET_VALUE=${"z".repeat(24)}`
  ].join("\n");
  const result = scanForSecrets(diff, { diff: true });
  assert.equal(result.diffHeaders, 2);
  assert.equal(result.hunks, 2);
  assert.deepEqual(
    result.hits.at(-1),
    { line: 2, kind: "secret-assignment", sample: "(24 chars)", file: "other.txt", side: "added" }
  );
});

// Trying every match on a line must not rescan: an unquoted value is skipped
// whole, and a quoted one is reentered once. Chains of excluded values, and
// code-shaped values built to make the CODE_VALUE check backtrack, stay linear.
test("every-match iteration and the code-value check scan long adversarial lines in bounded time", () => {
  const lines = [
    "TOKEN=${TOKEN=".repeat(70000) + "}",
    "TOKEN=\"<a TOKEN='<b> ".repeat(45000),
    "token=a.b(".repeat(100000),
    '{"password": "${{ secrets.X }}", '.repeat(30000),
    "token=" + "a.".repeat(500000) + "!",
    "token=[" + "a.".repeat(500000) + "!",
    "token=" + "a_".repeat(500000) + "!",
    "token=" + "A_".repeat(500000) + "!",
    'PASSWORD="' + "x ".repeat(500000) + 'y"',
    'PASSWORD="your ' + "a ".repeat(500000) + '="'
  ];
  const started = process.hrtime.bigint();
  for (const line of lines) {
    scanForSecrets(line);
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 2000, `the every-match adversarial lines took ${elapsedMs.toFixed(0)} ms`);
});

// An open `{n,}` run or an uncapped repeated group pushed one V8 backtrack
// entry per character or per repeat, and a 16 MB line of either overflowed the
// stack and threw instead of scanning. The per-parent header repeats are now
// capped and every length floor is `X{n}X*`.
test("16 MB header-zone lines and value runs scan without throwing", () => {
  const size = 16 * 1024 * 1024;
  const run = "a".repeat(size);
  const headerLines = [
    "@@@ -1" + " -1".repeat(size / 3) + " +1 @@@",
    "index a" + ",a".repeat(size / 2) + "..b",
    "mode 1" + ",1".repeat(size / 2) + "..1"
  ];
  for (const line of headerLines) {
    const diff = ["diff --cc f", line, "@@@ -1,1 -1,1 +1,1 @@@", "  x"].join("\n");
    assert.doesNotThrow(() => scanForSecrets(diff, { diff: true }));
  }
  const valueLines = [
    "github_pat_" + run,
    "xoxb-" + run,
    "sk_live_" + run,
    "Bearer " + run,
    'TOKEN="' + run,
    "TOKEN=" + run,
    "token=" + run + "("
  ];
  for (const line of valueLines) {
    assert.doesNotThrow(() => scanForSecrets(line));
  }
});

// F111, the other direction. A marker-anchored allow pattern clears a trailer
// only when the trailer is a copy of a content line some allow pattern cleared;
// it does not clear a different line just because git copied it into a hunk
// header with no marker.
function trailerDiff(firstHunk, trailer) {
  return [
    "diff --git a/.env b/.env",
    "index aaa..bbb 100644",
    "--- a/.env",
    "+++ b/.env",
    "@@ -2,2 +2,2 @@",
    " keep",
    ...firstHunk,
    `@@ -9,2 +9,2 @@ ${trailer}`,
    "-old",
    "+new"
  ].join("\n");
}

test("an allow pattern for a removed key does not clear a live key copied into a hunk header", () => {
  const revoked = "API_KEY=" + "r".repeat(24);
  const live = `API_KEY=${REAL}`;
  const { hits } = scanForSecrets(trailerDiff([`-${revoked}`, "+API_KEY=${API_KEY}"], live), {
    diff: true,
    allow: ["^-API_KEY"]
  });
  assert.deepEqual(hits.map((hit) => hit.side), ["hunk-header"]);
});

test("an allow pattern for an added fixture does not clear a different old value in a hunk header", () => {
  const fixture = "FIXTURE_TOKEN=" + "f".repeat(24);
  const old = `FIXTURE_TOKEN=${REAL}`;
  const { hits } = scanForSecrets(trailerDiff([`+${fixture}`], old), {
    diff: true,
    allow: ["^\\+FIXTURE_TOKEN="]
  });
  assert.deepEqual(hits.map((hit) => hit.side), ["hunk-header"]);
});

test("an allow pattern for an added fixture clears its copy in a later hunk header", () => {
  const fixture = "FIXTURE_TOKEN=" + "f".repeat(24);
  const diff = trailerDiff([`+${fixture}`], fixture);
  assert.deepEqual(scanForSecrets(diff, { diff: true }).hits.map((hit) => hit.side), ["added", "hunk-header"]);
  assert.deepEqual(scanForSecrets(diff, { diff: true, allow: ["^\\+FIXTURE_TOKEN="] }).hits, []);
});

// Git copies at most 80 bytes of the line into the header, trailing
// whitespace trimmed (checked against git 2.x output), so a longer fixture's
// copy is its first 80 bytes.
test("an allow pattern clears the 80-byte copy git makes of a long fixture line", () => {
  const fixture = "FIXTURE_TOKEN_WITH_A_LONG_NAME=" + "f".repeat(100);
  const diff = trailerDiff([`+${fixture}`], fixture.slice(0, 80));
  assert.deepEqual(scanForSecrets(diff, { diff: true }).hits.map((hit) => hit.side), ["added", "hunk-header"]);
  assert.deepEqual(scanForSecrets(diff, { diff: true, allow: ["^\\+FIXTURE_TOKEN"] }).hits, []);
});

// F123 narrowing, pinned as known limits. A secret shaped like code under a
// lower-case name passes, and quoted prose under a name that merely contains
// a keyword still hits.
test("a dotted or snake_case value under a lower-case name produces no hit, the accepted cost of the code rule", () => {
  assert.deepEqual(scanForSecrets("password: my.pass.word.1234").hits, []);
  assert.deepEqual(scanForSecrets("api_key: abc_def_ghi_jkl_mno").hits, []);
});

test("quoted prose under a lower-case keyword name hits, the accepted F35-class cost", () => {
  const { hits } = scanForSecrets('password_label: "Please enter your password"');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "secret-assignment");
});
