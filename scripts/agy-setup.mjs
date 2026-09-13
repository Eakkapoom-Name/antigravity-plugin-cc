#!/usr/bin/env node

// Readiness check for the agy plugin, mirroring the codex-companion setup
// contract: run every probe here and print one JSON report on stdout.
// Usage: node agy-setup.mjs [--json]   (output is always JSON)

import fs from "node:fs";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { gateEnabled } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

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

// A failed probe has three distinct causes and three different remedies, and
// the stderr line is the only evidence available. Reporting all of them as a
// login failure sends users to re-authenticate an account that is already fine.
//
// "environment" is the invoking shell blocking a syscall agy needs, most often
// a sandbox that refuses the loopback listener: agy prints
// `listen tcp 127.0.0.1:0: socket: operation not permitted`. Rerunning outside
// the restriction is the fix; the credentials are untouched.
//
// The patterns stay anchored to the syscall and network shape rather than
// matching a bare "permission denied", which agy also prints for tool denials.
const ENVIRONMENT_FAILURE =
  /listen tcp|socket: operation not permitted|bind:|EPERM|EACCES|EADDRNOTAVAIL|EAFNOSUPPORT/;
const AUTH_FAILURE = /auth|login|credential|unauthenticated|unauthorized/i;

export function classifyProbeFailure(stderr) {
  const text = String(stderr ?? "");
  // Environment wins over auth: a sandboxed run can fail a downstream auth step
  // as a symptom, and the sandbox is the cause worth reporting.
  if (ENVIRONMENT_FAILURE.test(text)) {
    return "environment";
  }
  if (AUTH_FAILURE.test(text)) {
    return "auth";
  }
  return "unknown";
}

function checkAuth() {
  const probe = runProbe(AUTH_PROBE_PROMPT);
  if (!probe.ok) {
    const line = decisiveStderrLine(probe.stderr);
    return {
      available: false,
      loggedIn: false,
      detail: line || `auth probe failed (${probe.failure})`,
      failureKind: classifyProbeFailure(probe.stderr),
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
      failureKind: classifyProbeFailure(probe.stderr),
      durationSeconds: duration
    };
  }
  return {
    available: true,
    loggedIn: true,
    detail: `auth probe OK in ${Number(duration).toFixed(1)}s`,
    failureKind: null,
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

function main() {
  // Same resolution the stop hook uses, so the two never disagree about which
  // workspace they are reporting on.
  const cwd = resolveWorkspaceRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const node = checkNode();
  const agy = checkAgy();

  const nextSteps = [];
  let auth = {
    available: false,
    loggedIn: false,
    detail: "not checked; agy is not installed",
    failureKind: null,
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
      // One remedy per cause. A non-ready report must never leave nextSteps
      // empty, so the unknown case still says what to do next.
      if (auth.failureKind === "environment") {
        nextSteps.push(
          "This is not a login failure. The shell that ran the probe blocked a syscall agy needs, usually a sandbox refusing its local loopback listener. Your credentials are untouched. Rerun /agy:setup from an unrestricted terminal, outside any sandbox, container, or seccomp wrapper."
        );
      } else if (auth.failureKind === "auth") {
        nextSteps.push(
          "Run `agy` once interactively in a terminal (type `! agy` in the prompt) to complete authentication, then rerun /agy:setup."
        );
      } else {
        nextSteps.push(
          "The auth probe failed without naming a cause. Run `agy -p \"Reply with exactly: OK\" --output-format json` in a terminal to see the full error, then rerun /agy:setup."
        );
      }
    } else {
      toolPermissions = checkToolPermissions();
      if (!toolPermissions.available) {
        nextSteps.push(
          "Headless delegation is blocked until agy's permission settings allow tools. agy cannot prompt in headless mode, so any tool not covered by a rule is auto-denied. Fix it in ~/.gemini/antigravity-cli/settings.json one of two ways. Broad: {\"permissions\": {\"allow\": [\"command(*)\"]}}. Warning: `command(*)` lets agy run every terminal command headlessly, with no prompt. Narrow: allow only the targets you need, for example {\"permissions\": {\"allow\": [\"command(git *)\", \"command(npm *)\"]}}; that narrower form is unverified on this agy version, so copy the exact target string out of agy's own denial line, which shows the rule syntax it expects. The alternative is a permissive `toolPermission` value in the same file, which carries the same risk as `command(*)`."
        );
      }
    }
  }

  const gateOn = gateEnabled(cwd);
  const ready = agy.available && auth.available && toolPermissions.available;
  if (ready && !gateOn) {
    nextSteps.push(
      "Optional: run `/agy:setup gate on` to require a stop-time agy review before the session can end."
    );
  }

  const report = {
    ready,
    node,
    agy,
    auth,
    toolPermissions,
    reviewGateEnabled: gateOn,
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
