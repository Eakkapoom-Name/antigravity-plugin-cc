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

import { agyAvailable, runPrompt, runSlashCommand } from "./lib/agy.mjs";
import { collectDiff, untrackedFiles } from "./lib/git.mjs";
import { gateEnabled, setGate } from "./lib/state.mjs";
import { renderPrompt } from "./lib/prompts.mjs";
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

// Splits `[scope] [focus words...]`. Only the first token can be a scope, and
// only when it looks like one; everything else is reviewer focus.
export function parseReviewArguments(argument) {
  const tokens = String(argument ?? "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { scope: "", focus: "" };
  }
  const first = tokens[0];
  const looksLikeScope =
    first === "staged" || first === "branch" || /^[A-Za-z0-9._\/-]+$/.test(first);
  if (looksLikeScope) {
    return { scope: first, focus: tokens.slice(1).join(" ") };
  }
  return { scope: "", focus: tokens.join(" ") };
}

function review({ argument, adversarial }) {
  const cwd = workspace();
  if (!agyAvailable()) {
    return { ok: false, error: "agy is not installed or not on PATH. Run /agy:setup." };
  }

  const { scope, focus } = parseReviewArguments(argument);
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

  const prompt = renderPrompt(adversarial ? "adversarial-review" : "review", {
    FOCUS: focus || "none",
    DIFF: collected.diff
  });

  // Read-only: no --mode. The diff rides on stdin, so its size is irrelevant.
  const run = runPrompt(prompt, {
    cwd,
    addDir: [cwd],
    // Structured output is enforced by agy for the adversarial review rather
    // than merely requested in the prompt text.
    jsonSchema: adversarial && fs.existsSync(SCHEMA_PATH) ? SCHEMA_PATH : undefined
  });

  return {
    ok: run.ok,
    empty: false,
    scope: collected.scope.label,
    diffBytes: Buffer.byteLength(collected.diff, "utf8"),
    result: run.result,
    stderr: run.stderr,
    failure: run.failure
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

  const run = runPrompt(renderPrompt("transfer", { BRIEF: brief }), {
    cwd,
    addDir: [cwd],
    model,
    effort
  });
  try {
    fs.rmSync(briefPath, { force: true });
  } catch {
    // A leftover brief in a scratch directory is not worth failing the handoff.
  }

  return { ok: run.ok, result: run.result, stderr: run.stderr, failure: run.failure };
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
    return { ok: true, action, enabled: gateEnabled(cwd), workspace: cwd };
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
