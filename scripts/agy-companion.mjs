#!/usr/bin/env node

// Deterministic half of the agy plugin. Commands that had their logic written
// out as prose for the model to follow now call a subcommand here instead, so
// the behaviour can be tested rather than only the wording.
//
// Deliberately not here: /agy:status, /agy:result, and /agy:cancel. This plugin
// keeps no job store by design; background runs are Claude Code background
// subagents, so those three orchestrate ListAgents, TaskOutput, and TaskStop
// and have no deterministic work to move.
//
// Usage: node agy-companion.mjs <subcommand> [arguments]

import dns from "node:dns";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  agyAvailable,
  effortRejected,
  runIsolated,
  runPrompt,
  runPromptWithDenialRecovery,
  runSlashCommand
} from "./lib/agy.mjs";
import { collectDiff, untrackedFiles } from "./lib/git.mjs";
import { resolveOutputPath } from "./lib/output-path.mjs";
import { gateEnabled, resolveStateFile, setGate } from "./lib/state.mjs";
import { renderPrompt } from "./lib/prompts.mjs";
import { scanForSecrets } from "./lib/secrets.mjs";
import { guardFetchUrl, looksLikeUrl } from "./lib/url-guard.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "schemas",
  "review-output.schema.json"
);

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function workspace() {
  return resolveWorkspaceRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
}

// Splits `[scope] [--allow-secret <regex>]... [focus words...]`. Only the
// first non-flag token can be a scope, and only when it looks like one;
// everything else is reviewer focus.
export function parseReviewArguments(argument) {
  const tokens = String(argument ?? "").trim().split(/\s+/).filter(Boolean);
  const allowSecret = [];
  const words = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === "--allow-secret") {
      const value = tokens[i + 1];
      if (value && !value.startsWith("--")) {
        allowSecret.push(value);
        i += 1;
      }
      continue;
    }
    words.push(tokens[i]);
  }
  if (words.length === 0) {
    return { scope: "", focus: "", allowSecret };
  }
  const first = words[0];
  const looksLikeScope =
    first === "staged" || first === "branch" || /^[A-Za-z0-9._\/-]+$/.test(first);
  if (looksLikeScope) {
    return { scope: first, focus: words.slice(1).join(" "), allowSecret };
  }
  return { scope: "", focus: words.join(" "), allowSecret };
}

// `run` is the low-level runner handed down to `runIsolated`, the same
// injectable third parameter `runIsolated` itself already defines (defaulting
// to the real `runPrompt`). Isolation is therefore not something a caller can
// opt out of by injecting a runner: whatever `run` is, it only ever sees the
// temp cwd `runIsolated` builds, never the repository path.
export function review({ argument, adversarial, run = runPrompt, available = agyAvailable }) {
  const cwd = workspace();
  if (!available()) {
    return { ok: false, error: "agy is not installed or not on PATH. Run /agy:setup." };
  }

  const { scope, focus, allowSecret } = parseReviewArguments(argument);
  const collected = collectDiff(scope, cwd);
  if (!collected.ok) {
    return { ok: false, error: collected.error, scope: collected.scope.label };
  }

  if (collected.empty) {
    const untracked = untrackedFiles(cwd);
    return {
      ok: true,
      empty: true,
      scope: collected.scope.label,
      untrackedFiles: untracked,
      note:
        untracked.length > 0
          ? "No diff in this scope, but there are untracked files; they are not part of a diff review."
          : "Nothing to review in this scope."
    };
  }

  // Nothing leaves for agy while a credential shape sits in the added lines.
  // Blocking, not redacting: a redacted diff reviews differently, and the user
  // is one --allow-secret away when the hit is a fixture.
  const scan = scanForSecrets(collected.diff, { allow: allowSecret, diff: true });
  if (scan.hits.length > 0) {
    return {
      ok: false,
      failure: "secrets",
      scope: collected.scope.label,
      hits: scan.hits,
      note:
        "The review did not run: the diff carries what looks like a credential. Redact it and rerun, or pass --allow-secret <regex> for a known false positive."
    };
  }

  const prompt = renderPrompt(adversarial ? "adversarial-review" : "review", {
    FOCUS: focus || "none",
    DIFF: collected.diff
  });

  // Isolated: agy gets a temp directory, not the repo, so a review cannot
  // write. The diff rides on stdin, so its size is irrelevant. A denial here
  // is worth one resume: the diff is already in the prompt.
  const out = runIsolated(
    prompt,
    {
      // Structured output is enforced by agy for the adversarial review rather
      // than merely requested in the prompt text.
      jsonSchema: adversarial && fs.existsSync(SCHEMA_PATH) ? SCHEMA_PATH : undefined
    },
    run
  );

  return {
    ok: out.ok,
    empty: false,
    scope: collected.scope.label,
    diffBytes: Buffer.byteLength(collected.diff, "utf8"),
    result: out.result,
    deniedActions: out.deniedActions,
    recovery: out.recovery,
    stderr: out.stderr,
    failure: out.failure,
    note: out.note
  };
}

