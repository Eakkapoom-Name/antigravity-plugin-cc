// The cases behind the denial harness (F23).
//
// Every claim the plugin makes about agy's headless permissions came from
// probes typed by hand against an isolated HOME. This module turns those probes
// into data: each case is a settings.json and the report it should produce.
// `tests/live/run-denial-matrix.mjs` writes the settings, runs the real
// `/agy:setup` script against them, and feeds the report back to `evaluateCase`.
//
// Nothing here spawns agy, so the cases themselves cost no quota and are
// checked by the ordinary test suite.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Measured on agy 1.2.4 with an empty allow-list and no `--sandbox`, which is
// the only shape that matters: the plugin never passes that flag.
export const DENIAL_CASES = [
  {
    id: "request-review-default",
    title: "agy's default mode denies headless tools with no rule",
    settings: { toolPermission: "request-review" },
    expect: {
      ready: false,
      toolPermission: "request-review",
      deniedNonEmpty: true,
      nextStepIncludes: ["`request-review`"],
      // Which rule the remedy names follows which tool agy happened to reach
      // for, so the case requires a rule rather than a particular one.
      nextStepIncludesAny: ["command(*)", "read_file(*)"]
    }
  },
  {
    id: "request-review-with-rules",
    title: "the documented rule pair unblocks the default mode",
    settings: {
      toolPermission: "request-review",
      permissions: { allow: ["command(*)", "read_file(*)"] }
    },
    expect: { ready: true, toolPermission: "request-review", deniedIncludes: [] }
  },
  {
    id: "request-review-command-rules-only",
    title: "the default mode with command rules and no read rule, which is issue #21's shape",
    settings: {
      toolPermission: "request-review",
      // Taken from the settings the reporter posted: command rules, no read
      // rule. Every other case here runs an empty allow-list, and the
      // in-workspace read passes. If a populated list is what turns the
      // permissive path strict, this row is where it shows.
      permissions: {
        allow: ["command(git status)", "command(git diff)", "command(ls)", "command(cat)"]
      }
    },
    expect: {
      ready: false,
      toolPermission: "request-review",
      deniedNonEmpty: true
    }
  },
  {
    id: "request-review-workspace-is-home",
    title: "the default mode with the workspace root being the home directory itself",
    settings: { toolPermission: "request-review" },
    // Issue #21's log reads `workspaceDirs=[/home/natthanicha]`, so their
    // workspace root is their home directory. Every other case puts the
    // workspace one level below it.
    workspaceAtHomeRoot: true,
    expect: {
      ready: false,
      toolPermission: "request-review",
      deniedNonEmpty: true
    }
  },
  {
    id: "request-review-untrusted",
    title: "the same default mode, with the workspace left out of the trusted list",
    settings: { toolPermission: "request-review" },
    trustScratchWorkspace: false,
    expect: {
      ready: false,
      toolPermission: "request-review",
      deniedNonEmpty: true
    }
  },
  {
    id: "proceed-in-sandbox",
    title: "the sandbox mode is a trap without the flag the plugin never passes",
    settings: { toolPermission: "proceed-in-sandbox" },
    expect: {
      ready: false,
      toolPermission: "proceed-in-sandbox",
      deniedIncludes: ["command"],
      nextStepIncludes: ["`proceed-in-sandbox`", "--sandbox"]
    }
  },
  {
    id: "strict",
    title: "the tightest mode denies even an in-workspace read",
    settings: { toolPermission: "strict" },
    expect: {
      ready: false,
      toolPermission: "strict",
      deniedIncludes: [],
      nextStepIncludes: ["`strict`"]
    }
  },
  {
    id: "always-proceed",
    title: "the blunt mode approves everything with no rule",
    settings: { toolPermission: "always-proceed" },
    expect: { ready: true, toolPermission: "always-proceed", deniedIncludes: [] }
  },
  {
    id: "unknown-mode",
    title: "a mode agy does not know falls back to the default, silently",
    settings: { toolPermission: "agent-decides" },
    expect: {
      ready: false,
      toolPermission: "request-review",
      declaredToolPermission: "agent-decides",
      deniedNonEmpty: true,
      nextStepIncludes: ["`request-review`"]
    }
  }
];

