import process from "node:process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
      deniedActions: [],
      ok: false
    };
  }
  const denied = deniedActions(result);
  return {
    result,
    events,
    deniedActions: denied,
    ok: result.status === "SUCCESS" && denied.length === 0
  };
}

// agy 1.2.4 reports a headless tool denial as `denied_actions` on the result,
// while keeping `status: "SUCCESS"`, exit code 0, and sometimes a non-empty
// `response` (issue #21). A run that was refused the one tool it needed did
// nothing, so it is a failure whatever the status says. Older agy versions have
// no such field, which reads as no denials, the same as before.
export function deniedActions(result) {
  const list = result?.denied_actions;
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .map((entry) => (entry && typeof entry === "object" ? entry.action : entry))
    .filter((action) => typeof action === "string" && action.length > 0);
}

// `--effort` is refused for some models before any model call is made (agy
// 1.2.4: `--effort is not supported for model "..."`, exit 1, status ERROR).
// Rerunning without the flag spends nothing, so callers can do that once.
export function effortRejected(result) {
  return /--effort is not supported for model/.test(String(result?.error ?? ""));
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
  let failure = null;
  if (!normalized.ok) {
    failure = normalized.deniedActions.length > 0 ? "denied" : "failed";
  }
  return {
    result: normalized.result,
    events: normalized.events,
    deniedActions: normalized.deniedActions,
    stderr,
    ok: normalized.ok,
    failure
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

// agy stops the conversation stream the moment it soft-denies a tool, so the
// model never sees the refusal and cannot adapt. That is not configurable. The
// conversation survives, though: a second turn on the same `conversation_id`
// keeps the task context, and stating the constraint is enough for the model to
// finish without the tool it was refused. Verified on agy 1.2.4, and it is the
// manual workaround the reporter of GitHub issue #21 was already doing by hand.
export function denialConstraintPrompt(actions) {
  const names = actions.length > 0 ? actions.join(", ") : "one or more tools";
  return [
    `Your previous turn was stopped because this environment refused these tools: ${names}.`,
    "The refusal is a fixed property of the environment, so retrying them will fail again.",
    "Continue the same task without them, using only what is already in this conversation.",
    "If the task cannot be finished without them, do not guess: say what you needed and which tool you needed it from, and stop."
  ].join(" ");
}

// One resume, never two. A resumed turn that is denied again is reported as the
// denial it is, because the second refusal means the constraint did not help and
// a third turn would spend quota to learn nothing.
//
// The runner is injectable so the recovery logic can be tested without spawning
// agy; callers pass nothing and get the real `runPrompt`.
export function runPromptWithDenialRecovery(prompt, options = {}, run = runPrompt) {
  const first = run(prompt, options);

  if (options.recoverFromDenial === false || first.failure !== "denied") {
    return first;
  }

  const conversationId = first.result?.conversation_id;
  if (!conversationId) {
    return first;
  }

  const { recoverFromDenial, conversationId: _ignored, continueConversation, ...rest } = options;
  const second = run(denialConstraintPrompt(first.deniedActions ?? []), {
    ...rest,
    conversationId
  });

  return {
    ...second,
    recovery: {
      attempted: true,
      recovered: second.ok === true,
      conversationId,
      deniedActions: first.deniedActions ?? [],
      firstResult: first.result
    }
  };
}

// Read-only commands (review, whisper, search, research, image) run agy with a
// temp directory as its whole workspace. F30 measured on 1.2.5 that
// run_command executes in the invoking cwd, so an agy that cannot see the
// repository cannot write into it, whatever the model decides. The price is
// that the reviewer cannot open files around a hunk: the prompt is the whole
// evidence. The stop gate, rescue and transfer never come through here.
export function runIsolated(prompt, options = {}, run = runPrompt) {
  let tmp;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-isolated-"));
  } catch (error) {
    return {
      result: emptyResult({ error: `could not create an isolated directory: ${error.message}` }),
      events: [],
      deniedActions: [],
      stderr: "",
      ok: false,
      failure: "isolation"
    };
  }

  const { cwd: _cwd, addDir: _addDir, mode: _mode, ...rest } = options;
  let out;
  let thrown;
  try {
    out = runPromptWithDenialRecovery(prompt, { ...rest, cwd: tmp, addDir: [tmp] }, run);
  } catch (error) {
    thrown = error;
  }

  let note;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (error) {
    note = `isolated directory not removed: ${tmp} (${error.message})`;
  }
  if (thrown) {
    throw thrown;
  }
  return note ? { ...out, note } : out;
}
