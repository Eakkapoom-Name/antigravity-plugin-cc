#!/usr/bin/env node

// The live half of the review-quality bench (F32). Opt-in: it spawns agy once
// per cassette and spends real quota, so it is deliberately outside the
// `npm test` discovery patterns and has its own script, `npm run bench:review`.
//
// What it does, per cassette in `tests/live/review-bench/cassettes/`:
//   1. builds a scratch git repo, commits the cassette's `before/` tree;
//   2. overwrites it with the cassette's `after/` tree, unstaged, so
//      `git diff HEAD` (the working-tree scope `/agy:review` uses when given
//      no scope argument) shows exactly the cassette's change;
//   3. runs `node scripts/agy-companion.mjs review` (or `adversarial-review`
//      with `--adversarial`) with cwd the scratch repo;
//   4. scores the JSON response against the cassette's markers.
//
// Same shape as `run-denial-matrix.mjs`: pure logic lives in
// `scripts/lib/review-bench.mjs`, checked by `npm test` via
// `tests/review-bench.test.mjs`; this file only spawns.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { DEFAULT_SPAWN_TIMEOUT_MS, SPAWN_TIMEOUT_MARGIN_MS } from "../../scripts/lib/agy.mjs";
import { buildCassetteRepo, evaluateReview, loadCassettes } from "../../scripts/lib/review-bench.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CASSETTES_DIR = path.join(REPO_ROOT, "tests", "live", "review-bench", "cassettes");
const COMPANION = path.join(REPO_ROOT, "scripts", "agy-companion.mjs");

// A review runs agy with the default print timeout (`DEFAULT_PRINT_TIMEOUT`
// in `scripts/lib/agy.mjs`), and `runPromptWithDenialRecovery` may spawn it
// twice: once for the review, once more to resume after a tool denial. Each
// spawn can take up to `DEFAULT_SPAWN_TIMEOUT_MS`, so the companion gets two
// of those plus one more margin before this runner kills it; a shorter limit
// would score a slow but recovered review as ERROR.
const RUN_TIMEOUT_MS = 2 * DEFAULT_SPAWN_TIMEOUT_MS + SPAWN_TIMEOUT_MARGIN_MS;

// The scratch repo of the cassette in flight, so an interrupt can remove it.
let currentDir = null;

function removeCurrentDir() {
  if (currentDir) {
    fs.rmSync(currentDir, { recursive: true, force: true });
    currentDir = null;
  }
}

// Ctrl-C reaches the companion and agy too (same process group), so the
// spawn below returns with signal SIGINT; that is rethrown as an interrupt
// rather than scored ERROR, and the loop stops. This handler covers the
// signal once the event loop runs again, so node does not exit before the
// scratch dir is gone.
process.on("SIGINT", () => {
  removeCurrentDir();
  process.exit(130);
});

function interrupted() {
  const error = new Error("interrupted");
  error.interrupted = true;
  return error;
}

function parseArgs(argv) {
  let only = null;
  let adversarial = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--only") {
      const value = argv[i + 1];
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw new Error("--only needs a cassette id");
      }
      i += 1;
      only = value;
    } else if (arg === "--adversarial") {
      adversarial = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { only, adversarial };
}

function runCompanion(dir, adversarial) {
  const subcommand = adversarial ? "adversarial-review" : "review";
  const result = spawnSync(process.execPath, [COMPANION, subcommand], {
    cwd: dir,
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
    // Explicit, not just an inherited cwd: `workspace()` in
    // `agy-companion.mjs` prefers `CLAUDE_PROJECT_DIR` over `process.cwd()`
    // when it is set, and this script may itself be run from inside a
    // session that already has it set to the plugin repo. GIT_* variables
    // are dropped for the same reason `buildCassetteRepo` drops them: a
    // caller-set GIT_DIR would point the companion's diff at another repo.
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))
      ),
      CLAUDE_PROJECT_DIR: dir
    }
  });
  if (result.signal === "SIGINT") {
    throw interrupted();
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    const reason = result.error?.code ? ` (${result.error.code})` : "";
    throw new Error(
      `companion produced no JSON (status ${result.status}${reason}): ${result.stderr || result.stdout}`
    );
  }
}

function runCassette(cassette, adversarial) {
  // `dir` is built inside the try, not before it: a mkdtemp or git failure
  // building the scratch repo should score that one cassette ERROR, the same
  // as a companion failure, not abort every remaining cassette.
  let dir;
  try {
    dir = buildCassetteRepo(cassette);
    currentDir = dir;
    const payload = runCompanion(dir, adversarial);
    return evaluateReview(cassette, payload);
  } catch (error) {
    if (error?.interrupted) {
      throw error;
    }
    return {
      id: cassette.id,
      verdict: "ERROR",
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    currentDir = null;
  }
}

function main(argv) {
  const { only, adversarial } = parseArgs(argv);
  const all = loadCassettes(CASSETTES_DIR);
  const selected = only ? all.filter((c) => c.id === only) : all;
  if (selected.length === 0) {
    throw new Error(`No cassette matched: ${only}. Known: ${all.map((c) => c.id).join(", ")}`);
  }

  const results = [];
  // Serial, like the denial harness: agy's quota buckets are shared, and
  // parallel runs would make a rate-limited cassette look like a miss.
  for (const cassette of selected) {
    process.stderr.write(`running ${cassette.id} (${adversarial ? "adversarial-review" : "review"}) ...\n`);
    results.push(runCassette(cassette, adversarial));
  }

  for (const result of results) {
    const suffix = result.verdict === "HIT" ? "" : ` -- ${result.detail}`;
    process.stdout.write(`${result.id}: ${result.verdict}${suffix}\n`);
  }
  const hits = results.filter((result) => result.verdict === "HIT").length;
  process.stdout.write(`total: ${hits}/${results.length} hit\n`);
  return results.every((result) => result.verdict === "HIT") ? 0 : 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error?.interrupted ? 130 : 1;
}
