#!/usr/bin/env node

// One live delegation, run through the denial-recovering runner, printing what
// came back. Spawned by `run-denial-matrix.mjs` under a scratch HOME whose
// settings deny the tool the prompt asks for, which is the only way to exercise
// F21 against a real refusal rather than a fixture.

import process from "node:process";
import { runPromptWithDenialRecovery } from "../../scripts/lib/agy.mjs";

// The harness passes a marker path outside the workspace; the command creates
// it, so whether the command ran is read off the filesystem, not off agy's
// report.
const MARKER = process.env.AGY_PROBE_MARKER ?? "/tmp/agy-denial-recovery-marker";
const PROMPT = `Use your terminal command tool to run 'touch ${MARKER}', then reply with exactly the word READY.`;

// The read-only profile, the one runIsolated gives the commands this recovery
// serves. Under it agy may refuse the command with a `denied_actions` entry
// (then the run is resumed once) or decline it in prose; the harness checks
// the outcome either way: the command must not have run.
const run = runPromptWithDenialRecovery(PROMPT, {
  cwd: process.cwd(),
  addDir: [process.cwd()],
  printTimeout: "2m",
  timeoutMs: 3 * 60 * 1000,
  profile: "read-only"
});

process.stdout.write(
  `${JSON.stringify(
    {
      ok: run.ok,
      failure: run.failure,
      response: String(run.result?.response ?? "").slice(0, 400),
      numTurns: run.result?.num_turns ?? null,
      deniedActions: run.deniedActions ?? [],
      recovery: run.recovery
        ? {
            attempted: run.recovery.attempted,
            recovered: run.recovery.recovered,
            deniedActions: run.recovery.deniedActions,
            conversationId: run.recovery.conversationId
          }
        : null
    },
    null,
    2
  )}\n`
);
