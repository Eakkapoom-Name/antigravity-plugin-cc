#!/usr/bin/env node

// Stop-time review gate for the agy plugin.
// Off by default; enabled per workspace via /agy:setup gate on, which stores
// the flag outside the repository (see scripts/lib/state.mjs).
// When enabled, the previous Claude turn is handed to a read-only agy run
// that must answer ALLOW:/BLOCK: on its first output line.

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runPrompt } from "./lib/agy.mjs";
import { gateEnabled } from "./lib/state.mjs";
import { renderPrompt } from "./lib/prompts.mjs";
import { judgeReview } from "./lib/stop-review.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const AGY_PRINT_TIMEOUT = "9m";
const SPAWN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RESPONSE_CHARS = 8000;

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (message) {
    process.stderr.write(`${message}\n`);
  }
}

function lastAssistantMessageFromTranscript(transcriptPath) {
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return "";
  }
  let last = "";
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "assistant") {
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    const text = content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) {
      last = text;
    }
  }
  return last;
}

function buildPrompt(cwd, input) {
  let lastMessage = String(input.last_assistant_message ?? "").trim();
  if (!lastMessage && input.transcript_path) {
    lastMessage = lastAssistantMessageFromTranscript(input.transcript_path);
  }
  if (lastMessage.length > MAX_RESPONSE_CHARS) {
    lastMessage = `${lastMessage.slice(0, MAX_RESPONSE_CHARS)}\n[truncated]`;
  }
  const block = lastMessage ? `Previous Claude response:\n${lastMessage}` : "";
  return renderPrompt("stop-review-gate", {
    REPO_ROOT: cwd,
    CLAUDE_RESPONSE_BLOCK: block
  });
}

function runStopReview(cwd, input) {
  const prompt = buildPrompt(cwd, input);
  // Read-only: no --mode. The workspace is added explicitly because a bare
  // print-mode run does not treat the cwd as its project (it resolves to the
  // agy scratch dir), so the project must be added or the reviewer sees an
  // empty workspace and allows everything. runPrompt carries the prompt on
  // stdin and reports a headless tool denial as failure: "denied", which is
  // what lets the gate name the missing rule instead of "no output".
  return judgeReview(
    runPrompt(prompt, {
      cwd,
      addDir: [cwd],
      printTimeout: AGY_PRINT_TIMEOUT,
      timeoutMs: SPAWN_TIMEOUT_MS
    })
  );
}

function main() {
  const input = readHookInput();

  if (input.stop_hook_active) {
    return;
  }

  // Anchored on the repository root so this agrees with /agy:setup even when
  // the session cwd is a subdirectory of the project.
  const cwd = resolveWorkspaceRoot(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!gateEnabled(cwd)) {
    return;
  }

  const review = runStopReview(cwd, input);
  if (review.ok) {
    logNote(review.note);
    return;
  }
  emitDecision({ decision: "block", reason: review.reason });
}

// Only act when invoked as the hook; importing this module must not read
// stdin or spawn agy.
if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
