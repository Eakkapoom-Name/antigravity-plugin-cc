#!/usr/bin/env node

// The live half of the denial harness (F23). Opt-in: it spawns agy once per
// probe and spends real quota, so it is deliberately outside the `npm test`
// discovery patterns and has its own script, `npm run test:denials`.
//
// What it does, per case in `scripts/lib/denial-matrix.mjs`:
//   1. builds a scratch HOME that symlinks the real one, except for the single
//      file under test, `~/.gemini/antigravity-cli/settings.json`;
//   2. writes that file with the case's permission settings;
//   3. runs the real `/agy:setup` script against a scratch git workspace;
//   4. feeds the JSON report to `evaluateCase`.
//
// The symlink overlay is what F22's ad-hoc probes used. It is fine here and not
// in the plugin itself: a throwaway HOME does not care that agy writes new
// entries into it mid-run, and git identity comes through the symlinked
// `.gitconfig`. agy's own state directories are symlinks to the real ones, so a
// harness run leaves conversations behind exactly where an ordinary run would.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  DENIAL_CASES,
  assertScratchHome,
  evaluateCase,
  mergeSettings
} from "../../scripts/lib/denial-matrix.mjs";
import { setGate } from "../../scripts/lib/state.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const HOOK_TIMEOUT_MS = 12 * 60 * 1000;
const SETTINGS_REL = path.join(".gemini", "antigravity-cli", "settings.json");

function parseArgs(argv) {
  const ids = [];
  let list = false;
  let keep = false;
  let hook = true;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list") {
      list = true;
    } else if (arg === "--keep") {
      keep = true;
    } else if (arg === "--no-hook") {
      hook = false;
    } else if (arg === "--case") {
      i += 1;
      ids.push(String(argv[i] ?? ""));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { ids, list, keep, hook };
}

// Everything in the real HOME is reachable, so agy finds its binary, its
// credentials and the user's git identity. Only the two directories on the way
// to settings.json are real directories, so the file can be replaced without
// touching anything the user owns.
function realSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), SETTINGS_REL), "utf8"));
  } catch {
    return {};
  }
}

function buildScratchHome(root, testCase) {
  const home = assertScratchHome(path.join(root, "home"));
  const realHome = os.homedir();
  fs.mkdirSync(home, { recursive: true });

  const overlay = [".gemini", path.join(".gemini", "antigravity-cli")];
  const shadowed = new Set(overlay.map((entry) => path.join(home, entry)));

  for (const relative of ["", ...overlay]) {
    const source = path.join(realHome, relative);
    const target = path.join(home, relative);
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(source)) {
      const linkPath = path.join(target, name);
      if (shadowed.has(linkPath) || linkPath === path.join(home, SETTINGS_REL)) {
        continue;
      }
      fs.symlinkSync(path.join(source, name), linkPath);
    }
  }

  const settings = mergeSettings(realSettings(), testCase, home);
  fs.writeFileSync(path.join(home, SETTINGS_REL), `${JSON.stringify(settings, null, 2)}\n`);
  return home;
}

function buildWorkspace(home, testCase = {}) {
  // Inside the scratch HOME on purpose: agy trusts workspaces by path, and a
  // repository under the home directory is the shape a real user has. One case
  // puts it at the home directory itself, which is the shape issue #21's log
  // shows.
  const workspace = testCase.workspaceAtHomeRoot ? home : path.join(home, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  spawnSync("git", ["init", "--quiet"], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, "README.md"), "# denial harness workspace\n");
  return workspace;
}

function runSetup(home, workspace, pluginData) {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "agy-setup.mjs")], {
    cwd: workspace,
    encoding: "utf8",
    timeout: SETUP_TIMEOUT_MS,
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_PROJECT_DIR: workspace,
      CLAUDE_PLUGIN_DATA: pluginData
    }
  });
  try {
    return { report: JSON.parse(result.stdout), raw: result.stdout };
  } catch {
    throw new Error(
      `setup produced no JSON report (status ${result.status}): ${result.stderr || result.stdout}`
    );
  }
}

function runCase(testCase, root, keep) {
  const caseRoot = path.join(root, testCase.id);
  fs.mkdirSync(caseRoot, { recursive: true });
  try {
    const home = buildScratchHome(caseRoot, testCase);
    const workspace = buildWorkspace(home, testCase);
    const { report } = runSetup(home, workspace, path.join(caseRoot, "plugin-data"));
    const outcome = evaluateCase(testCase, report);
    return { ...outcome, report };
  } finally {
    if (!keep) {
      fs.rmSync(caseRoot, { recursive: true, force: true });
    }
  }
}

