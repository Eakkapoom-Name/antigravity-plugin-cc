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

test("an allow pattern drops a hit whose line matches it", () => {
  const text = `fixture = "${AWS}"  # test fixture`;
  assert.equal(scanForSecrets(text).hits.length, 1);
  assert.deepEqual(scanForSecrets(text, { allow: ["test fixture$"] }).hits, []);
});

test("an invalid allow pattern is an error, not a silent pass", () => {
  assert.throws(() => scanForSecrets("x", { allow: ["("] }), /allow pattern/);
});
