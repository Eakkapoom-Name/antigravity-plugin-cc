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

// F41. Task 3 added --allow-secret and isolated-review behavior to the review
// and adversarial-review command docs but never to the README, which still
// showed the old examples with no mention of either.
test("the README documents --allow-secret and review isolation", () => {
  const readme = read("README.md");
  const reviewIndex = readme.indexOf("### `/agy:review`");
  const adversarialIndex = readme.indexOf("### `/agy:adversarial-review`");
  const rescueIndex = readme.indexOf("### `/agy:rescue`");
  assert.ok(reviewIndex > -1 && adversarialIndex > reviewIndex && rescueIndex > adversarialIndex);
  const reviewSection = readme.slice(reviewIndex, adversarialIndex);
  const adversarialSection = readme.slice(adversarialIndex, rescueIndex);
  for (const section of [
    ["/agy:review", reviewSection],
    ["/agy:adversarial-review", adversarialSection]
  ]) {
    const [name, text] = section;
    assert.match(text, /--allow-secret/, `README's ${name} section does not document --allow-secret`);
    assert.match(text, /isolat/i, `README's ${name} section does not document review isolation`);
    assert.ok(
      !/reads the diff from a\s+temp directory/.test(text),
      `README's ${name} section says agy reads the diff from a temp directory; it gets the diff on stdin`
    );
  }
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

// F87. The Guards bullet claimed isolated commands "cannot write into the
// project", overstating what a cwd change guarantees. The review command docs
// and the companion's review comment carried the same claim.
test("SECURITY.md Guards section does not claim isolation blocks writes", () => {
  for (const file of [
    "SECURITY.md",
    "commands/review.md",
    "commands/adversarial-review.md",
    "scripts/agy-companion.mjs"
  ]) {
    assert.ok(
      !/cannot\s+write into the project|a review cannot\s+(?:\/\/\s*)?write/.test(read(file)),
      `${file} still claims isolated reviews cannot write into the project`
    );
  }
});

// F75. The Guards bullet generalized "read-only commands" to mean isolated,
// but /agy:quota is read-only and is not run from an isolated temp directory.
test("SECURITY.md Guards section does not overgeneralize which commands are isolated", () => {
  const security = read("SECURITY.md");
  const guardsIndex = security.indexOf("## Guards");
  assert.ok(guardsIndex > -1, "SECURITY.md has no Guards section");
  const guards = security.slice(guardsIndex);
  assert.ok(
    !/Read-only commands run agy in an isolated temp directory/.test(guards),
    "SECURITY.md Guards section still generalizes read-only commands as isolated"
  );
  assert.match(guards, /agy:quota/, "SECURITY.md Guards section does not name the /agy:quota counter-example");
});

// F86. The <done_state> definition gave a review example ("every hunk
// considered") that the Review row of "Which blocks, by task" does not list;
// the review templates carry no done_state block, so the example is dropped
// rather than adding done_state to the row.
test("agy-prompting's done_state definition carries no review example the review row omits", () => {
  const skill = read("skills/agy-prompting/SKILL.md");
  assert.ok(
    !/For a review: every hunk considered/.test(skill),
    "agy-prompting SKILL.md still gives done_state a review example the Review row omits"
  );
});


// Isolation is a working-directory change, not a sandbox: under agy's
// `always-proceed` toolPermission agy can read outside its temp directory by
// absolute path, so no doc may promise it never sees the project's files.
test("no doc claims an isolated run cannot see the project", () => {
  for (const file of [
    "README.md",
    "SECURITY.md",
    "commands/review.md",
    "commands/adversarial-review.md",
    "scripts/agy-companion.mjs"
  ]) {
    const text = read(file).replace(/\s*\/\/\s*/g, " ").replace(/\s+/g, " ");
    assert.ok(
      !/(?:never sees|does not see|cannot see) (?:your files|the project|your project)/i.test(text),
      `${file} still claims an isolated agy run cannot see the project`
    );
  }
  for (const file of ["README.md", "SECURITY.md", "commands/review.md", "commands/adversarial-review.md"]) {
    assert.match(read(file), /toolPermission/, `${file} does not say reach outside the temp directory depends on toolPermission`);
  }
});

// Every `side` a diff-mode hit can carry, and the shape refusal, must be
// named in the command docs that render them.
test("the review command docs explain every hit side and the diff-shape refusal", () => {
  for (const file of ["commands/review.md", "commands/adversarial-review.md"]) {
    const text = read(file);
    for (const needle of ["`removed`", "`hunk-header`", "`header`", "`unrecognized`", 'failure: "diff-shape"']) {
      assert.ok(text.includes(needle), `${file} does not explain ${needle}`);
    }
  }
});

// F118. `interpretPromptRun` returns `ok: false, failure: "agy-error",
// agyError, result` with no top-level `error`, so the generic "ok: false
// with an error" bullet never catches it, and a non-empty `result.response`
// needs to be labelled partial rather than presented as finished.
test("review, adversarial-review, research and search docs handle failure: agy-error", () => {
  for (const file of ["commands/review.md", "commands/adversarial-review.md", "commands/research.md", "commands/search.md"]) {
    const text = read(file);
    assert.ok(text.includes('failure: "agy-error"'), `${file} does not name failure: "agy-error"`);
    assert.match(text, /agyError/, `${file} does not tell the model to quote agyError`);
    assert.match(text, /partial/i, `${file} does not say a partial result.response must be labelled as such`);
  }
});

// F119. review.md and adversarial-review.md both carry the tagged block
// form; the skill's own table should say so for both, not just review.md.
test("agy-prompting says both review templates use the tagged blocks", () => {
  const skill = read("skills/agy-prompting/SKILL.md");
  assert.ok(
    !/still carries the contract\s+in prose/.test(skill),
    "agy-prompting SKILL.md still says adversarial-review.md is untagged"
  );
  const reviewRowIndex = skill.indexOf("Review: `task`, `output_contract`, `grounding_rules`");
  assert.ok(reviewRowIndex > -1, "agy-prompting SKILL.md has no Review row in its block table");
  const row = skill.slice(reviewRowIndex, skill.indexOf("\n", reviewRowIndex + 200));
  assert.match(row, /prompts\/review\.md/);
  assert.match(row, /prompts\/adversarial-review\.md/);
});

// F122. Six commands run agy without the isolated-temp-directory guard:
// quota, setup's readiness check, the stop-review gate, transfer, rescue and
// continue. All six must be named, not just the first three.
test("SECURITY.md Guards section names all six non-isolated runs", () => {
  const security = read("SECURITY.md");
  const guardsIndex = security.indexOf("## Guards");
  const guards = security.slice(guardsIndex);
  for (const name of ["agy:quota", "agy:setup", "stop-review gate", "agy:transfer", "agy:rescue", "agy:continue"]) {
    assert.ok(guards.includes(name), `SECURITY.md Guards section does not name ${name} among the non-isolated runs`);
  }
});

// F122. The transfer bullet under "What leaves your machine" said only that
// the brief itself leaves; it did not say agy then has the repository as its
// workspace and can read files the brief names.
test("SECURITY.md's transfer bullet says agy can read repository files the brief names", () => {
  const security = read("SECURITY.md");
  const transferIndex = security.indexOf("`/agy:transfer`: the handoff brief");
  assert.ok(transferIndex > -1, "SECURITY.md has no /agy:transfer bullet under What leaves your machine");
  const bullet = security.slice(transferIndex, security.indexOf("\n- ", transferIndex + 1));
  assert.match(bullet, /workspace/i);
  assert.match(bullet, /read files the brief names|files the brief names/i);
});

// The scan covers hunk-header text and non-content lines too, and a diff of
// unrecognized shape is refused; SECURITY.md must say so rather than claim
// only content lines are scanned.
test("SECURITY.md describes what the diff scan covers after the hunk-header and shape fixes", () => {
  const security = read("SECURITY.md").replace(/\s+/g, " ");
  assert.match(security, /hunk header/i);
  assert.match(security, /--no-color/);
  assert.match(security, /not recognized|unrecognized shape|shape it does not recognize/i);
});