// `transfer <brief-path> [--model <name>] [--effort <level>]`. The routing
// flags are split out here so they reach agy as flags rather than being
// mistaken for part of the path.
export function parseTransferArguments(argument) {
  const tokens = String(argument ?? "").trim().split(/\s+/).filter(Boolean);
  const parsed = { briefPath: "", model: undefined, effort: undefined };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--model" || token === "--effort") {
      const value = tokens[i + 1];
      if (value && !value.startsWith("--")) {
        parsed[token === "--model" ? "model" : "effort"] = value;
        i += 1;
      }
      continue;
    }
    if (!parsed.briefPath) {
      parsed.briefPath = token;
    }
  }
  return parsed;
}

// `run` is the low-level runner forwarded to `runPromptWithDenialRecovery`,
// the same injectable third parameter that function already defines
// (defaulting to the real `runPrompt`). `transfer` is not isolated: cwd and
// `addDir` stay on the repository, since a transfer is a real handoff into
// the workspace, not a read-only look at a diff. `available` is separately
// injectable so the secrets-block path can be tested without a real agy on
// PATH.
export function transfer({ argument, run = runPrompt, available = agyAvailable } = {}) {
  const cwd = workspace();
  if (!available()) {
    return { ok: false, error: "agy is not installed or not on PATH. Run /agy:setup." };
  }

  // The brief is written by the model, since it summarizes a conversation the
  // script cannot see. Only the path crosses the boundary, so the brief never
  // touches argv however long it is.
  const { briefPath, model, effort } = parseTransferArguments(argument);
  if (!briefPath) {
    return { ok: false, error: "transfer needs the path to a handoff brief file." };
  }
  let brief;
  try {
    brief = fs.readFileSync(briefPath, "utf8");
  } catch (error) {
    return { ok: false, error: `Could not read the handoff brief: ${error.message}` };
  }

  const scan = scanForSecrets(brief, { diff: false });
  if (scan.hits.length > 0) {
    return {
      ok: false,
      failure: "secrets",
      hits: scan.hits,
      note: "The handoff did not run: the brief carries what looks like a credential. Edit the brief and rerun."
    };
  }

  const prompt = renderPrompt("transfer", { BRIEF: brief });
  let out = runPromptWithDenialRecovery(prompt, { cwd, addDir: [cwd], model, effort }, run);
  // Some models refuse --effort before any model call is made, so the flag is
  // dropped and the run repeated once. That rejection spends no quota, so this
  // is the one retry the runtime contract allows.
  let effortDropped = false;
  if (effort && effortRejected(out.result)) {
    effortDropped = true;
    out = runPromptWithDenialRecovery(prompt, { cwd, addDir: [cwd], model }, run);
  }
  try {
    fs.rmSync(briefPath, { force: true });
  } catch {
    // A leftover brief in a scratch directory is not worth failing the handoff.
  }

  return {
    ok: out.ok,
    result: out.result,
    deniedActions: out.deniedActions,
    recovery: out.recovery,
    effortDropped,
    stderr: out.stderr,
    failure: out.failure
  };
}

