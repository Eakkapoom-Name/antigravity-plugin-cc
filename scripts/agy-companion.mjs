#!/usr/bin/env node

// Deterministic half of the agy plugin. Commands that had their logic written
// out as prose for the model to follow now call a subcommand here instead, so
// the behaviour can be tested rather than only the wording.
//
// Deliberately not here: /agy:status, /agy:result, and /agy:cancel. This plugin
// keeps no job store by design; background runs are Claude Code background
// subagents, so those three orchestrate ListAgents, TaskOutput, and TaskStop
// and have no deterministic work to move.
//
// Usage: node agy-companion.mjs <subcommand> [arguments]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  agyAvailable,
  effortRejected,
  runIsolated,
  runPrompt,
  runPromptWithDenialRecovery,
  runSlashCommand
} from "./lib/agy.mjs";
import { collectDiff, untrackedFiles } from "./lib/git.mjs";
import { gateEnabled, resolveStateFile, setGate } from "./lib/state.mjs";
import { renderPrompt } from "./lib/prompts.mjs";
import { scanForSecrets } from "./lib/secrets.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "schemas",
  "review-output.schema.json"
);

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function workspace() {
  return resolveWorkspaceRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
}

// Splits `[scope] [--allow-secret <regex>]... [focus words...]`. Only the
// first non-flag token can be a scope, and only when it looks like one;
// everything else is reviewer focus.
export function parseReviewArguments(argument) {
  const tokens = String(argument ?? "").trim().split(/\s+/).filter(Boolean);
  const allowSecret = [];
  const words = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === "--allow-secret") {
      const value = tokens[i + 1];
      if (value && !value.startsWith("--")) {
        allowSecret.push(value);
        i += 1;
      }
      continue;
    }
    words.push(tokens[i]);
  }
  if (words.length === 0) {
    return { scope: "", focus: "", allowSecret };
  }
  const first = words[0];
  const looksLikeScope =
    first === "staged" || first === "branch" || /^[A-Za-z0-9._\/-]+$/.test(first);
  if (looksLikeScope) {
    return { scope: first, focus: words.slice(1).join(" "), allowSecret };
  }
  return { scope: "", focus: words.join(" "), allowSecret };
}

// `run` is the low-level runner handed down to `runIsolated`, the same
// injectable third parameter `runIsolated` itself already defines (defaulting
// to the real `runPrompt`). Isolation is therefore not something a caller can
// opt out of by injecting a runner: whatever `run` is, it only ever sees the
// temp cwd `runIsolated` builds, never the repository path.
export function review({ argument, adversarial, run = runPrompt, available = agyAvailable }) {
  const cwd = workspace();
  if (!available()) {
    return { ok: false, error: "agy is not installed or not on PATH. Run /agy:setup." };
  }

  const { scope, focus, allowSecret } = parseReviewArguments(argument);
  const collected = collectDiff(scope, cwd);
  if (!collected.ok) {
    return { ok: false, error: collected.error, scope: collected.scope.label };
  }

  if (collected.empty) {
    const untracked = untrackedFiles(cwd);
    return {
      ok: true,
      empty: true,
      scope: collected.scope.label,
      untrackedFiles: untracked,
      note:
        untracked.length > 0
          ? "No diff in this scope, but there are untracked files; they are not part of a diff review."
          : "Nothing to review in this scope."
    };
  }

  // Nothing leaves for agy while a credential shape sits in the added lines.
  // Blocking, not redacting: a redacted diff reviews differently, and the user
  // is one --allow-secret away when the hit is a fixture.
  const scan = scanForSecrets(collected.diff, { allow: allowSecret, diff: true });
  if (scan.hits.length > 0) {
    return {
      ok: false,
      failure: "secrets",
      scope: collected.scope.label,
      hits: scan.hits,
      note:
        "The review did not run: the diff carries what looks like a credential. Redact it and rerun, or pass --allow-secret <regex> for a known false positive."
    };
  }

  const prompt = renderPrompt(adversarial ? "adversarial-review" : "review", {
    FOCUS: focus || "none",
    DIFF: collected.diff
  });

  // Isolated: agy gets a temp directory, not the repo, so a review cannot
  // write. The diff rides on stdin, so its size is irrelevant. A denial here
  // is worth one resume: the diff is already in the prompt.
  const out = runIsolated(
    prompt,
    {
      // Structured output is enforced by agy for the adversarial review rather
      // than merely requested in the prompt text.
      jsonSchema: adversarial && fs.existsSync(SCHEMA_PATH) ? SCHEMA_PATH : undefined
    },
    run
  );

  return {
    ok: out.ok,
    empty: false,
    scope: collected.scope.label,
    diffBytes: Buffer.byteLength(collected.diff, "utf8"),
    result: out.result,
    deniedActions: out.deniedActions,
    recovery: out.recovery,
    stderr: out.stderr,
    failure: out.failure,
    note: out.note
  };
}

