// Decision logic for the stop-review gate, kept apart from the hook so it can
// be tested against the same run shapes runPrompt returns without spawning agy
// or reading hook input from stdin.

const OFF_HINT = "Run /agy:review manually or turn the gate off with /agy:setup gate off.";

export function parseReviewResponse(response) {
  const text = String(response ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason: `The stop-time agy review returned no output. ${OFF_HINT}`
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
    reason: `The stop-time agy review returned an unexpected answer. ${OFF_HINT}`
  };
}

// The rule that lifts each denial agy 1.2.4 reports. Anything else gets the
// generic form agy's own denial line uses.
function ruleFor(action) {
  if (action === "read_file") {
    return "read_file(*)";
  }
  if (action === "command") {
    return "command(*) or a narrower command(<target>)";
  }
  return `${action}(<target>)`;
}

// Judges one runPrompt result. A denied tool call is its own case: the gate
// fails closed either way, but "no output" or "unexpected answer" hid the one
// fact the user needed, which rule to add (F20, a follow-on to issue #21).
export function judgeReview(run) {
  if (run.failure === "missing") {
    return { ok: true, note: "agy is not installed; stop-review gate skipped. Run /agy:setup." };
  }
  if (run.failure === "timeout") {
    return {
      ok: false,
      reason: `The stop-time agy review timed out after 10 minutes. ${OFF_HINT}`
    };
  }
  const denied = run.deniedActions ?? [];
  if (run.failure === "denied" || denied.length > 0) {
    const names = denied.map((name) => `"${name}"`).join(", ");
    const rules = denied.map(ruleFor).join(" and ");
    return {
      ok: false,
      reason: `The stop-time agy review could not run: agy auto-denied its ${names} tool call in headless mode. Add ${rules} to permissions.allow in ~/.gemini/antigravity-cli/settings.json, by hand in your own terminal, then end the turn again. ${OFF_HINT}`
    };
  }
  if (!run.ok) {
    const status = run.result?.status ?? "unknown";
    const error = run.result?.error ? `: ${run.result.error}` : "";
    return {
      ok: false,
      reason: `The stop-time agy review ended with status ${status}${error}. ${OFF_HINT}`
    };
  }
  return parseReviewResponse(run.result?.response);
}
