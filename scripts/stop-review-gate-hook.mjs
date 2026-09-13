#!/usr/bin/env node

// Stop-time review gate for the agy plugin.
// Off by default; enabled per workspace via /agy:setup gate on, which stores
// the flag outside the repository (see scripts/lib/state.mjs).
// When enabled, the previous Claude turn is handed to a read-only agy run
// that must answer ALLOW:/BLOCK: on its first output line.

import fs from "node:fs";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { gateEnabled } from "./lib/state.mjs";
import { renderPrompt } from "./lib/prompts.mjs";
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

function parseReviewResponse(response) {
  const text = String(response ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason:
        "The stop-time agy review returned no output. Run /agy:review manually or turn the gate off with /agy:setup gate off."
    };
  }
  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      reason: `agy stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }
  return {
    ok: false,
    reason:
      "The stop-time agy review returned an unexpected answer. Run /agy:review manually or turn the gate off with /agy:setup gate off."
  };
}

function runStopReview(cwd, input) {
  const prompt = buildPrompt(cwd, input);
  // agy started by a hook has no workspace of its own (its shell sits in the
  // agy scratch dir), so the project must be added explicitly or the reviewer
  // sees an empty workspace and allows everything.
  const result = spawnSync(
    "agy",
    ["-p", prompt, "--add-dir", cwd, "--output-format", "json", "--print-timeout", AGY_PRINT_TIMEOUT],
    { cwd, encoding: "utf8", timeout: SPAWN_TIMEOUT_MS }
  );

  if (result.error?.code === "ENOENT") {
    return { ok: true, note: "agy is not installed; stop-review gate skipped. Run /agy:setup." };
  }
  if (result.error?.code === "ETIMEDOUT") {
    return {
      ok: false,
      reason:
        "The stop-time agy review timed out after 10 minutes. Run /agy:review manually or turn the gate off with /agy:setup gate off."
    };
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim().split(/\r?\n/).slice(-1)[0];
    return {
      ok: false,
      reason: detail
        ? `The stop-time agy review failed: ${detail}`
        : "The stop-time agy review failed. Run /agy:review manually or turn the gate off with /agy:setup gate off."
    };
  }

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return {
      ok: false,
      reason:
        "The stop-time agy review returned invalid JSON. Run /agy:review manually or turn the gate off with /agy:setup gate off."
    };
  }
  if (payload?.status && payload.status !== "SUCCESS") {
    return {
      ok: false,
      reason: `The stop-time agy review ended with status ${payload.status}. Run /agy:review manually or turn the gate off with /agy:setup gate off.`
    };
  }
  return parseReviewResponse(payload?.response);
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

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