// `transfer <brief-path> [--model <name>] [--effort <level>]`. The routing
// flags are split out here so they reach agy as flags rather than being
// mistaken for part of the path.
export function parseTransferArguments(argument) {
  const tokens = String(argument ?? "").trim().split(/\s+/).filter(Boolean);
  const parsed = { briefPath: "", model: undefined, effort: undefined };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--model" || token === "--effort") {
      const value = tokens[i + 1];
      if (value && !value.startsWith("--")) {
        parsed[token === "--model" ? "model" : "effort"] = value;
        i += 1;
      }
      continue;
    }
    if (!parsed.briefPath) {
      parsed.briefPath = token;
    }
  }
  return parsed;
}

function transfer(argument) {
  const cwd = workspace();
  if (!agyAvailable()) {
    return { ok: false, error: "agy is not installed or not on PATH. Run /agy:setup." };
  }

  // The brief is written by the model, since it summarizes a conversation the
  // script cannot see. Only the path crosses the boundary, so the brief never
  // touches argv however long it is.
  const { briefPath, model, effort } = parseTransferArguments(argument);
  if (!briefPath) {
    return { ok: false, error: "transfer needs the path to a handoff brief file." };
  }
  let brief;
  try {
    brief = fs.readFileSync(briefPath, "utf8");
  } catch (error) {
    return { ok: false, error: `Could not read the handoff brief: ${error.message}` };
  }

  const scan = scanForSecrets(brief, { diff: false });
  if (scan.hits.length > 0) {
    return {
      ok: false,
      failure: "secrets",
      hits: scan.hits,
      note: "The handoff did not run: the brief carries what looks like a credential. Edit the brief and rerun."
    };
  }

  const prompt = renderPrompt("transfer", { BRIEF: brief });
  let run = runPromptWithDenialRecovery(prompt, { cwd, addDir: [cwd], model, effort });
  // Some models refuse --effort before any model call is made, so the flag is
  // dropped and the run repeated once. That rejection spends no quota, so this
  // is the one retry the runtime contract allows.
  let effortDropped = false;
  if (effort && effortRejected(run.result)) {
    effortDropped = true;
    run = runPromptWithDenialRecovery(prompt, { cwd, addDir: [cwd], model });
  }
  try {
    fs.rmSync(briefPath, { force: true });
  } catch {
    // A leftover brief in a scratch directory is not worth failing the handoff.
  }

  return {
    ok: run.ok,
    result: run.result,
    deniedActions: run.deniedActions,
    recovery: run.recovery,
    effortDropped,
    stderr: run.stderr,
    failure: run.failure
  };
}

function quota() {
  if (!agyAvailable()) {
    return { ok: false, error: "agy is not installed or not on PATH. Run /agy:setup." };
  }
  const run = runSlashCommand("usage");
  if (!run.ok) {
    return { ok: false, error: run.stderr || `the /usage call failed (${run.failure})` };
  }
  if (run.payload?.command?.name !== "usage") {
    return {
      ok: false,
      error:
        "This agy version predates the print-mode /usage command. Run `agy update`. Do not retry as a prompt; that would spend quota."
    };
  }

  const groups = [];
  for (const group of run.payload.command.data?.groups ?? []) {
    for (const bucket of group.buckets ?? []) {
      groups.push({
        group: group.name,
        window: bucket.window,
        remainingPercent: Math.round((bucket.remaining_fraction ?? 0) * 1000) / 10,
        resetTime: bucket.reset_time ?? null,
        low: (bucket.remaining_fraction ?? 0) < 0.2
      });
    }
  }
  return { ok: true, buckets: groups };
}

function gate(argument) {
  const cwd = workspace();
  const action = String(argument ?? "").trim().toLowerCase() || "status";
  if (action === "status") {
    // The state file is named here too, not only on a write: B3 moved it out of
    // the repository, so the path is the only way to tell which file this
    // workspace reads, and CLAUDE_PLUGIN_DATA is not always this plugin's.
    return {
      ok: true,
      action,
      enabled: gateEnabled(cwd),
      workspace: cwd,
      stateFile: resolveStateFile(cwd)
    };
  }
  if (action === "on" || action === "off") {
    const { enabled, file } = setGate(cwd, action === "on");
    return { ok: true, action, enabled, workspace: cwd, stateFile: file };
  }
  return { ok: false, error: `Unknown gate action: ${action}. Use on, off, or status.` };
}

const SUBCOMMANDS = {
  review: (argument) => review({ argument, adversarial: false }),
  "adversarial-review": (argument) => review({ argument, adversarial: true }),
  transfer,
  quota,
  gate
};

export function main(argv) {
  const [subcommand, ...rest] = argv;
  const handler = SUBCOMMANDS[subcommand];
  if (!handler) {
    return {
      ok: false,
      error: `Unknown subcommand: ${subcommand ?? "<none>"}. Known: ${Object.keys(SUBCOMMANDS).join(", ")}.`
    };
  }
  return handler(rest.join(" "));
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    const payload = main(process.argv.slice(2));
    emit(payload);
    if (!payload.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    emit({ ok: false, error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}
