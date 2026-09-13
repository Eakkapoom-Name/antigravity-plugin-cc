import process from "node:process";

import { commandAvailable, runCommand } from "./process.mjs";

export const DEFAULT_PRINT_TIMEOUT = "9m";
export const DEFAULT_SPAWN_TIMEOUT_MS = 10 * 60 * 1000;

// argv is capped (2097152 bytes on the machine this was measured on), and a
// branch diff passed as `agy -p "<diff>"` blows past it and fails opaquely.
// stream-json takes the prompt on stdin instead, so size stops mattering.
//
// Verified against agy 1.2.2: the input line is
// {"event":"user","message":{"role":"user","content":"..."}}, and the terminal
// `result` event carries exactly the same object the documented
// `--output-format json` shape has, plus `error` when it failed.
export function buildStreamInput(prompt) {
  return `${JSON.stringify({
    event: "user",
    message: { role: "user", content: String(prompt ?? "") }
  })}\n`;
}

export function emptyResult(overrides = {}) {
  return {
    conversation_id: "",
    status: "ERROR",
    response: "",
    duration_seconds: 0,
    num_turns: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      thinking_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 0
    },
    ...overrides
  };
}

// Reduces the NDJSON event stream to the one result object the rest of the
// plugin already knows how to handle, so `agy-result-handling` does not have to
// learn a second shape.
export function normalizeStreamOutput(stdout) {
  let result = null;
  const events = [];

  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // A non-JSON line is noise on an otherwise usable stream; keep reading
      // rather than discarding a result that may still arrive.
      continue;
    }
    events.push(parsed.event);
    if (parsed.event === "result" && parsed.result && typeof parsed.result === "object") {
      result = parsed.result;
    }
  }

  if (!result) {
    return {
      result: emptyResult({ error: "agy produced no result event" }),
      events,
      ok: false
    };
  }
  return { result, events, ok: result.status === "SUCCESS" };
}

export function buildArgs(options = {}) {
  const args = ["--input-format", "stream-json", "--output-format", "stream-json", "-p="];

  // Routing and runtime controls, only when asked for. An unset flag is not the
  // same as a default value passed explicitly.
  if (options.conversationId) {
    args.push("--conversation", options.conversationId);
  } else if (options.continueConversation) {
    args.push("-c");
  }
  if (options.mode) {
    args.push("--mode", options.mode);
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.effort) {
    args.push("--effort", options.effort);
  }
  if (options.jsonSchema) {
    args.push("--json-schema", options.jsonSchema);
  }
  for (const dir of options.addDir ?? []) {
    args.push("--add-dir", dir);
  }
  args.push("--print-timeout", options.printTimeout ?? DEFAULT_PRINT_TIMEOUT);
  return args;
}

export function agyAvailable() {
  return commandAvailable("agy");
}

// The prompt goes in on stdin and never appears in argv at any layer.
export function runPrompt(prompt, options = {}) {
  const spawned = runCommand("agy", buildArgs(options), {
    cwd: options.cwd,
    encoding: "utf8",
    input: buildStreamInput(prompt),
    timeout: options.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024
  });

  const stderr = String(spawned.stderr ?? "").trim();

  if (spawned.error?.code === "ENOENT") {
    return { result: emptyResult({ error: "agy is not installed" }), stderr, ok: false, failure: "missing" };
  }
  if (spawned.error?.code === "ETIMEDOUT") {
    return { result: emptyResult({ error: "agy timed out" }), stderr, ok: false, failure: "timeout" };
  }

  const normalized = normalizeStreamOutput(spawned.stdout);
  return {
    result: normalized.result,
    events: normalized.events,
    stderr,
    ok: normalized.ok,
    failure: normalized.ok ? null : "failed"
  };
}

// Slash commands are answered by the CLI itself and are unavailable under
// `--input-format stream-json` (agy says so explicitly), so they keep the
// classic argv form. Their text is a fixed literal, so there is no size risk.
export function runSlashCommand(name, options = {}) {
  const spawned = runCommand(
    "agy",
    ["-p", `/${name}`, "--output-format", "json", "--print-timeout", options.printTimeout ?? "2m"],
    { cwd: options.cwd, encoding: "utf8", timeout: options.timeoutMs ?? 60 * 1000 }
  );

  const stderr = String(spawned.stderr ?? "").trim();
  if (spawned.error?.code === "ENOENT") {
    return { payload: null, stderr, ok: false, failure: "missing" };
  }
  try {
    return { payload: JSON.parse(spawned.stdout), stderr, ok: true, failure: null };
  } catch {
    return { payload: null, stderr, ok: false, failure: "invalid-json" };
  }
}
