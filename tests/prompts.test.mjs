import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { placeholdersIn, promptPath, readPrompt, renderPrompt } from "../scripts/lib/prompts.mjs";
import { read } from "./helpers.mjs";

test("the stop-review gate prompt lives in prompts/, not inlined in the hook", () => {
  assert.ok(fs.existsSync(promptPath("stop-review-gate")));
  const hook = read("scripts/stop-review-gate-hook.mjs");
  assert.ok(
    !hook.includes("const PROMPT_TEMPLATE"),
    "the hook still carries an inlined template"
  );
  assert.match(hook, /renderPrompt\("stop-review-gate"/);
});

test("the prompt keeps the contract the hook depends on", () => {
  const template = readPrompt("stop-review-gate");
  // The hook parses the first line for these two verdicts; losing them from the
  // prompt would make every gated stop fail as an unexpected answer.
  assert.match(template, /ALLOW: <short reason>/);
  assert.match(template, /BLOCK: <short reason>/);
  assert.deepEqual(placeholdersIn(template).sort(), ["CLAUDE_RESPONSE_BLOCK", "REPO_ROOT"]);
});

test("rendering substitutes every placeholder and leaves none behind", () => {
  const rendered = renderPrompt("stop-review-gate", {
    REPO_ROOT: "/tmp/example-repo",
    CLAUDE_RESPONSE_BLOCK: "Previous Claude response:\nI changed one file."
  });
  assert.match(rendered, /\/tmp\/example-repo/);
  assert.match(rendered, /I changed one file\./);
  assert.ok(!/\{\{[A-Z0-9_]+\}\}/.test(rendered), "a placeholder survived into the prompt");
});

test("an empty response block renders without leaving a placeholder", () => {
  const rendered = renderPrompt("stop-review-gate", {
    REPO_ROOT: "/tmp/example-repo",
    CLAUDE_RESPONSE_BLOCK: ""
  });
  assert.ok(!rendered.includes("{{"));
});

test("a missing or unknown value is an error, not a silent template leak", () => {
  assert.throws(
    () => renderPrompt("stop-review-gate", { REPO_ROOT: "/tmp/x" }),
    /needs values for: CLAUDE_RESPONSE_BLOCK/
  );
  assert.throws(
    () =>
      renderPrompt("stop-review-gate", {
        REPO_ROOT: "/tmp/x",
        CLAUDE_RESPONSE_BLOCK: "",
        STALE_KEY: "x"
      }),
    /no placeholder for: STALE_KEY/
  );
});

test("placeholdersIn deduplicates and ignores non-placeholder braces", () => {
  assert.deepEqual(placeholdersIn("{{A}} {{A}} {{B}}"), ["A", "B"]);
  assert.deepEqual(placeholdersIn("{ not one } {{lowercase}} ${shell}"), []);
});

test("the whisper template takes the prompt and nothing else", () => {
  assert.deepEqual(placeholdersIn(readPrompt("whisper")), ["PROMPT"]);
  assert.ok(!renderPrompt("whisper", { PROMPT: "hi" }).includes("{{"));
});

test("the search and fetch templates take exactly their one placeholder", () => {
  assert.deepEqual(placeholdersIn(readPrompt("search")), ["QUERY"]);
  assert.deepEqual(placeholdersIn(readPrompt("fetch")), ["URL"]);
  assert.match(readPrompt("search"), /Sources:/);
});

test("the research template fixes the report section order", () => {
  const template = readPrompt("research");
  assert.deepEqual(placeholdersIn(template), ["TOPIC"]);
  const order = ["Summary", "Key findings", "Disagreements", "Caveats", "Sources"].map((h) => template.indexOf(h));
  assert.ok(order.every((i, n) => i > -1 && (n === 0 || i > order[n - 1])), `section order is ${order}`);
});
