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
import { changedFiles, collectDiff, screenDiff, untrackedFiles } from "./lib/git.mjs";
import { gateEnabled } from "./lib/state.mjs";
import { renderPrompt } from "./lib/prompts.mjs";
import { judgeReview } from "./lib/stop-review.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const AGY_PRINT_TIMEOUT = "9m";
const SPAWN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RESPONSE_CHARS = 8000;
const MAX_PATHS_LISTED = 50;
const WITHHELD_BECAUSE = {
  secrets: "the plugin's secret screen found what looks like a credential in it",
  "diff-shape": "git printed it in a format the plugin's secret screen cannot read",
  unmerged: "the repository has an unresolved merge, so the diff leaves the conflicted files out"
};

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

function pathSection(title, paths) {
  if (paths.length === 0) {
    return "";
  }
  const more = paths.length > MAX_PATHS_LISTED ? `\n[and ${paths.length - MAX_PATHS_LISTED} more]` : "";
  return `${title}:\n${paths.slice(0, MAX_PATHS_LISTED).join("\n")}${more}\n\n`;
}

// The gate runs with commands denied, so it cannot run `git diff` itself: the
// hook collects the working tree against HEAD, the same scope and the same
// screen /agy:review uses, and hands it over in the prompt. Untracked files
// are not in that diff, so their paths are listed for agy to read. A diff the
// screen refuses is withheld, and agy gets the changed paths to read instead;
// the refusal never blocks the stop by itself. A workspace git cannot diff
// (not a repository, or no commit yet) still gets a review, from file reads.
function diffBlock(cwd) {
  const untracked = pathSection("Untracked files, not in the diff (read any the previous turn created)", untrackedFiles(cwd));
  const collected = collectDiff("", cwd);
  if (!collected.ok) {
    return `${untracked}No diff is available for this workspace (${collected.error}).`;
  }
  if (collected.empty) {
    return `${untracked}Diff of the working tree against HEAD: empty, no uncommitted changes to tracked files. Changes already committed are not shown: read the files the previous response names to check them.`;
  }
  const refusal = screenDiff(collected.diff);
  if (refusal) {
    const changed = pathSection("Tracked files changed against HEAD", changedFiles(cwd));
    return `${changed}${untracked}The diff of the working tree against HEAD was withheld: ${WITHHELD_BECAUSE[refusal.failure]}. Review by reading the files listed above.`;
  }
  return `${untracked}Diff of the working tree against HEAD follows:\n\n${collected.diff}`;
}

function buildPrompt(cwd, input, diffText) {
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
    CLAUDE_RESPONSE_BLOCK: block,
    DIFF_BLOCK: diffText
  });
}

function runStopReview(cwd, input) {
  const prompt = buildPrompt(cwd, input, diffBlock(cwd));
  // Read-only profile (lib/agy.mjs): plan mode, and commands and file writes
  // denied by the plugin's own per-run rules, because the previous turn is
  // untrusted input and the gate runs in the repository itself. It reviews
  // the diff in the prompt and reads files. The workspace is added explicitly
  // because a bare print-mode run does not treat the cwd as its project (it
  // resolves to the agy scratch dir), so the project must be added or the
  // reviewer sees an empty workspace and allows everything. runPrompt carries the prompt on
  // stdin and reports a headless tool denial as failure: "denied", which is
  // what lets the gate name the missing rule instead of "no output".
  return judgeReview(
    runPrompt(prompt, {
      cwd,
      addDir: [cwd],
      printTimeout: AGY_PRINT_TIMEOUT,
      timeoutMs: SPAWN_TIMEOUT_MS,
      profile: "read-only"
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