// agy writes new top-level entries into HOME while it runs, and the scratch
// copy carries real OAuth credentials, so the runner must never be pointed at
// the real home directory by a bad argument or an unset variable.
export function assertScratchHome(dir) {
  const resolved = path.resolve(String(dir ?? ""));
  if (!resolved || resolved === path.resolve(".")) {
    throw new Error("Refusing to run: no scratch HOME was given.");
  }
  let real = resolved;
  let realHome = os.homedir();
  try {
    real = fs.realpathSync.native(resolved);
  } catch {
    real = resolved;
  }
  try {
    realHome = fs.realpathSync.native(os.homedir());
  } catch {
    realHome = os.homedir();
  }
  if (real === realHome) {
    throw new Error(`Refusing to run against the real home directory: ${realHome}`);
  }
  return resolved;
}

export function evaluateCase(testCase, report) {
  const expect = testCase.expect ?? {};
  const failures = [];

  if (report?.ready !== expect.ready) {
    failures.push(`ready: expected ${expect.ready}, got ${report?.ready}`);
  }

  const settings = report?.agySettings ?? {};
  if (expect.toolPermission && settings.toolPermission !== expect.toolPermission) {
    failures.push(
      `agySettings.toolPermission: expected ${expect.toolPermission}, got ${settings.toolPermission}`
    );
  }
  if (
    expect.declaredToolPermission &&
    settings.declaredToolPermission !== expect.declaredToolPermission
  ) {
    failures.push(
      `agySettings.declaredToolPermission: expected ${expect.declaredToolPermission}, got ${settings.declaredToolPermission}`
    );
  }

  const denied = report?.toolPermissions?.deniedActions ?? [];
  // agy reaches for whichever tool the prompt leads it to first, and that is not
  // stable between runs of the same prompt, so most cases assert that something
  // was denied rather than which thing.
  if (expect.deniedNonEmpty && denied.length === 0) {
    failures.push("deniedActions: expected at least one denied action, got none");
  }
  for (const action of expect.deniedIncludes ?? []) {
    if (!denied.includes(action)) {
      failures.push(`deniedActions: expected to include ${action}, got [${denied.join(", ")}]`);
    }
  }

  const steps = (report?.nextSteps ?? []).join("\n");
  for (const fragment of expect.nextStepIncludes ?? []) {
    if (!steps.includes(fragment)) {
      failures.push(`nextSteps: expected to mention ${fragment}`);
    }
  }
  const alternatives = expect.nextStepIncludesAny ?? [];
  if (alternatives.length > 0 && !alternatives.some((fragment) => steps.includes(fragment))) {
    failures.push(`nextSteps: expected to mention one of ${alternatives.join(", ")}`);
  }

  return { id: testCase.id, pass: failures.length === 0, failures };
}

// Only the permission keys are the experiment. Everything else in the user's
// settings file (their model, their verbosity, their statusline) comes through
// untouched, because a bare settings file changes the model too and turns a
// permission question into a timing question.
export function mergeSettings(base, testCase, scratchHome) {
  const merged = { ...(base ?? {}), ...testCase.settings };

  if (!testCase.settings.permissions) {
    delete merged.permissions;
  }

  // agy trusts workspaces by path, so the scratch repository has to be trusted
  // the way a repository under the real home directory already is.
  const trusted = Array.isArray(base?.trustedWorkspaces) ? [...base.trustedWorkspaces] : [];
  if (testCase.trustScratchWorkspace !== false && scratchHome && !trusted.includes(scratchHome)) {
    trusted.push(scratchHome);
  }
  if (trusted.length > 0) {
    merged.trustedWorkspaces = trusted;
  }

  return merged;
}