// Shared by the read-only commands: `[--flag value]... <free text>`. Chosen
// rule for a flag given twice: an array only for a flag the caller declared in
// `repeatable`, and a refusal with a named reason for every other flag, rather
// than a last-one-wins that hides the mistake. A flag with no value is dropped
// rather than eating the next word.
//
// A repeated scalar flag used to become an array, which no consumer of this
// parser can take: `--model a --model b` put an array where `buildArgs` pushes
// a string into argv, and `spawnSync` then rejected the whole run with
// ERR_INVALID_ARG_TYPE, while `--out a --out b` silently became the path
// "a,b". `error` is present only when the parse refused, so a caller that
// checks it sees nothing new on the ordinary path.
export function parseFlaggedArguments(argument, names, repeatable = []) {
  const tokens = String(argument ?? "").trim().split(/\s+/).filter(Boolean);
  const flags = {};
  const rest = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!names.includes(token)) {
      rest.push(token);
      continue;
    }
    const value = tokens[i + 1];
    if (value === undefined || value.startsWith("--")) {
      continue;
    }
    const key = token.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    if (key in flags && !repeatable.includes(token)) {
      return {
        flags,
        rest: rest.join(" "),
        error: `${token} was given more than once; it takes a single value.`
      };
    }
    flags[key] = key in flags ? [].concat(flags[key], value) : value;
    i += 1;
  }
  return { flags, rest: rest.join(" ") };
}

// Some models refuse --effort before any model call is made; that refusal
// spends no quota, so the run repeats once without the flag. `run` is called
// directly here, so the caller decides what `run` does, including whether it
// wraps `runIsolated` around a lower-level runner.
export function runWithEffortFallback(prompt, options, run) {
  let out = run(prompt, options);
  let effortDropped = false;
  if (options.effort && effortRejected(out.result)) {
    effortDropped = true;
    const { effort: _effort, ...rest } = options;
    out = run(prompt, rest);
  }
  return { run: out, effortDropped };
}

function resultPayload(out, extra = {}) {
  return {
    ok: out.run.ok,
    result: out.run.result,
    deniedActions: out.run.deniedActions,
    recovery: out.run.recovery,
    effortDropped: out.effortDropped,
    stderr: out.run.stderr,
    failure: out.run.failure,
    note: out.run.note,
    ...extra
  };
}

const NOT_INSTALLED = { ok: false, error: "agy is not installed or not on PATH. Run /agy:setup." };

// Trailing prose punctuation that is never part of a URL's host, stripped
// from a matched token before it reaches the guard (search()'s query scan).
const TRAILING_QUERY_PUNCTUATION = /[).,;:!?'"\]>]+$/;

// `]` is itself in TRAILING_QUERY_PUNCTUATION, so a bracketed IPv6 literal's
// own closing bracket ("http://[2606:4700::1111]") would be stripped the
// same way trailing prose punctuation is, cutting the literal in half and
// leaving something that fails to parse at all. When the token contains
// "[", only punctuation after the matching "]" is a stripping candidate;
// everything through the bracket is left alone.
function stripTrailingQueryPunctuation(token) {
  const closeBracket = token.lastIndexOf("]");
  if (token.includes("[") && closeBracket !== -1) {
    return token.slice(0, closeBracket + 1) + token.slice(closeBracket + 1).replace(TRAILING_QUERY_PUNCTUATION, "");
  }
  return token.replace(TRAILING_QUERY_PUNCTUATION, "");
}

// Whether a matched token spelled out an authority ("http://host", or with
// backslashes, which the WHATWG parser treats the same way). Nothing about
// guarding a token is decided here: every token that parses to an http or
// https URL with a host is guarded either way. This only says whether the
// token may skip the DNS lookup for a bare single-label host, which is the
// one shape ("read about http:scheme handling") where a sentence mentioning
// a scheme would otherwise cost a resolver call. The slashed form is never
// prose in that way, so it keeps its lookup.
function hasAuthoritySlashes(token) {
  return /^https?:[/\\]{2}/i.test(token);
}

