#!/usr/bin/env node

// One live run of the plugin's own runPrompt under a permission profile,
// spawned by `run-denial-matrix.mjs` under a scratch HOME. The prompt comes in
// through AGY_PROBE_PROMPT and the profile through AGY_PROBE_PROFILE; the
// harness reads what the run did off the filesystem afterwards, so this only
// reports what agy said.

import process from "node:process";
import { runPrompt } from "../../scripts/lib/agy.mjs";

const run = runPrompt(String(process.env.AGY_PROBE_PROMPT ?? ""), {
  cwd: process.cwd(),
  addDir: [process.cwd()],
  printTimeout: "3m",
  timeoutMs: 4 * 60 * 1000,
  profile: process.env.AGY_PROBE_PROFILE
});

process.stdout.write(
  `${JSON.stringify(
    {
      ok: run.ok,
      failure: run.failure,
      response: String(run.result?.response ?? "").slice(0, 400),
      deniedActions: run.deniedActions ?? []
    },
    null,
    2
  )}\n`
);
