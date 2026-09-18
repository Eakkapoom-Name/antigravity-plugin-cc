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

const positives = [
  ["aws-access-key-id", `const id = "${AWS}";`],
  ["github-token", `token: ${GH}`],
  ["github-token", `token: ${GH_PAT}`],
  ["slack-token", `SLACK_TOKEN=${SLACK}`],
  ["google-api-key", `key=${GOOGLE}`],
  ["authorization-header", `Authorization: ${BEARER}`],
  ["private-key-block", PEM],
  ["secret-assignment", ASSIGN]
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
  "AKIA is the prefix, not a key"
];

for (const line of negatives) {
  test(`scanForSecrets ignores ${line.slice(0, 30)}`, () => {
    assert.deepEqual(scanForSecrets(line).hits, []);
  });
}

test("in diff mode only added lines are scanned", () => {
  const diff = [
    "--- a/x",
    "+++ b/x",
    `-const old = "${AWS}";`,
    ` const ctx = "${GH}";`,
    `+const added = "${GOOGLE}";`
  ].join("\n");
  const { hits } = scanForSecrets(diff, { diff: true });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "google-api-key");
  assert.equal(hits[0].line, 5);
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

test("a non-diff scan still numbers lines within the text, with no file field at all", () => {
  const { hits } = scanForSecrets(`first\nsecond\nconst id = "${AWS}";\n`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 3);
  assert.ok(!("file" in hits[0]), "a non-diff hit must not carry a file key");
});

test("a diff hit before any +++ header degrades to no file instead of throwing", () => {
  const diff = [`+const leaked = "${AWS}";`].join("\n");
  assert.doesNotThrow(() => scanForSecrets(diff, { diff: true }));
  const { hits } = scanForSecrets(diff, { diff: true });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "aws-access-key-id");
  assert.equal(hits[0].file, null);
});

test("an allow pattern drops a hit whose line matches it", () => {
  const text = `fixture = "${AWS}"  # test fixture`;
  assert.equal(scanForSecrets(text).hits.length, 1);
  assert.deepEqual(scanForSecrets(text, { allow: ["test fixture$"] }).hits, []);
});

test("an invalid allow pattern is an error, not a silent pass", () => {
  assert.throws(() => scanForSecrets("x", { allow: ["("] }), /allow pattern/);
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