// Cap on the distinct hosts search()'s query scan will resolve for one
// query. Twenty is comfortably above any query that legitimately mentions a
// handful of URLs, while still bounding a single request to a small,
// constant number of DNS lookups no matter how many URL-shaped tokens the
// query contains.
const MAX_SCANNED_HOSTS = 20;

// `run` is the low-level runner forwarded into `runIsolated`, the same
// injectable third parameter `runIsolated` itself already defines (defaulting
// to the real `runPrompt`). whisper sends no repository text, so it does not
// scan for secrets and never touches the workspace; isolation is not
// something a caller can opt out of by injecting a runner.
export function whisper(argument, run = runPrompt, available = agyAvailable) {
  if (!available()) {
    return NOT_INSTALLED;
  }
  const { flags, rest, error } = parseFlaggedArguments(argument, ["--model", "--effort"]);
  if (error) {
    return { ok: false, error };
  }
  if (!rest) {
    return { ok: false, error: "whisper needs a prompt." };
  }
  const prompt = renderPrompt("whisper", { PROMPT: rest });
  const out = runWithEffortFallback(
    prompt,
    { model: flags.model, effort: flags.effort, printTimeout: "3m" },
    (p, options) => runIsolated(p, options, run)
  );
  return resultPayload(out);
}

// `run` is the low-level runner forwarded into `runIsolated`, the same
// injectable third parameter `runIsolated` itself already defines (defaulting
// to the real `runPrompt`). search sends no repository text, so it does not
// scan for secrets and never touches the workspace; isolation is not
// something a caller can opt out of by injecting a runner. A URL argument is
// checked by the guard before agy ever sees it; a rejected URL returns
// without spending a run.
export async function search(argument, run = runPrompt, available = agyAvailable, lookup) {
  if (!available()) {
    return NOT_INSTALLED;
  }
  const { flags, rest, error } = parseFlaggedArguments(argument, ["--model"]);
  if (error) {
    return { ok: false, error };
  }
  if (!rest) {
    return { ok: false, error: "search needs a query or a URL." };
  }

  let prompt;
  let mode;
  if (looksLikeUrl(rest)) {
    const guard = await guardFetchUrl(rest, lookup);
    if (!guard.ok) {
      return { ok: false, failure: "url-blocked", mode: "fetch", error: `fetch refused: ${guard.reason}` };
    }
    prompt = renderPrompt("fetch", { URL: guard.url.href });
    mode = "fetch";
  } else {
    // The whole argument is not a bare URL, but one word inside it can still
    // be one: the model reads that word the same way a fetch would, so a
    // search query does not get to smuggle a blocked URL past the guard just
    // because it arrived with other words around it. Scanning for the scheme
    // anywhere in the text, not only at the start of a whitespace-split
    // token, catches a URL wrapped in punctuation ("(http://127.0.0.1/)",
    // a quoted or angle-bracketed URL) that a per-token `looksLikeUrl` check
    // would miss because the token does not begin with the scheme. Requiring
    // only "https?:" and not "https?://" also catches the slash-free and
    // backslash forms `looksLikeUrl` now recognises for the fetch path
    // ("http:127.0.0.1", "http:\127.0.0.1"), the same bypass in the same
    // file: `\S+` already matches "//" when it is there, so nothing is lost
    // for the slashed form.
    //
    // Only http and https tokens are scanned here, unlike the fetch path
    // above, which checks whatever scheme the user named. On the fetch path
    // the user has named one single thing to fetch, so a non-http scheme is
    // a genuine refusal. In a query, URL-shaped text is just text on its way
    // to a model, and the only reason to inspect it at all is that agy might
    // decide to fetch it, which is only possible for an http or https token.
    // A mention of any other scheme ("what does ftp:// mean") is prose, not
    // a fetch target, and passes through untouched.
    //
    // Whether a matched token is guarded is decided by the URL parser, never
    // by a test on its text: the token is parsed once with `new URL`, and it
    // goes to the guard whenever that parse yields an http or https URL with
    // a host. That is the same parse `guardFetchUrl` and agy's own fetch
    // perform, so the scan and the guard cannot drift apart the way a
    // string-shape approximation of the parser repeatedly did (the
    // slash-free "http:/127.0.0.1", the backslash-bracket "http:\\[::1]",
    // and the dotless "http:localhost", "http:2130706433", "http:0x7f000001"
    // all parse to a blocked host while looking nothing like one as text).
    // A token the parser rejects names no host anyone could fetch, so it
    // stays prose. The cost that narrowing was meant to avoid, a sentence
    // mentioning a scheme paying for a DNS lookup, is handled inside the
    // guard instead, after the host is known: a bare single-label host that
    // is neither an IP literal nor a special-use name skips the lookup, and
    // only for the slash-free form.
    //
    // `\S+` also grabs trailing prose punctuation a URL is not part of
    // ("see https://example.com, then stop" would otherwise guard the host
    // "example.com,"), so it is stripped before the token reaches the
    // guard by stripTrailingQueryPunctuation, which knows to leave a
    // bracketed IPv6 literal's own closing bracket alone.
    //
    // Every token still gets the scheme and credentials checks: a query
    // naming the same host twice, once plainly and once with credentials
    // ("https://example.com/ and https://user:pw@example.com/x"), must
    // refuse the second mention even though the first already passed.
    // Deduping applies only to the DNS lookup itself, the one step that is
    // genuinely expensive and genuinely safe to skip once a host is known:
    // `cachedLookup` resolves a given host once per call to `search`, no
    // matter how many tokens name it, while `guardFetchUrl` still runs in
    // full for every token. A query naming more distinct hosts than
    // MAX_SCANNED_HOSTS is refused outright rather than resolving an
    // unbounded list one at a time.
    const realLookup = lookup ?? dns.promises.lookup;
    const lookupCache = new Map();
    const cachedLookup = async (host, options) => {
      const key = host.toLowerCase();
      if (lookupCache.has(key)) {
        return lookupCache.get(key);
      }
      const result = await realLookup(host, options);
      lookupCache.set(key, result);
      return result;
    };
    const seenHosts = new Set();
    for (const [rawToken] of rest.matchAll(/https?:\S+/gi)) {
      const token = stripTrailingQueryPunctuation(rawToken);
      let parsed;
      try {
        parsed = new URL(token);
      } catch {
        // A token the parser rejects ("what does http:// mean") names no
        // host that agy or anything else could fetch, so it is prose.
        continue;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        continue;
      }
      if (!parsed.hostname) {
        continue;
      }
      const hostKey = parsed.hostname.toLowerCase();
      if (!seenHosts.has(hostKey)) {
        if (seenHosts.size >= MAX_SCANNED_HOSTS) {
          return {
            ok: false,
            failure: "url-blocked",
            mode: "search",
            error: `search refused: query names more than ${MAX_SCANNED_HOSTS} distinct hosts to check`
          };
        }
        seenHosts.add(hostKey);
      }
      const guard = await guardFetchUrl(token, cachedLookup, {
        skipSingleLabelLookup: !hasAuthoritySlashes(token)
      });
      if (!guard.ok) {
        return { ok: false, failure: "url-blocked", mode: "search", error: `search refused: ${guard.reason}` };
      }
    }
    prompt = renderPrompt("search", { QUERY: rest });
    mode = "search";
  }

  const out = runIsolated(prompt, { model: flags.model, printTimeout: "3m" }, run);
  return resultPayload({ run: out, effortDropped: false }, { mode });
}

