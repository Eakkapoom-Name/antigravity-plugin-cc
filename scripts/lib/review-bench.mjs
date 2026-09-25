// The cassettes behind the review-quality bench (F32).
//
// Each cassette lives under `tests/live/review-bench/cassettes/<id>/` as a
// `cassette.json` (`{ description, markers }`) plus a `before/` and an
// `after/` file tree: the same small set of relative paths, `before/` the
// base commit, `after/` the same paths changed in place. `git diff HEAD`
// against a repo seeded from `before/` then overwritten with `after/` is the
// diff a real `/agy:review` run would see, so `after/` may never name a path
// `before/` does not already have; a genuinely new file would be untracked,
// invisible to `git diff HEAD`, and reported as "nothing to review" rather
// than as the diff this bench means to score.
//
// Nothing here spawns agy: that stays in the two callers,
// `tests/live/run-review-bench.mjs` (spawns agy, costs quota) and
// `tests/review-bench.test.mjs` (checked by `npm test`, no agy). Building and
// diffing the scratch repo does spawn git, shared by both callers so they
// build and diff a cassette's repo exactly the same way. The split mirrors
// `denial-matrix.mjs` and `run-denial-matrix.mjs`.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { collectDiff } from "./git.mjs";

function listFiles(root) {
  const out = [];
  const walk = (base, relative) => {
    for (const name of fs.readdirSync(base)) {
      const abs = path.join(base, name);
      const rel = relative ? path.join(relative, name) : name;
      if (fs.statSync(abs).isDirectory()) {
        walk(abs, rel);
      } else {
        out.push(rel);
      }
    }
  };
  walk(root, "");
  return out;
}

function readFileTree(root) {
  const files = {};
  for (const rel of listFiles(root)) {
    files[rel] = fs.readFileSync(path.join(root, rel), "utf8");
  }
  return files;
}

export function loadCassette(dir) {
  const id = path.basename(dir);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "cassette.json"), "utf8"));
  const before = readFileTree(path.join(dir, "before"));
  const after = readFileTree(path.join(dir, "after"));
  const addedPaths = Object.keys(after).filter((rel) => !(rel in before));
  if (addedPaths.length > 0) {
    throw new Error(
      `cassette ${id}: after/ names a path before/ does not have (${addedPaths.join(", ")}); git diff HEAD never sees an untracked addition`
    );
  }
  if (Object.keys(before).length === 0) {
    throw new Error(`cassette ${id}: before/ is empty`);
  }
  return {
    id,
    description: String(meta.description ?? ""),
    markers: Array.isArray(meta.markers) ? meta.markers : [],
    before,
    after
  };
}

export function loadCassettes(root) {
  return fs
    .readdirSync(root)
    .filter((name) => fs.statSync(path.join(root, name)).isDirectory())
    .sort()
    .map((name) => loadCassette(path.join(root, name)));
}

