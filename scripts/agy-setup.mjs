#!/usr/bin/env node

// Readiness check for the agy plugin, mirroring the codex-companion setup
// contract: run every probe here and print one JSON report on stdout.
// Usage: node agy-setup.mjs [--json]   (output is always JSON)

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const AGY_PRINT_TIMEOUT = "2m";
const SPAWN_TIMEOUT_MS = 3 * 60 * 1000;

const AUTH_PROBE_PROMPT = "Reply with exactly: OK";
const TOOL_PROBE_PROMPT =
  "Use your terminal command tool to run 'pwd' and reply with exactly its output.";

function checkNode() {
  return { available: true, detail: process.version };
}

function checkAgy() {
  const which = spawnSync("which", ["agy"], { encoding: "utf8" });
  const agyPath = which.status === 0 ? which.stdout.trim() : null;
  const version = spawnSync("agy", ["--version"], {
    encoding: "utf8",
    timeout: 30 * 1000
  });
  if (version.error?.code === "ENOENT" || version.status !== 0) {
    return { available: false, detail: "agy is not on PATH", path: agyPath };
  }
  return {
    available: true,
    detail: `agy ${version.stdout.trim()}`,
    path: agyPath
  };
}

function runProbe(prompt) {
  const result = spawnSync(
    "agy",
    ["-p", prompt, "--output-format", "json", "--print-timeout", AGY_PRINT_TIMEOUT],
    { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS }
  );
  if (result.error?.code === "ETIMEDOUT") {
    return { ok: false, failure: "timeout", stderr: "", payload: null };
  }
  const stderr = String(result.stderr ?? "").trim();
  if (result.status !== 0) {
    return { ok: false, failure: "nonzero-exit", stderr, payload: null };
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return { ok: false, failure: "invalid-json", stderr, payload: null };
  }
  return { ok: true, failure: null, stderr, payload };
}

function decisiveStderrLine(stderr) {
  const lines = String(stderr ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim());
  return (
    lines.find((line) => line.startsWith("jetski: no output produced")) ??
    lines.slice(-1)[0] ??
    ""
  );
}

function looksLikeAuthFailure(stderr) {
  return /auth|login|credential|unauthenticated|unauthorized/i.test(stderr);
}

function checkAuth() {
  const probe = runProbe(AUTH_PROBE_PROMPT);
  if (!probe.ok) {
    const line = decisiveStderrLine(probe.stderr);
    return {
      available: false,
      loggedIn: false,
      detail: line || `auth probe failed (${probe.failure})`,
      authFailure: looksLikeAuthFailure(probe.stderr),
      durationSeconds: null
    };
  }
  const response = String(probe.payload?.response ?? "").trim();
  const duration = probe.payload?.duration_seconds ?? null;
  if (probe.payload?.status !== "SUCCESS" || !response) {
    const line = decisiveStderrLine(probe.stderr);
    return {
      available: false,
      loggedIn: false,
      detail:
        line ||
        `auth probe ended with status ${probe.payload?.status ?? "unknown"} and empty response`,
      authFailure: looksLikeAuthFailure(probe.stderr),
      durationSeconds: duration
    };
  }
  return {
    available: true,
    loggedIn: true,
    detail: `auth probe OK in ${Number(duration).toFixed(1)}s`,
    authFailure: false,
    durationSeconds: duration
  };
}

// Headless runs auto-deny any tool not covered by agy's own permission
// settings, and the tool-free auth probe cannot detect that. The probe passes
// only when the response contains a filesystem path (agy runs the command in
// its own scratch directory, so the current project path is not expected).
// A path can come back bare, quoted, backtick-wrapped, or bracketed, and on
// Windows it is a drive-letter path rather than a POSIX one. Only characters
// that cannot start a path are rejected before the match, so "and/or" and
// "24/7" still do not count as paths.
const FILESYSTEM_PATH = /(?:^|[\s'"`([<])(?:\/[^\s'"`)\]>]+|[A-Za-z]:[\\/][^\s'"`)\]>]*)/;

export function containsFilesystemPath(response) {
  return FILESYSTEM_PATH.test(String(response ?? ""));
}

function checkToolPermissions() {
  const probe = runProbe(TOOL_PROBE_PROMPT);
  const line = decisiveStderrLine(probe.stderr);
  if (!probe.ok) {
    return {
      available: false,
      detail: line || `tool probe failed (${probe.failure})`,
      durationSeconds: null
    };
  }
  const response = String(probe.payload?.response ?? "").trim();
  const duration = probe.payload?.duration_seconds ?? null;
  const hasPath = containsFilesystemPath(response);
  if (!response || !hasPath) {
    return {
      available: false,
      detail:
        line ||
        `tool probe returned ${response ? "no filesystem path" : "an empty response"} (status ${probe.payload?.status ?? "unknown"}); a tool permission was likely auto-denied`,
      durationSeconds: duration
    };
  }
  return {
    available: true,
    detail: `tool probe OK in ${Number(duration).toFixed(1)}s (ran in ${response.split(/\r?\n/, 1)[0]})`,
    durationSeconds: duration
  };
}

function reviewGateEnabled(cwd) {
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

function main() {
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const node = checkNode();
  const agy = checkAgy();

  const nextSteps = [];
  let auth = {
    available: false,
    loggedIn: false,
    detail: "not checked; agy is not installed",
    authFailure: false,
    durationSeconds: null
  };
  let toolPermissions = {
    available: false,
    detail: "not checked",
    durationSeconds: null
  };

  if (!agy.available) {
    nextSteps.push(
      "Install the Antigravity CLI (agy); see the official Antigravity documentation."
    );
  } else {
    auth = checkAuth();
    if (!auth.available) {
      toolPermissions.detail = "not checked; auth probe failed";
      if (auth.authFailure) {
        nextSteps.push(
          "Run `agy` once interactively in a terminal (type `! agy` in the prompt) to complete authentication, then rerun /agy:setup."
        );
      }
    } else {
      toolPermissions = checkToolPermissions();
      if (!toolPermissions.available) {
        nextSteps.push(
          "Headless delegation is blocked until agy's permission settings allow tools: add allow-rules under `permissions.allow` in ~/.gemini/antigravity-cli/settings.json (agy's denial message shows the exact rule syntax, for example `command(<target>)`) or use a permissive `toolPermission` there."
        );
      }
    }
  }

  const gateEnabled = reviewGateEnabled(cwd);
  const ready = agy.available && auth.available && toolPermissions.available;
  if (ready && !gateEnabled) {
    nextSteps.push(
      "Optional: run `/agy:setup gate on` to require a stop-time agy review before the session can end."
    );
  }

  delete auth.authFailure;
  const report = {
    ready,
    node,
    agy,
    auth,
    toolPermissions,
    reviewGateEnabled: gateEnabled,
    actionsTaken: [],
    nextSteps
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

// Only run the probes when invoked as a script; importing this module (for
// tests) must not spawn agy.
if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    main();
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ready: false,
          error: error instanceof Error ? error.message : String(error)
        },
        null,
        2
      )}\n`
    );
    process.exitCode = 1;
  }
}