// `run` is the low-level runner forwarded into `runIsolated`, the same
// injectable third parameter `runIsolated` itself already defines (defaulting
// to the real `runPrompt`). research sends no repository text, so it does not
// scan for secrets and never touches the workspace; isolation is not
// something a caller can opt out of by injecting a runner. `--out` is
// resolved and validated before agy ever runs, so a bad path fails without
// spending a run; the file is written by the companion after a successful
// run, never by agy itself, which stays isolated throughout.
export function research(argument, run = runPrompt, available = agyAvailable, root = workspace()) {
  if (!available()) {
    return NOT_INSTALLED;
  }
  const { flags, rest, error } = parseFlaggedArguments(argument, ["--model", "--effort", "--out"]);
  if (error) {
    return { ok: false, error };
  }
  if (!rest) {
    return { ok: false, error: "research needs a topic." };
  }
  let target = null;
  if (flags.out !== undefined) {
    const resolved = resolveOutputPath(flags.out, root);
    if (!resolved.ok) {
      return { ok: false, error: `--out refused: ${resolved.reason}` };
    }
    target = resolved.path;
  }

  const prompt = renderPrompt("research", { TOPIC: rest });
  const out = runWithEffortFallback(
    prompt,
    { model: flags.model, effort: flags.effort, printTimeout: "9m" },
    (p, options) => runIsolated(p, options, run)
  );
  const payload = resultPayload(out);
  if (payload.ok && target) {
    const body = String(out.run.result?.response ?? "");
    try {
      fs.writeFileSync(target, body, { flag: "wx" });
      payload.outPath = target;
    } catch (error) {
      // The report was produced; only the write failed (a race on the target
      // name, or a parent that turned unwritable after resolveOutputPath
      // checked it). Losing `result.response` on top of that would waste the
      // whole run, so the payload keeps it and only the file write is
      // reported as failed.
      payload.outError = error.message;
    }
  }
  return payload;
}

