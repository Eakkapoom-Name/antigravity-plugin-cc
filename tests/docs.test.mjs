import test from "node:test";
import assert from "node:assert/strict";

import { listMarkdown, parseFrontmatter, read } from "./helpers.mjs";

// Claude Code's own guidance writes the bang form with a space. The repository
// used both spellings, which reads like two different commands.
test("the bang-prefixed agy invocation is spelled the same everywhere", () => {
  for (const file of ["README.md", "commands/setup.md", "scripts/agy-setup.mjs"]) {
    const source = read(file);
    // Not followed by a dot or word character, so JavaScript's `!agy.available`
    // is not mistaken for the bang-prefixed prompt form.
    assert.ok(
      !/!agy(?![.\w])/.test(source),
      `${file} writes the unspaced !agy; the repository uses \`! agy\``
    );
  }
});

// A contract that keeps asserting a version nobody has run is the risk, not a
// known wrong claim. This does not check that 1.2.2 is current, only that the
// claims agree with each other.
test("the agy version claims do not drift apart", () => {
  const files = ["skills/agy-cli-runtime/SKILL.md", "commands/quota.md"];
  const versions = new Set();
  for (const file of files) {
    for (const match of read(file).matchAll(/verified (?:on|against) agy (\d+\.\d+\.\d+)/g)) {
      versions.add(match[1]);
    }
  }
  assert.ok(versions.size > 0, "no verified-against-agy claims found at all");
  assert.equal(
    versions.size,
    1,
    `the runtime contracts claim more than one agy version: ${[...versions].join(", ")}`
  );
});

// The README documented `/agy:transfer --model <model>` while the command had
// quietly dropped it. A documented flag has to survive in the argument hint.
test("the README does not document flags the commands no longer accept", () => {
  const readme = read("README.md");
  const transferExample = readme.match(/\/agy:transfer --(\w+)/g) ?? [];
  const hint = parseFrontmatter(read("commands/transfer.md"))["argument-hint"];
  for (const example of transferExample) {
    const flag = example.split("--")[1];
    assert.ok(
      hint.includes(`--${flag}`),
      `README shows /agy:transfer --${flag} but the command's argument-hint does not accept it`
    );
  }
});

// Issue #21: the README told users about `permissions.allow` rules and pointed
// at /agy:setup for the fix, and both only ever spelled out `command(...)`.
test("the README names the read rule and the manual settings step", () => {
  const readme = read("README.md");
  assert.match(readme, /read_file\(\*\)/);
  assert.match(readme, /by hand/);
});

test("the README does not promise the interactive sign-in hint works without a TTY", () => {
  const readme = read("README.md");
  assert.match(readme, /TTY/);
});

// The 1.1.20 denial text was finally reproduced on 1.2.4, so the hedge that
// said it had not been re-checked has to go, or the doc lies the other way.
test("the denial text claim no longer says it is unverified", () => {
  const source = read("skills/agy-result-handling/SKILL.md");
  assert.ok(
    !/not re-checked since/.test(source),
    "result handling still says the denial text was not re-checked"
  );
});

// F22. The README tells users the plugin picks up their agy settings, so it has
// to say which setting decides whether delegation works at all.
test("the README documents the agy tool permission modes", () => {
  const readme = read("README.md");
  for (const mode of ["always-proceed", "request-review", "proceed-in-sandbox", "strict"]) {
    assert.ok(readme.includes(mode), `README does not name the ${mode} mode`);
  }
});

test("the README states the risk of always-proceed rather than just naming it", () => {
  const readme = read("README.md");
  assert.match(readme, /outside the workspace/i);
  assert.match(readme, /no sandbox|unsandboxed/i);
});

test("the README warns proceed-in-sandbox is not usable with this plugin", () => {
  const readme = read("README.md");
  const index = readme.indexOf("proceed-in-sandbox");
  assert.ok(index > -1);
  assert.match(readme.slice(index, index + 400), /--sandbox/);
});

// F24. The mode table said reads are refused under the default. They were not,
// in three live runs of the denial harness.
test("the README mode table does not claim the default mode refuses reads", () => {
  const readme = read("README.md");
  const row = readme.split("\n").find((line) => line.startsWith("| `request-review` |"));
  assert.ok(row, "no request-review row in the README mode table");
  assert.ok(!/Reads and commands are refused/i.test(row), `stale row: ${row}`);
  assert.match(row, /inside the workspace was allowed/i);
});

// A new command file with no matching README section leaves users unable to
// discover it. The heading convention is a backticked command name, matching
// every existing `### /agy:<name>` section in this file.
test("every command has a matching README usage section", () => {
  const readme = read("README.md");
  for (const file of listMarkdown("commands")) {
    const name = file.replace(/\.md$/, "");
    assert.match(
      readme,
      new RegExp(`^### \`/agy:${name}\`$`, "m"),
      `README has no ### \`/agy:${name}\` section for commands/${file}`
    );
  }
});

test("SECURITY.md says what leaves the machine and how to report", () => {
  const security = read("SECURITY.md");
  for (const phrase of ["diff", "transfer brief", "secret scan", "isolated", "report"]) {
    assert.ok(security.toLowerCase().includes(phrase), `SECURITY.md does not mention ${phrase}`);
  }
});

test("CONTRIBUTING.md states the test and commit rules", () => {
  const contributing = read("CONTRIBUTING.md");
  assert.match(contributing, /npm test/);
  assert.match(contributing, /Conventional Commits/);
  assert.match(contributing, /docs: release/);
  assert.match(contributing, /test:denials/);
});