// F20's own row: the Stop hook must turn a denial into a block that names the
// rule to add, rather than a generic "no output" refusal.
function runHookCase(root, keep) {
  const id = "stop-gate-under-denial";
  const caseRoot = path.join(root, id);
  fs.mkdirSync(caseRoot, { recursive: true });
  const previousData = process.env.CLAUDE_PLUGIN_DATA;
  try {
    const home = buildScratchHome(caseRoot, { id, settings: { toolPermission: "request-review" } });
    const workspace = buildWorkspace(home);
    const pluginData = path.join(caseRoot, "plugin-data");

    process.env.CLAUDE_PLUGIN_DATA = pluginData;
    setGate(workspace, true);

    const result = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, "scripts", "stop-review-gate-hook.mjs")],
      {
        cwd: workspace,
        encoding: "utf8",
        timeout: HOOK_TIMEOUT_MS,
        input: JSON.stringify({
          cwd: workspace,
          last_assistant_message: "I edited README.md and did not run any tests."
        }),
        env: {
          ...process.env,
          HOME: home,
          CLAUDE_PROJECT_DIR: workspace,
          CLAUDE_PLUGIN_DATA: pluginData
        }
      }
    );

    const failures = [];
    let decision = null;
    try {
      decision = JSON.parse(result.stdout);
    } catch {
      failures.push(`hook printed no decision JSON: ${result.stdout || result.stderr}`);
    }
    if (decision && decision.decision !== "block") {
      failures.push(`decision: expected block, got ${decision.decision}`);
    }
    const reason = String(decision?.reason ?? "");
    if (decision && !/read_file\(\*\)|command\(\*\)/.test(reason)) {
      failures.push(`reason: expected it to name the rule to add, got: ${reason}`);
    }
    return { id, pass: failures.length === 0, failures, report: decision };
  } finally {
    if (previousData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousData;
    }
    if (!keep) {
      fs.rmSync(caseRoot, { recursive: true, force: true });
    }
  }
}

// F21's own row: a real denial, resumed once on the same conversation, finishing
// under the stated constraint.
function runRecoveryCase(root, keep) {
  const id = "denial-recovery";
  const caseRoot = path.join(root, id);
  fs.mkdirSync(caseRoot, { recursive: true });
  try {
    const home = buildScratchHome(caseRoot, { id, settings: { toolPermission: "request-review" } });
    const workspace = buildWorkspace(home);

    const result = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, "tests", "live", "denial-recovery-probe.mjs")],
      {
        cwd: workspace,
        encoding: "utf8",
        timeout: HOOK_TIMEOUT_MS,
        env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: workspace }
      }
    );

    const failures = [];
    let probe = null;
    try {
      probe = JSON.parse(result.stdout);
    } catch {
      failures.push(`probe printed no JSON: ${result.stdout || result.stderr}`);
    }
    if (probe && !probe.recovery) {
      failures.push(`no resume was attempted; the run reported failure ${probe.failure}`);
    }
    if (probe?.recovery && probe.recovery.attempted !== true) {
      failures.push("recovery.attempted was not true");
    }
    if (probe?.recovery && (probe.recovery.deniedActions ?? []).length === 0) {
      failures.push("the resume recorded no denied actions from the first turn");
    }
    if (probe?.recovery && probe.recovery.recovered !== true) {
      failures.push(`the resumed turn did not succeed: ${probe.response || probe.failure}`);
    }
    return { id, pass: failures.length === 0, failures, report: probe };
  } finally {
    if (!keep) {
      fs.rmSync(caseRoot, { recursive: true, force: true });
    }
  }
}

function main(argv) {
  const { ids, list, keep, hook } = parseArgs(argv);

  if (list) {
    for (const testCase of DENIAL_CASES) {
      process.stdout.write(`${testCase.id}: ${testCase.title}\n`);
    }
    process.stdout.write("stop-gate-under-denial: the Stop hook blocks and names the rule to add\n");
    process.stdout.write("denial-recovery: a denied delegation is resumed once and finishes\n");
    return 0;
  }

  // Every row is addressable by id, including the two that drive something other
  // than the setup report, so a single case can be rerun without paying for the
  // whole matrix.
  const runnable = [
    ...DENIAL_CASES.map((entry) => ({
      id: entry.id,
      run: (root, keep) => runCase(entry, root, keep)
    })),
    ...(hook
      ? [
          { id: "stop-gate-under-denial", run: runHookCase },
          { id: "denial-recovery", run: runRecoveryCase }
        ]
      : [])
  ];
  const selected = ids.length > 0 ? runnable.filter((entry) => ids.includes(entry.id)) : runnable;
  if (selected.length === 0) {
    throw new Error(`No case matched: ${ids.join(", ")}`);
  }

  const root = fs.mkdtempSync(
    path.join(process.env.AGY_DENIAL_SCRATCH || os.tmpdir(), "agy-denial-")
  );
  const results = [];
  try {
    // Serial on purpose: agy's quota buckets are shared, and parallel runs
    // would make a rate-limited row look like a permission result.
    for (const entry of selected) {
      process.stderr.write(`running ${entry.id} ...\n`);
      try {
        results.push(entry.run(root, keep));
      } catch (error) {
        results.push({
          id: entry.id,
          pass: false,
          failures: [error instanceof Error ? error.message : String(error)]
        });
      }
    }
  } finally {
    if (!keep) {
      fs.rmSync(root, { recursive: true, force: true });
    } else {
      process.stderr.write(`scratch kept at ${root}\n`);
    }
  }

  process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
  return results.every((entry) => entry.pass) ? 0 : 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