export const DEFAULT_BRAIN_DIR = path.join(os.homedir(), ".gemini", "antigravity-cli", "brain");
const IMAGE_PATH = /((?:\/|[A-Za-z]:[\\/])[^\s"'`<>]+\.(?:png|jpe?g|webp))\b/i;

// agy names the file; the companion copies it. The name is shown to sit under
// agy's own artifacts directory, after symlinks, before any copy happens. Both
// sides go through realpathSync, never a string prefix on the raw text: a
// symlink named *.png inside brainDir can still point outside it, or at a
// non-image, and only resolving both paths first catches that.
export function extractImagePath(response, brainDir = DEFAULT_BRAIN_DIR) {
  const match = String(response ?? "").match(IMAGE_PATH);
  if (!match) {
    return { ok: false, reason: "the response names no image file" };
  }
  let real;
  let brain;
  try {
    real = fs.realpathSync(match[1]);
    brain = fs.realpathSync(brainDir);
  } catch (error) {
    return { ok: false, reason: `the named file is not readable: ${error.message}` };
  }
  if (!real.startsWith(brain + path.sep)) {
    return { ok: false, reason: `the named file ${real} is outside agy's artifacts directory` };
  }
  if (!IMAGE_PATH.test(real)) {
    return { ok: false, reason: `the named file ${real} does not resolve to an image` };
  }
  return { ok: true, path: real };
}

// `run` is the low-level runner forwarded into `runIsolated`, the same
// injectable third parameter `runIsolated` itself already defines (defaulting
// to the real `runPrompt`). image sends no repository text, so it does not
// scan for secrets and never touches the workspace; isolation is not
// something a caller can opt out of by injecting a runner. `--out` is
// resolved and validated before agy ever runs, so a bad path fails without
// spending a run; the copy is made by the companion after a successful run
// and a path that checks out under `brainDir`, never by agy itself, which
// stays isolated throughout.
export function image(argument, run = runPrompt, available = agyAvailable, root = workspace(), brainDir = DEFAULT_BRAIN_DIR) {
  if (!available()) {
    return NOT_INSTALLED;
  }
  const { flags, rest, error } = parseFlaggedArguments(argument, ["--model", "--effort", "--out"]);
  if (error) {
    return { ok: false, error };
  }
  if (!rest) {
    return { ok: false, error: "image needs a description." };
  }
  let target = null;
  if (flags.out !== undefined) {
    const resolved = resolveOutputPath(flags.out, root);
    if (!resolved.ok) {
      return { ok: false, error: `--out refused: ${resolved.reason}` };
    }
    target = resolved.path;
  }

  const prompt = renderPrompt("image", { DESCRIPTION: rest });
  const out = runWithEffortFallback(
    prompt,
    { model: flags.model, effort: flags.effort, printTimeout: "5m" },
    (p, options) => runIsolated(p, options, run)
  );
  const payload = resultPayload(out);
  if (!payload.ok) {
    return payload;
  }

  const found = extractImagePath(out.run.result?.response, brainDir);
  if (!found.ok) {
    return { ...payload, ok: false, failure: "no-image", error: found.reason };
  }
  payload.imagePath = found.path;
  if (target) {
    try {
      fs.copyFileSync(found.path, target, fs.constants.COPYFILE_EXCL);
      payload.outPath = target;
    } catch (error) {
      // The image was produced and passed the containment check; only the
      // copy failed (a race on the target name, or a parent that turned
      // unwritable after resolveOutputPath checked it). Losing `imagePath` on
      // top of that would waste the whole run, so the payload keeps it and
      // only the copy is reported as failed, mirroring research's --out
      // race handling.
      payload.outError = error.message;
    }
  }
  return payload;
}

function quota() {
  if (!agyAvailable()) {
    return { ok: false, error: "agy is not installed or not on PATH. Run /agy:setup." };
  }
  const run = runSlashCommand("usage");
  if (!run.ok) {
    return { ok: false, error: run.stderr || `the /usage call failed (${run.failure})` };
  }
  if (run.payload?.command?.name !== "usage") {
    return {
      ok: false,
      error:
        "This agy version predates the print-mode /usage command. Run `agy update`. Do not retry as a prompt; that would spend quota."
    };
  }

  const groups = [];
  for (const group of run.payload.command.data?.groups ?? []) {
    for (const bucket of group.buckets ?? []) {
      groups.push({
        group: group.name,
        window: bucket.window,
        remainingPercent: Math.round((bucket.remaining_fraction ?? 0) * 1000) / 10,
        resetTime: bucket.reset_time ?? null,
        low: (bucket.remaining_fraction ?? 0) < 0.2
      });
    }
  }
  return { ok: true, buckets: groups };
}

function gate(argument) {
  const cwd = workspace();
  const action = String(argument ?? "").trim().toLowerCase() || "status";
  if (action === "status") {
    // The state file is named here too, not only on a write: B3 moved it out of
    // the repository, so the path is the only way to tell which file this
    // workspace reads, and CLAUDE_PLUGIN_DATA is not always this plugin's.
    return {
      ok: true,
      action,
      enabled: gateEnabled(cwd),
      workspace: cwd,
      stateFile: resolveStateFile(cwd)
    };
  }
  if (action === "on" || action === "off") {
    const { enabled, file } = setGate(cwd, action === "on");
    return { ok: true, action, enabled, workspace: cwd, stateFile: file };
  }
  return { ok: false, error: `Unknown gate action: ${action}. Use on, off, or status.` };
}

const SUBCOMMANDS = {
  review: (argument) => review({ argument, adversarial: false }),
  "adversarial-review": (argument) => review({ argument, adversarial: true }),
  transfer: (argument) => transfer({ argument }),
  quota,
  gate,
  whisper: (argument) => whisper(argument),
  search: (argument) => search(argument),
  research: (argument) => research(argument),
  image: (argument) => image(argument)
};

export function main(argv) {
  const [subcommand, ...rest] = argv;
  const handler = SUBCOMMANDS[subcommand];
  if (!handler) {
    return {
      ok: false,
      error: `Unknown subcommand: ${subcommand ?? "<none>"}. Known: ${Object.keys(SUBCOMMANDS).join(", ")}.`
    };
  }
  return handler(rest.join(" "));
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  Promise.resolve()
    .then(() => main(process.argv.slice(2)))
    .then((payload) => {
      emit(payload);
      if (!payload.ok) {
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      emit({ ok: false, error: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
    });
}
