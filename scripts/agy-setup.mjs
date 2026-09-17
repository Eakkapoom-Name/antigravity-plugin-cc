#!/usr/bin/env node

// Readiness check for the agy plugin, mirroring the codex-companion setup
// contract: run every probe here and print one JSON report on stdout.
// Usage: node agy-setup.mjs [--json]   (output is always JSON)

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { deniedActions } from "./lib/agy.mjs";
import { resolveCommand, runCommand } from "./lib/process.mjs";
import { gateEnabled } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const AGY_PRINT_TIMEOUT = "2m";
const SPAWN_TIMEOUT_MS = 3 * 60 * 1000;

const AUTH_PROBE_PROMPT = "Reply with exactly: OK";
const TOOL_PROBE_PROMPT =
  "Use your terminal command tool to run 'pwd' and reply with exactly its output.";
// The read probe plants a nonce in a file inside the workspace root and asks
// agy to read it back, which is what every rescue does first. On agy 1.2.4
// reads inside the workspace directories (the cwd and any --add-dir) passed
// without any rule here, reads outside them were auto-denied, and issue #21
// saw an in-repository read denied; the probe reads where a rescue reads, so it
// fails on that setup and does not demand a read_file rule from setups that do
// not need one.
function readProbePrompt(filePath) {
  return `Use your file viewing tool to read the file ${filePath} and reply with exactly its first line. Do not use the terminal command tool.`;
}

function checkNode() {
  return { available: true, detail: process.version };
}