export function writeFileTree(dir, files) {
  for (const [rel, contents] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
}

// Same shape `collectDiff`'s empty-scope branch builds (`git diff HEAD`
// against the working tree), so a cassette's diff is exactly what a real
// `/agy:review` run with no scope argument would send to agy.
export function buildCassetteRepo(cassette, { prefix = "agy-review-bench-" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    // GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE and the rest would point these
    // spawns at some other repository (a hook or a worktree session can set
    // them), so none of the caller's GIT_* variables reach them.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))
    );
    const git = (...args) => {
      const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", env });
      if (result.error || result.status !== 0) {
        const reason = result.error ? result.error.message : String(result.stderr ?? "").trim();
        throw new Error(`git ${args.join(" ")} failed in ${dir} (status ${result.status}): ${reason}`);
      }
      return result;
    };
    git("init", "--quiet");
    writeFileTree(dir, cassette.before);
    git("add", "-A");
    git(
      "-c",
      "user.email=review-bench@example.com",
      "-c",
      "user.name=review-bench",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "base"
    );
    writeFileTree(dir, cassette.after);
    return dir;
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

// Delegates to the same `collectDiff` a real `/agy:review` run calls with no
// scope argument, so a future change to the default scope's resolution
// surfaces here too, rather than this bench keeping its own frozen copy of
// `git diff HEAD`.
export function diffAgainstHead(dir) {
  const collected = collectDiff("", dir);
  if (!collected.ok) {
    throw new Error(`git diff failed in ${dir}: ${collected.error}`);
  }
  return collected.diff;
}

export function compileMarkers(markers) {
  return markers.map((marker) => (marker instanceof RegExp ? marker : new RegExp(marker, "i")));
}

// A cassette's markers are alternative phrasings of the same defect, not a
// checklist a review must clear in full: any one matching is a hit.
export function matchesAnyMarker(text, markers) {
  const haystack = String(text ?? "");
  return compileMarkers(markers).some((pattern) => pattern.test(haystack));
}

// A response that follows `schemas/review-output.schema.json` (what
// `adversarial-review` asks agy for): a string `verdict` plus a `findings`
// array. Anything else, including JSON of some other shape, is null.
export function parseStructuredReview(response) {
  if (typeof response !== "string" || response.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(response);
    if (parsed && typeof parsed === "object" && typeof parsed.verdict === "string" && Array.isArray(parsed.findings)) {
      return parsed;
    }
  } catch {
    // Not JSON: a plain review's prose, or an adversarial one that did not
    // follow the schema. Either way, the raw string is what a reader sees.
  }
  return null;
}

// Pulls the text a marker search should run over out of a companion `review`
// or `adversarial-review` payload. For a schema-shaped response only the
// findings count (each finding's title, body, and recommendation): the
// summary can restate the change without calling it a defect, so an
// "approve" with no findings has nothing to search and scores MISS, however
// its summary is worded. Any other response is searched as the raw string.
export function reviewText(payload) {
  const response = payload?.result?.response;
  if (typeof response !== "string" || response.length === 0) {
    return "";
  }
  const structured = parseStructuredReview(response);
  if (structured) {
    return structured.findings
      .map((finding) =>
        [finding?.title, finding?.body, finding?.recommendation].filter(Boolean).join(" ")
      )
      .filter(Boolean)
      .join("\n");
  }
  return response;
}

function stringifyDetail(value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

// Classifies one companion run against its cassette. `payload` is the parsed
// JSON stdout of `node agy-companion.mjs review` or `... adversarial-review`.
// A run that was not scored (secrets block, empty diff, or a run agy did not
// complete) is ERROR, not MISS: only a run agy actually answered is scored
// HIT or MISS.
export function evaluateReview(cassette, payload) {
  if (!payload || typeof payload !== "object") {
    return { id: cassette.id, verdict: "ERROR", detail: "no JSON payload" };
  }
  if (payload.ok === false) {
    if (payload.failure === "secrets") {
      return {
        id: cassette.id,
        verdict: "ERROR",
        detail: `blocked by the secret scanner: ${JSON.stringify(payload.hits ?? [])}`
      };
    }
    const parts = [
      stringifyDetail(payload.result?.error),
      stringifyDetail(payload.error),
      payload.failure ? `failure: ${stringifyDetail(payload.failure)}` : "",
      payload.agyError ? `agyError: ${stringifyDetail(payload.agyError)}` : "",
      payload.stderr ? `stderr: ${stringifyDetail(payload.stderr)}` : ""
    ].filter(Boolean);
    return {
      id: cassette.id,
      verdict: "ERROR",
      detail: parts.length > 0 ? parts.join("; ") : "ok: false with no error text"
    };
  }
  if (payload.empty) {
    return {
      id: cassette.id,
      verdict: "ERROR",
      detail: `empty diff reported: ${payload.note ?? ""}`
    };
  }
  const structured = parseStructuredReview(payload.result?.response);
  const text = reviewText(payload);
  if (structured && !text) {
    return {
      id: cassette.id,
      verdict: "MISS",
      detail: `verdict ${structured.verdict} with no findings: ${stringifyDetail(structured.summary)}`
    };
  }
  if (!text) {
    return { id: cassette.id, verdict: "ERROR", detail: "ok: true with no response text" };
  }
  const hit = matchesAnyMarker(text, cassette.markers);
  return { id: cassette.id, verdict: hit ? "HIT" : "MISS", detail: text };
}
