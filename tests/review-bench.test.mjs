import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  buildCassetteRepo,
  compileMarkers,
  diffAgainstHead,
  evaluateReview,
  loadCassette,
  loadCassettes,
  matchesAnyMarker,
  reviewText
} from "../scripts/lib/review-bench.mjs";
import { scanForSecrets } from "../scripts/lib/secrets.mjs";

const CASSETTES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "live",
  "review-bench",
  "cassettes"
);

// The offline half of the review-quality bench (F32): everything that does
// not need a real agy on PATH. `tests/live/run-review-bench.mjs` is the live
// half, spawning agy against the same cassettes this file only loads.
const scratchDirs = [];
after(() => {
  for (const dir of scratchDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const cassettes = loadCassettes(CASSETTES_DIR);

test("the review bench ships at least three cassettes", () => {
  assert.ok(cassettes.length >= 3, `expected at least 3 cassettes, got ${cassettes.length}`);
});

for (const cassette of cassettes) {
  test(`cassette ${cassette.id}: loads, applies cleanly, carries no secret, has markers`, () => {
    assert.ok(cassette.description.length > 0, "cassette carries no description");
    assert.ok(cassette.markers.length > 0, "cassette carries no markers");
    // Every marker must compile; a bad regex in cassette.json should fail
    // here, not silently never match during a live run.
    assert.doesNotThrow(() => compileMarkers(cassette.markers));

    const dir = buildCassetteRepo(cassette);
    scratchDirs.push(dir);

    const diff = diffAgainstHead(dir);
    assert.ok(diff.trim().length > 0, "the before/after change produced no diff");

    const scan = scanForSecrets(diff, { diff: true });
    assert.deepEqual(
      scan.hits,
      [],
      `cassette ${cassette.id}'s diff trips the secret scanner: ${JSON.stringify(scan.hits)}`
    );
  });
}

test("loadCassette refuses a cassette whose after/ adds a path before/ does not have", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-review-bench-fixture-"));
  scratchDirs.push(dir);
  fs.mkdirSync(path.join(dir, "before"), { recursive: true });
  fs.mkdirSync(path.join(dir, "after"), { recursive: true });
  fs.writeFileSync(path.join(dir, "before", "a.js"), "const a = 1;\n");
  fs.writeFileSync(path.join(dir, "after", "a.js"), "const a = 2;\n");
  fs.writeFileSync(path.join(dir, "after", "b.js"), "const b = 1;\n");
  fs.writeFileSync(path.join(dir, "cassette.json"), JSON.stringify({ description: "x", markers: ["x"] }));
  assert.throws(() => loadCassette(dir), /after\/ names a path before\/ does not have/);
});

test("matchesAnyMarker hits on text naming the defect and misses on unrelated text", () => {
  const markers = ["off[- ]by[- ]one", "out[- ]of[- ]bounds?"];
  assert.equal(matchesAnyMarker("This loop has an off-by-one error.", markers), true);
  assert.equal(matchesAnyMarker("Reads past the array with an OUT OF BOUNDS index.", markers), true);
  assert.equal(matchesAnyMarker("Looks fine, nicely named variables throughout.", markers), false);
});

test("matchesAnyMarker accepts a RegExp alongside a string pattern", () => {
  assert.equal(matchesAnyMarker("Missing AWAIT here", [/missing\s+await/i]), true);
  assert.equal(matchesAnyMarker("nothing to see", [/missing\s+await/i]), false);
});

test("reviewText returns a plain-review response verbatim", () => {
  const payload = { ok: true, result: { response: "Looks fine, no findings." } };
  assert.equal(reviewText(payload), "Looks fine, no findings.");
});

test("reviewText searches only the findings of a structured adversarial response", () => {
  const structured = {
    verdict: "needs-attention",
    summary: "The loop reads one past the end.",
    findings: [
      {
        severity: "high",
        title: "Off-by-one loop bound",
        body: "i <= values.length reads values[values.length].",
        file: "sum.js",
        line_start: 3,
        line_end: 3,
        confidence: 0.9,
        recommendation: "Use i < values.length."
      }
    ],
    next_steps: ["Fix the bound."]
  };
  const payload = { ok: true, result: { response: JSON.stringify(structured) } };
  const text = reviewText(payload);
  assert.match(text, /Off-by-one loop bound/);
  assert.match(text, /Use i < values\.length/);
  // The summary is left out: it can restate the change without calling it a
  // defect, so only findings are searched.
  assert.doesNotMatch(text, /reads one past the end/);
});

test("reviewText falls back to the raw string when the response is not valid JSON", () => {
  const payload = { ok: true, result: { response: "not json { at all" } };
  assert.equal(reviewText(payload), "not json { at all");
});

test("evaluateReview reports ERROR when the run was not scored", () => {
  const cassette = { id: "x", markers: ["anything"] };
  assert.equal(evaluateReview(cassette, { ok: false, error: "agy is not installed" }).verdict, "ERROR");
  assert.equal(evaluateReview(cassette, { ok: true, empty: true, note: "nothing" }).verdict, "ERROR");
  assert.equal(
    evaluateReview(cassette, { ok: false, failure: "secrets", hits: [{ kind: "x" }] }).verdict,
    "ERROR"
  );
});

test("evaluateReview reports HIT when a marker matches and MISS otherwise", () => {
  const cassette = { id: "off-by-one", markers: ["off[- ]by[- ]one"] };
  assert.equal(
    evaluateReview(cassette, { ok: true, result: { response: "This is an off-by-one bug." } }).verdict,
    "HIT"
  );
  assert.equal(
    evaluateReview(cassette, { ok: true, result: { response: "Looks fine to me." } }).verdict,
    "MISS"
  );
});

function cassetteById(id) {
  const found = cassettes.find((cassette) => cassette.id === id);
  assert.ok(found, `no cassette named ${id}`);
  return found;
}

// A review that only restates the change, and calls it fine, must not score
// as having found the defect; one that names the defect must.
const MARKER_CASES = [
  {
    id: "off-by-one",
    allClear: [
      "No issues found. The change updates the loop condition to `i <= values.length`; looks fine.",
      "No issues. The helper already handles undefined entries, so nothing to flag."
    ],
    defect: [
      "The loop runs one too many times: i <= values.length reads undefined and the sum becomes NaN.",
      "Off-by-one: the bound should be i < values.length."
    ]
  },
  {
    id: "missing-await",
    allClear: [
      "No issues. This change removes the await in handleRequest; loadUser returns a Promise as before."
    ],
    defect: ["loadUser is not awaited, so res.json receives a pending Promise instead of the user."]
  },
  {
    id: "path-traversal",
    allClear: ["No findings. The diff drops the path.basename call; no sanitization concerns."],
    defect: ["Path traversal: a filename like ../../etc/passwd reads an arbitrary file."]
  }
];

for (const { id, allClear, defect } of MARKER_CASES) {
  test(`cassette ${id}: an all-clear review MISSes and a defect-naming review HITs`, () => {
    const cassette = cassetteById(id);
    for (const text of allClear) {
      assert.equal(
        evaluateReview(cassette, { ok: true, result: { response: text } }).verdict,
        "MISS",
        `all-clear text matched a marker: ${text}`
      );
    }
    for (const text of defect) {
      assert.equal(
        evaluateReview(cassette, { ok: true, result: { response: text } }).verdict,
        "HIT",
        `defect-naming text matched no marker: ${text}`
      );
    }
  });
}

function structuredPayload(fields) {
  return {
    ok: true,
    result: {
      response: JSON.stringify({ summary: "Summary.", findings: [], next_steps: [], ...fields })
    }
  };
}

test("evaluateReview scores an approve with no findings as MISS, not ERROR", () => {
  const cassette = cassetteById("off-by-one");
  const outcome = evaluateReview(cassette, structuredPayload({ verdict: "approve" }));
  assert.equal(outcome.verdict, "MISS");
  assert.match(outcome.detail, /approve/);
});

test("evaluateReview ignores a structured summary that names the defect when findings are empty", () => {
  const cassette = cassetteById("off-by-one");
  const outcome = evaluateReview(
    cassette,
    structuredPayload({ verdict: "approve", summary: "An off-by-one here would be bad, but there is none." })
  );
  assert.equal(outcome.verdict, "MISS");
});

test("evaluateReview scores a structured finding that names the defect as HIT", () => {
  const cassette = cassetteById("off-by-one");
  const outcome = evaluateReview(
    cassette,
    structuredPayload({
      verdict: "needs-attention",
      findings: [
        {
          severity: "high",
          title: "Off-by-one loop bound",
          body: "The loop reads values[values.length].",
          file: "sum.js",
          line_start: 3,
          line_end: 3,
          confidence: 0.9,
          recommendation: "Use i < values.length."
        }
      ]
    })
  );
  assert.equal(outcome.verdict, "HIT");
});

test("evaluateReview searches JSON that is not schema-shaped as the raw string", () => {
  const cassette = cassetteById("off-by-one");
  const payload = { ok: true, result: { response: JSON.stringify({ note: "off-by-one in the loop" }) } };
  assert.equal(evaluateReview(cassette, payload).verdict, "HIT");
});

test("evaluateReview ERROR detail stringifies an object agyError", () => {
  const outcome = evaluateReview(
    { id: "x", markers: ["x"] },
    { ok: false, failure: "agy-error", agyError: { code: 429, message: "quota" } }
  );
  assert.equal(outcome.verdict, "ERROR");
  assert.match(outcome.detail, /failure: agy-error/);
  assert.match(outcome.detail, /"code":429/);
  assert.doesNotMatch(outcome.detail, /\[object Object\]/);
});

test("evaluateReview ERROR detail carries a timeout failure and the result error", () => {
  const outcome = evaluateReview(
    { id: "x", markers: ["x"] },
    { ok: false, failure: "timeout", result: { error: "agy timed out" } }
  );
  assert.equal(outcome.verdict, "ERROR");
  assert.match(outcome.detail, /agy timed out/);
  assert.match(outcome.detail, /failure: timeout/);
});

test("evaluateReview ERROR detail keeps the secret scanner branch", () => {
  const outcome = evaluateReview(
    { id: "x", markers: ["x"] },
    { ok: false, failure: "secrets", hits: [{ kind: "aws" }] }
  );
  assert.match(outcome.detail, /^blocked by the secret scanner: .*aws/);
});

test("buildCassetteRepo ignores a caller's GIT_DIR and GIT_INDEX_FILE", () => {
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
  process.env.GIT_DIR = path.join(os.tmpdir(), "agy-review-bench-no-such-git-dir");
  process.env.GIT_INDEX_FILE = path.join(os.tmpdir(), "agy-review-bench-no-such-index");
  let dir;
  try {
    dir = buildCassetteRepo(cassetteById("off-by-one"));
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
  scratchDirs.push(dir);
  assert.ok(fs.existsSync(path.join(dir, ".git")), "the scratch repo was not initialised in its own dir");
  assert.ok(diffAgainstHead(dir).trim().length > 0);
});
