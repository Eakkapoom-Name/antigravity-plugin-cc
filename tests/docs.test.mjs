import test from "node:test";
import assert from "node:assert/strict";

import { read } from "./helpers.mjs";

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

// The one claim that could not be re-probed keeps its original version and says
// why, rather than inheriting a bump it did not earn.
test("an unverified version claim says it is unverified", () => {
  const source = read("skills/agy-result-handling/SKILL.md");
  assert.match(source, /agy 1\.1\.20; not re-checked since/);
});