function checkAgy() {
  // `which` is Unix-only, and it was the reason this check could not work on
  // Windows at all. Resolving through PATH and PATHEXT covers both, and finds
  // the .cmd shim npm installs on Windows.
  const agyPath = resolveCommand("agy");
  const version = runCommand("agy", ["--version"], {
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
  // The setup probes stay on the argv transport: both prompts are short fixed
  // literals, so there is no size risk, and this path is the one under test.
  const result = runCommand(
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

function probeDuration(probe) {
  return probe.payload?.duration_seconds ?? null;
}

function deniedDetail(denied, line) {
  const names = denied.map((name) => `"${name}"`).join(", ");
  return line || `agy auto-denied the ${names} tool in headless mode (denied_actions on the result)`;
}

// Both evaluators are pure so the decision can be tested against captured agy
// payloads. `denied_actions` is decisive when present: agy 1.2.4 returns it with
// status SUCCESS and exit 0, and issue #21 showed the response can be non-empty
// at the same time, so the response is only a fallback for older agy versions
// that do not report denials in the JSON at all.
export function evaluateCommandProbe(probe) {
  const line = decisiveStderrLine(probe.stderr);
  if (!probe.ok) {
    return {
      available: false,
      detail: line || `tool probe failed (${probe.failure})`,
      deniedActions: [],
      durationSeconds: null
    };
  }
  const denied = deniedActions(probe.payload);
  const duration = probeDuration(probe);
  if (denied.length > 0) {
    return { available: false, detail: deniedDetail(denied, line), deniedActions: denied, durationSeconds: duration };
  }
  const response = String(probe.payload?.response ?? "").trim();
  if (!response || !containsFilesystemPath(response)) {
    return {
      available: false,
      detail:
        line ||
        `tool probe returned ${response ? "no filesystem path" : "an empty response"} (status ${probe.payload?.status ?? "unknown"}); a tool permission was likely auto-denied`,
      deniedActions: [],
      durationSeconds: duration
    };
  }
  return {
    available: true,
    detail: `command probe OK in ${Number(duration).toFixed(1)}s (ran in ${response.split(/\r?\n/, 1)[0]})`,
    deniedActions: [],
    durationSeconds: duration
  };
}

export function evaluateReadProbe(probe, nonce) {
  const line = decisiveStderrLine(probe.stderr);
  if (!probe.ok) {
    return {
      available: false,
      detail: line || `read probe failed (${probe.failure})`,
      deniedActions: [],
      durationSeconds: null
    };
  }
  const denied = deniedActions(probe.payload);
  const duration = probeDuration(probe);
  if (denied.length > 0) {
    return { available: false, detail: deniedDetail(denied, line), deniedActions: denied, durationSeconds: duration };
  }
  const response = String(probe.payload?.response ?? "");
  if (!nonce || !response.includes(nonce)) {
    return {
      available: false,
      detail:
        line ||
        `read probe did not return the planted file contents (status ${probe.payload?.status ?? "unknown"}); the read was likely auto-denied`,
      deniedActions: [],
      durationSeconds: duration
    };
  }
  return {
    available: true,
    detail: `read probe OK in ${Number(duration).toFixed(1)}s`,
    deniedActions: [],
    durationSeconds: duration
  };
}

// One remedy naming the rule for each tool that was actually denied. Every
// earlier version of this text said `command(...)` only, so a user whose reads
// were denied applied it and got a run that still read nothing (issue #21).
export function permissionNextStep(denied) {
  const names = new Set(denied);
  const rules = [];
  if (names.has("command") || names.size === 0) {
    rules.push(
      'Commands. Broad: {"permissions": {"allow": ["command(*)"]}}. Warning: `command(*)` lets agy run every terminal command headlessly, with no prompt. Narrow: allow only the targets you need, for example {"permissions": {"allow": ["command(git *)", "command(npm *)"]}}; the narrow form is unverified: on agy 1.2.4 a `command(pwd)` rule did not let the probe run `pwd`, so copy the exact target out of agy\'s own denial line, which shows the rule syntax it expects.'
    );
  }
  if (names.has("read_file") || names.size === 0) {
    rules.push(
      'File reads: {"permissions": {"allow": ["read_file(*)"]}}. `--mode accept-edits` covers writes only, not reads, and `--sandbox` does not change this. On agy 1.2.4, reads inside the workspace (the directory agy runs in, plus any --add-dir) passed without a rule and reads outside it were denied until `read_file(*)` was added; this probe read a file inside the workspace and was still denied, which is the case GitHub issue #21 reported.'
    );
  }
  for (const name of names) {
    if (name !== "command" && name !== "read_file") {
      rules.push(`The "${name}" tool: add a ${name}(<target>) rule; agy's denial line shows the exact form.`);
    }
  }
  return [
    `Headless delegation is blocked until agy's permission settings allow the tools it needs. agy cannot prompt in headless mode, so any tool not covered by a rule is auto-denied. Denied here: ${denied.length > 0 ? denied.join(", ") : "unknown"}. Fix it in ~/.gemini/antigravity-cli/settings.json.`,
    ...rules,
    "This edit has to be made by hand, by the user, in their own terminal, outside the agent session. In a Claude Code auto mode session the classifier denies the settings edit, `--dangerously-skip-permissions`, and even a read-only `agy -p \"/permissions\"` query, all as [Create Unsafe Agents]; do not attempt any of them from the session. The alternative is a permissive `toolPermission` value in the same file, which carries the same risk as `command(*)`."
  ].join(" ");
}

function checkToolPermissions(cwd) {
  const command = evaluateCommandProbe(runProbe(TOOL_PROBE_PROMPT));

  const nonce = `agy-setup-probe-${crypto.randomBytes(8).toString("hex")}`;
  // A dotfile in the workspace root, gone again before the report prints. The
  // temp directory is not a substitute: agy auto-approved reads under /tmp
  // even outside the workspace, so a probe there proves nothing about the
  // repository reads a rescue needs.
  let file = path.join(cwd, `.${nonce}.txt`);
  try {
    fs.writeFileSync(file, `${nonce}\n`, { flag: "wx" });
  } catch {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-setup-")), "probe.txt");
    fs.writeFileSync(file, `${nonce}\n`);
  }
  let read;
  try {
    read = evaluateReadProbe(runProbe(readProbePrompt(file)), nonce);
  } finally {
    fs.rmSync(file, { force: true });
    if (!file.startsWith(cwd)) {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  }

  const denied = [...new Set([...command.deniedActions, ...read.deniedActions])];
  const available = command.available && read.available;
  const failed = [command.available ? null : "command", read.available ? null : "read"].filter(Boolean);
  return {
    available,
    detail: available
      ? `${command.detail}; ${read.detail}`
      : `${failed.join(" and ")} probe failed: ${[command, read]
          .filter((probe) => !probe.available)
          .map((probe) => probe.detail)
          .join(" | ")}`,
    deniedActions: denied,
    command,
    read,
    durationSeconds:
      command.durationSeconds === null && read.durationSeconds === null
        ? null
        : Number(command.durationSeconds ?? 0) + Number(read.durationSeconds ?? 0)
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
    deniedActions: [],
    command: null,
    read: null,
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
      toolPermissions = checkToolPermissions(cwd);
      if (!toolPermissions.available) {
        nextSteps.push(permissionNextStep(toolPermissions.deniedActions)        );
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
