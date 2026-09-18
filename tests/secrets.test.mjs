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
