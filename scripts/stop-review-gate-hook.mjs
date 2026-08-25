#!/usr/bin/env node

// Stop-time review gate for the agy plugin.
// Off by default; enabled per project via `stop_review_gate: true` in the
// YAML frontmatter of <project>/.claude/agy.local.md (see /agy:setup).
// When enabled, the previous Claude turn is handed to a read-only agy run
// that must answer ALLOW:/BLOCK: on its first output line.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const AGY_PRINT_TIMEOUT = "9m";
const SPAWN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RESPONSE_CHARS = 8000;

const PROMPT_TEMPLATE = `<task>
Run a stop-gate review of the previous Claude turn.
The repository under review is at {{REPO_ROOT}}. It is part of your workspace; inspect its state (working tree, diffs, files) from that absolute path.
Only review the work from the previous Claude turn.
Only review it if Claude actually did code changes in that turn.
Pure status, setup, or reporting output does not count as reviewable work.
For example, the output of /agy:setup or /agy:status does not count.
Only direct edits made in that specific turn count.
If the previous Claude turn was only a status update, a summary, a setup/login check, a review result, or output from a command that did not itself make direct edits in that turn, return ALLOW immediately and do no further work.
Challenge whether that specific work and its design choices should ship.

{{CLAUDE_RESPONSE_BLOCK}}
</task>

<compact_output_contract>
Return a compact final answer.
Your first line must be exactly one of:
- ALLOW: <short reason>
- BLOCK: <short reason>
Do not put anything before that first line.
</compact_output_contract>

<default_follow_through_policy>
Use ALLOW if the previous turn did not make code changes or if you do not see a blocking issue.
Use ALLOW immediately, without extra investigation, if the previous turn was not an edit-producing turn.
Use BLOCK only if the previous turn made code changes and you found something that still needs to be fixed before stopping.
</default_follow_through_policy>

<grounding_rules>
Ground every blocking claim in the repository context or tool outputs you inspected during this run.
Do not treat the previous Claude response as proof that code changes happened; verify that from the repository state before you block.
Do not block based on older edits from earlier turns when the immediately previous turn did not itself make direct edits.
</grounding_rules>

<dig_deeper_nudge>
If the previous turn did make code changes, check for second-order failures, empty-state behavior, retries, stale state, rollback risk, and design tradeoffs before you finalize.
</dig_deeper_nudge>
`;

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

function gateEnabled(cwd) {
  const settingsFile = path.join(cwd, ".claude", "agy.local.md");
  let raw;
  try {
    raw = fs.readFileSync(settingsFile, "utf8");
  } catch {
    return false;
  }
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) {
    return false;
  }
  return /^stop_review_gate:\s*true\s*$/m.test(frontmatter[1]);
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
  return PROMPT_TEMPLATE.replace("{{REPO_ROOT}}", cwd).replace("{{CLAUDE_RESPONSE_BLOCK}}", block);
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

  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
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
