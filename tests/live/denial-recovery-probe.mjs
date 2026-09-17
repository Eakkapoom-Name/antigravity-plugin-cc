#!/usr/bin/env node

// One live delegation, run through the denial-recovering runner, printing what
// came back. Spawned by `run-denial-matrix.mjs` under a scratch HOME whose
// settings deny the tool the prompt asks for, which is the only way to exercise
// F21 against a real refusal rather than a fixture.

import process from "node:process";
import { runPromptWithDenialRecovery } from "../../scripts/lib/agy.mjs";

const PROMPT =
  "Use your terminal command tool to run 'pwd', then reply with exactly the word READY.";

const run = runPromptWithDenialRecovery(PROMPT, {
  cwd: process.cwd(),
  addDir: [process.cwd()],
  printTimeout: "2m",
  timeoutMs: 3 * 60 * 1000
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
