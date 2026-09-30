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
  remainingRunBudget,
  runIsolated,
  runPrompt,
  runPromptWithDenialRecovery,
  runSlashCommand,
  sharedBudgetMs
} from "./lib/agy.mjs";
import { collectDiff, refResolves, untrackedFiles } from "./lib/git.mjs";
import { reconfirmContainment, resolveOutputPath } from "./lib/output-path.mjs";
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

// The one flag reader behind every command's parser. A token is a run of
// non-whitespace, except that the value right after a declared value flag may
// be wrapped in matching double or single quotes and then hold whitespace
// (`--out "my file.md"`); the quote must open at the start of the token and
// close before whitespace or the end. Only that position is unquoted: free
// text splits on whitespace alone, so a word that opens with an apostrophe
// ("the '90s") and a later one that ends with one ("rock n' roll") are two
// ordinary words, never one quoted token swallowing the flags between them.
// `raw` is the token as typed and is what free text is rebuilt from, so a
// quoted phrase in a prompt keeps its quotes; `text` is the unquoted form a
// flag value uses.
//
// `argument` is either that one string (the `"$ARGUMENTS"` commands, which
// arrive as a single argv entry) or an array of argv entries the shell has
// already split and unquoted (transfer), whose entries are taken whole: a
// brief path or a regex holding a space stays one token.
const WORD_TOKEN = /\S+/y;
const VALUE_TOKEN = /"([^"]*)"(?=\s|$)|'([^']*)'(?=\s|$)|\S+/y;
const WHITESPACE = /\s*/y;

function argumentTokens(argument) {
  if (Array.isArray(argument)) {
    const entries = argument.map((entry) => String(entry));
    let index = 0;
    return {
      peek: () => (index < entries.length ? { raw: entries[index], text: entries[index] } : undefined),
      take: () => {
        index += 1;
      }
    };
  }
  const source = String(argument ?? "");
  let position = 0;
  let next = 0;
  return {
    // `asValue` allows the quoted form; a token that is peeked but not taken
    // is read again by the next peek, so a `--flag` where a value was hoped
    // for is still read as that flag.
    peek(asValue = false) {
      WHITESPACE.lastIndex = position;
      WHITESPACE.exec(source);
      const pattern = asValue ? VALUE_TOKEN : WORD_TOKEN;
      pattern.lastIndex = WHITESPACE.lastIndex;
      const match = pattern.exec(source);
      if (!match) {
        return undefined;
      }
      next = pattern.lastIndex;
      return { raw: match[0], text: match[1] ?? match[2] ?? match[0] };
    },
    take() {
      position = next;
    }
  };
}

// `names` are the flags that take a value, `repeatable` (a subset of `names`)
// the ones that may be given more than once and then collect into an array,
// and `booleans` the valueless ones, which never eat the next word. A repeated
// flag that is not declared repeatable is a refusal with a named reason in
// `error`, rather than a last-one-wins that hides the mistake; so is a value
// that is empty or only whitespace (`--allow-secret ""`), since an empty
// `--allow-secret` pattern matches every line and would switch the secret
// scan off, and an empty `--model` would reach agy's argv as-is. A value flag
// with no value at all (last token, or followed by another `--flag`) is
// dropped. The result is `{ flags, positional }` with `positional` the
// leftover tokens, and `error` only when the read refused.
function readFlags(argument, names, repeatable = [], booleans = []) {
  const tokens = argumentTokens(argument);
  const flags = {};
  const positional = [];
  for (let token = tokens.peek(); token !== undefined; token = tokens.peek()) {
    tokens.take();
    const key = token.raw.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    if (booleans.includes(token.raw)) {
      flags[key] = true;
      continue;
    }
    if (!names.includes(token.raw)) {
      positional.push(token);
      continue;
    }
    const value = tokens.peek(true);
    if (value === undefined || value.raw.startsWith("--")) {
      continue;
    }
    tokens.take();
    if (value.text.trim() === "") {
      return { flags, positional, error: `${token.raw} was given an empty value.` };
    }
    if (key in flags && !repeatable.includes(token.raw)) {
      return {
        flags,
        positional,
        error: `${token.raw} was given more than once; it takes a single value.`
      };
    }
    flags[key] = key in flags ? [].concat(flags[key], value.text) : value.text;
  }
  return { flags, positional };
}

// Splits `[scope] [--allow-secret <regex>]... [focus words...]`. Only the
// first non-flag token can be a scope, and only when it is `staged`,
// `branch`, or a token git itself resolves to a real commit in `cwd` (see
// `refResolves`); otherwise the whole argument is focus and the scope is the
// working tree. The shape check runs first, so only a first word with
// characters no ref name can hold skips git; an ordinary sentence whose
// first word is plain letters still asks git. When such a word does not
// resolve, `scopeNote` says so, since a mistyped ref (`mian`) would
// otherwise pass silently as focus. `error` is present only when the flag
// read refused (an empty `--allow-secret`), and then no scope is looked up.
export function parseReviewArguments(argument, cwd) {
  const { flags, positional, error } = readFlags(argument, ["--allow-secret"], ["--allow-secret"]);
  const allowSecret = [].concat(flags.allowSecret ?? []);
  if (error) {
    return { scope: "", focus: "", allowSecret, error };
  }
  const words = positional.map((token) => token.raw);
  if (words.length === 0) {
    return { scope: "", focus: "", allowSecret };
  }
  const first = words[0];
  if (first === "staged" || first === "branch") {
    return { scope: first, focus: words.slice(1).join(" "), allowSecret };
  }
  const refShaped = /^[A-Za-z0-9._\/-]+$/.test(first) && !first.startsWith("-");
  if (refShaped && refResolves(first, cwd)) {
    return { scope: first, focus: words.slice(1).join(" "), allowSecret };
  }
  const parsed = { scope: "", focus: words.join(" "), allowSecret };
  if (refShaped) {
    parsed.scopeNote = `\`${first}\` is not a branch, tag or commit here; reviewed the working tree and kept it in the focus`;
  }
  return parsed;
}

// `run` is the low-level runner handed down to `runIsolated`, the same
// injectable third parameter `runIsolated` itself already defines (defaulting
// to the real `runPrompt`). Isolation is therefore not something a caller can
// opt out of by injecting a runner: whatever `run` is, it only ever sees the
// temp cwd `runIsolated` builds, never the repository path. `collect` is the
// diff collector, injectable the same way so a test can hand in a diff shape
// real git no longer produces once its format is pinned.
export function review({ argument, adversarial, run = runPrompt, available = agyAvailable, collect = collectDiff }) {
  const cwd = workspace();
  if (!available()) {
    return { ok: false, error: "agy is not installed or not on PATH. Run /agy:setup." };
  }

  const { scope, focus, allowSecret, scopeNote, error } = parseReviewArguments(argument, cwd);
  if (error) {
    return { ok: false, error };
  }
  // A first word that looked like a ref but was not one is kept in the focus;
  // every payload from here on says so, for the command to relay.
  const withScopeNote = (payload) => (scopeNote ? { ...payload, scopeNote } : payload);
  const collected = collect(scope, cwd);
  if (!collected.ok) {
    return withScopeNote({ ok: false, error: collected.error, scope: collected.scope.label });
  }

  if (collected.empty) {
    const untracked = untrackedFiles(cwd);
    return withScopeNote({
      ok: true,
      empty: true,
      scope: collected.scope.label,
      untrackedFiles: untracked,
      note:
        untracked.length > 0
          ? "No diff in this scope, but there are untracked files; they are not part of a diff review."
          : "Nothing to review in this scope."
    });
  }

  // Nothing leaves for agy while a credential shape sits anywhere in the diff,
  // removed and context lines included, since the whole diff goes on stdin.
  // Blocking, not redacting: a redacted diff reviews differently, and the user
  // is one --allow-secret away when the hit is a fixture.
  const scan = scanForSecrets(collected.diff, { allow: allowSecret, diff: true });
  // During an unresolved merge `git diff --cached` prints `* Unmerged path
  // <file>` for each conflicted file and no diff section for it, so the file is
  // not in the text at all. Refused ahead of the shape test below, which would
  // otherwise send the user to their git config (only such lines, no `diff
  // --git` header) or, alongside ordinary sections, pass silently with the
  // conflicted file unreviewed.
  const unmerged = [...collected.diff.matchAll(/^\* Unmerged path (.+?)\r?$/gm)].map((match) => match[1]);
  if (unmerged.length > 0) {
    const shown = unmerged.slice(0, 10).join(", ");
    const more = unmerged.length > 10 ? ` and ${unmerged.length - 10} more` : "";
    return withScopeNote({
      ok: false,
      failure: "unmerged",
      scope: collected.scope.label,
      paths: unmerged,
      error: `unresolved merge: ${shown}${more} ${unmerged.length === 1 ? "is" : "are"} unmerged, so the diff cannot cover ${unmerged.length === 1 ? "it" : "them"}. Resolve the merge (fix the conflict markers and stage the result), then rerun.`
    });
  }
  // Fail closed on a diff the scanner could not read as one: every real
  // `git diff` file section starts with a `diff --git` line (or, for a
  // combined diff, a `diff --cc` or `diff --combined` one), so a non-empty
  // diff with none of them is some other shape (color escapes, an external
  // driver's output) whose scan proves nothing. A section with no hunk (a
  // binary, mode-only or rename-only change) still has that line and still
  // passes.
  if (scan.diffHeaders === 0) {
    return withScopeNote({
      ok: false,
      failure: "diff-shape",
      scope: collected.scope.label,
      error:
        "diff shape not recognized, refusing to send it unscanned: git's output has no `diff --git`, `diff --cc` or `diff --combined` header the secret scanner can read. Check your git config for diff settings that change its output format."
    });
  }
  if (scan.hits.length > 0) {
    return withScopeNote({
      ok: false,
      failure: "secrets",
      scope: collected.scope.label,
      hits: scan.hits,
      note:
        "The review did not run: the diff carries what looks like a credential. Redact it and rerun, or pass --allow-secret <regex> for a known false positive."
    });
  }

  const prompt = renderPrompt(adversarial ? "adversarial-review" : "review", {
    FOCUS: focus || "none",
    DIFF: collected.diff
  });

  // Isolated: agy gets a temp directory, not the repo, as its cwd; whether it
  // can still reach the project by absolute path is up to agy's own
  // toolPermission setting. The diff rides on stdin, so its size is irrelevant. A denial here
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

  return withScopeNote({
    ok: out.ok,
    empty: false,
    scope: collected.scope.label,
    diffBytes: Buffer.byteLength(collected.diff, "utf8"),
    result: out.result,
    deniedActions: out.deniedActions,
    recovery: out.recovery,
    stderr: out.stderr,
    failure: out.failure,
    agyError: out.agyError,
    note: out.note
  });
}

// `transfer <brief-path> [--model <name>] [--effort <level>] [--allow-secret
// <regex>]...`. The routing flags are split out here so they reach agy as
// flags rather than being mistaken for part of the path. `argument` is the
// argv array `main` hands over, each entry already split and unquoted by the
// shell, so a path or a regex holding a space stays whole; a string is read
// like any other command's argument. `allowSecret` is present only when the
// flag was given, and `error` only when the read refused (a repeated
// `--model` or `--effort`, or an empty value).
export function parseTransferArguments(argument) {
  const { flags, positional, error } = readFlags(
    argument,
    ["--model", "--effort", "--allow-secret"],
    ["--allow-secret"]
  );
  const parsed = { briefPath: positional[0]?.text ?? "", model: flags.model, effort: flags.effort };
  if (flags.allowSecret !== undefined) {
    parsed.allowSecret = [].concat(flags.allowSecret);
  }
  if (error) {
    parsed.error = error;
  }
  return parsed;
}

// `run` is the low-level runner forwarded to `runPromptWithDenialRecovery`,
// the same injectable third parameter that function already defines
// (defaulting to the real `runPrompt`). `transfer` is not isolated: cwd and
// `addDir` stay on the repository, since a transfer is a real handoff into
// the workspace, not a read-only look at a diff. `available` is separately
// injectable so the secrets-block path can be tested without a real agy on
// PATH. `now` is the injectable clock the effort rerun measures its budget with.
export function transfer({ argument, run = runPrompt, available = agyAvailable, now } = {}) {
  const cwd = workspace();
  if (!available()) {
    return { ok: false, error: "agy is not installed or not on PATH. Run /agy:setup." };
  }

  // The brief is written by the model, since it summarizes a conversation the
  // script cannot see. Only the path crosses the boundary, so the brief never
  // touches argv however long it is.
  const { briefPath, model, effort, allowSecret, error } = parseTransferArguments(argument);
  if (error) {
    return { ok: false, error };
  }
  if (!briefPath) {
    return { ok: false, error: "transfer needs the path to a handoff brief file." };
  }
  let brief;
  try {
    brief = fs.readFileSync(briefPath, "utf8");
  } catch (error) {
    return { ok: false, error: `Could not read the handoff brief: ${error.message}` };
  }

  const scan = scanForSecrets(brief, { allow: allowSecret, diff: false });
  if (scan.hits.length > 0) {
    return {
      ok: false,
      failure: "secrets",
      hits: scan.hits,
      note: "The handoff did not run: the brief carries what looks like a credential. Edit the brief and rerun, or pass --allow-secret <regex> for a known false positive."
    };
  }

  const prompt = renderPrompt("transfer", { BRIEF: brief });
  // Some models refuse --effort before any model call is made, so the flag is
  // dropped and the run repeated once (F134: inside the first run's budget).
  // That rejection spends no quota, so this is the one retry the runtime
  // contract allows.
  const { run: out, effortDropped, effortRetry } = runWithEffortFallback(
    prompt,
    { cwd, addDir: [cwd], model, effort },
    (p, options) => runPromptWithDenialRecovery(p, options, run, now),
    now
  );
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
    effortRetry,
    stderr: out.stderr,
    failure: out.failure,
    agyError: out.agyError
  };
}

// Shared by the read-only commands: `[--flag value]... <free text>`. Chosen
// rule for a flag given twice: an array only for a flag the caller declared in
// `repeatable`, and a refusal with a named reason for every other flag, rather
// than a last-one-wins that hides the mistake. A flag with no value is dropped
// rather than eating the next word, and a flag declared in `booleans` takes no
// value at all (`--verbose hello` keeps `hello` as free text).
//
// A repeated scalar flag used to become an array, which no consumer of this
// parser can take: `--model a --model b` put an array where `buildArgs` pushes
// a string into argv, and `spawnSync` then rejected the whole run with
// ERR_INVALID_ARG_TYPE, while `--out a --out b` silently became the path
// "a,b". `error` is present only when the parse refused, so a caller that
// checks it sees nothing new on the ordinary path.
export function parseFlaggedArguments(argument, names, repeatable = [], booleans = []) {
  const { flags, positional, error } = readFlags(argument, names, repeatable, booleans);
  const parsed = { flags, rest: positional.map((token) => token.raw).join(" ") };
  if (error) {
    parsed.error = error;
  }
  return parsed;
}

// Some models refuse --effort before any model call is made; that refusal
// spends no quota, so the run repeats once without the flag. `run` is called
// directly here, so the caller decides what `run` does, including whether it
// wraps `runIsolated` around a lower-level runner.
//
// The rerun shares the first attempt's time budget rather than starting a fresh
// one (F134), the way the denial resume does (F104): it gets what the first
// attempt left, print timeout and spawn timeout both, through the same helpers.
// When that is under the minimum the rerun is skipped, `effortDropped` stays
// false, the rejected first attempt is the result, and `effortRetry` reports
// `{ attempted: false, skipped: "insufficient-time", remainingMs }`. `now` is
// the injectable clock (monotonic milliseconds).
export function runWithEffortFallback(prompt, options, run, now = () => performance.now()) {
  const budgetMs = sharedBudgetMs(options);
  const startedAt = now();
  const out = run(prompt, options);
  if (!(options.effort && effortRejected(out.result))) {
    return { run: out, effortDropped: false };
  }
  const left = remainingRunBudget(budgetMs, now() - startedAt);
  if (left.skipped) {
    return {
      run: out,
      effortDropped: false,
      effortRetry: { attempted: false, skipped: "insufficient-time", remainingMs: left.remainingMs }
    };
  }
  const { effort: _effort, ...rest } = options;
  const rerun = run(prompt, { ...rest, printTimeout: left.printTimeout, timeoutMs: left.timeoutMs });
  return { run: rerun, effortDropped: true };
}

function resultPayload(out, extra = {}) {
  return {
    ok: out.run.ok,
    result: out.run.result,
    deniedActions: out.run.deniedActions,
    recovery: out.run.recovery,
    effortDropped: out.effortDropped,
    effortRetry: out.effortRetry,
    stderr: out.run.stderr,
    failure: out.run.failure,
    agyError: out.run.agyError,
    note: out.run.note,
    ...extra
  };
}

const NOT_INSTALLED = { ok: false, error: "agy is not installed or not on PATH. Run /agy:setup." };

// The prompt-only commands send the user's argument text to agy as it stands,
// and Claude can invoke them with a file excerpt in it, so it goes through
// the same scan as a review diff or a transfer brief before `renderPrompt`.
// Returns the refusal payload on a hit and null otherwise. `--allow-secret`
// admits a known false positive exactly as it does for review.
function secretsRefusal(command, text, flags) {
  const scan = scanForSecrets(text, { allow: [].concat(flags.allowSecret ?? []), diff: false });
  if (scan.hits.length === 0) {
    return null;
  }
  return {
    ok: false,
    failure: "secrets",
    hits: scan.hits,
    note: `The ${command} did not run: the argument carries what looks like a credential. Redact it and rerun, or pass --allow-secret <regex> for a known false positive.`
  };
}

// Trailing prose punctuation that is never part of a URL's host, stripped
// from a matched token before it reaches the guard (search()'s query scan).
// A possessive "'s" glued to a bare host ("http://127.0.0.1's page") is
// prose in the same way: no DNS name holds an apostrophe, so leaving it on
// turned an address refusal into a resolver failure on "127.0.0.1's". A
// query typed with a curly apostrophe ("127.0.0.1’s") is the same
// possessive, just the character autocorrect and most phone keyboards
// actually produce, so it is stripped alongside the ASCII form.
const TRAILING_QUERY_PUNCTUATION = /(?:'s|’s)?[).,;:!?'"\]>]*$/i;

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
// backslashes, which the WHATWG parser treats the same way, and with any
// number of them: "http:/host" and "http:\host" parse the same host as the
// two-slash form). Nothing about guarding a token is decided here: every
// token that parses to an http or https URL with a host is guarded either
// way. This only says whether the token may skip the DNS lookup for a bare
// single-label host, which is the one shape ("read about http:scheme
// handling") where a sentence mentioning a scheme would otherwise cost a
// resolver call. The slashed form is never prose in that way, so it keeps
// its lookup.
function hasAuthoritySlashes(token) {
  return /^https?:[/\\]+/i.test(token);
}

// The other half of that test: a prose mention of a scheme is bare, "http:"
// followed by one word and nothing else. A token that goes on to name a
// path, a port, a query or a fragment after the label ("http:intranet/admin",
// "http:intranet:8080") is spelled like a fetch target, so it keeps its
// lookup too, and only DNS gets to say whether the dotless name is local.
function isBareSchemeMention(token) {
  return !hasAuthoritySlashes(token) && /^https?:[^/\\:?#]+$/i.test(token);
}

// A refused slash-free token whose host came from a bare decimal number
// ("http:443"): the URL parser read the number as an IPv4 address (443 is
// 0.0.1.187), which the refusal names, though the user never typed one.
// The refusal stands, since "http:443" and "http:2130706433" (loopback) are
// the same token shape, but the reason says what happened and how to get
// past it. Returns the digits, or null when the host came from elsewhere.
function bareNumberAfterScheme(token) {
  const match = /^https?:(\d+)(?=[/?#:]|$)/i.exec(token);
  return match ? match[1] : null;
}

// Cap on the distinct hosts search()'s query scan will resolve for one
// query. Twenty is comfortably above any query that legitimately mentions a
// handful of URLs, while still bounding a single request to a small,
// constant number of DNS lookups no matter how many URL-shaped tokens the
// query contains. Only a host the guard actually sends to the resolver counts:
// a bare scheme mention ("http:word") and an IP literal are never looked up,
// so any number of them can sit in a query without using the cap up.
const MAX_SCANNED_HOSTS = 20;

// `run` is the low-level runner forwarded into `runIsolated`, the same
// injectable third parameter `runIsolated` itself already defines (defaulting
// to the real `runPrompt`). whisper sends no repository text and never
// touches the workspace, but its argument text is scanned for secrets first;
// isolation is not something a caller can opt out of by injecting a runner.
// `now` is the injectable clock the effort rerun measures its budget with.
export function whisper(argument, run = runPrompt, available = agyAvailable, now = () => performance.now()) {
  if (!available()) {
    return NOT_INSTALLED;
  }
  const { flags, rest, error } = parseFlaggedArguments(argument, ["--model", "--effort", "--allow-secret"], ["--allow-secret"]);
  if (error) {
    return { ok: false, error };
  }
  if (!rest) {
    return { ok: false, error: "whisper needs a prompt." };
  }
  const refused = secretsRefusal("whisper", rest, flags);
  if (refused) {
    return refused;
  }
  const prompt = renderPrompt("whisper", { PROMPT: rest });
  const out = runWithEffortFallback(
    prompt,
    { model: flags.model, effort: flags.effort, printTimeout: "3m" },
    (p, options) => runIsolated(p, options, run, now),
    now
  );
  return resultPayload(out);
}

// `run` is the low-level runner forwarded into `runIsolated`, the same
// injectable third parameter `runIsolated` itself already defines (defaulting
// to the real `runPrompt`). search sends no repository text and never touches
// the workspace, but its argument text is scanned for secrets before anything
// else looks at it: the URL guard resolves every host it checks, so a token
// sitting in a hostname (`https://ghp_<token>.evil.example/`) would otherwise
// reach the resolver, and whoever runs that domain's DNS, before the refusal.
// Isolation is not something a caller can opt out of by injecting a runner. A
// URL argument is checked by the guard before agy ever sees it; a rejected
// URL returns without spending a run.
export async function search(argument, run = runPrompt, available = agyAvailable, lookup) {
  if (!available()) {
    return NOT_INSTALLED;
  }
  const { flags, rest, error } = parseFlaggedArguments(argument, ["--model", "--allow-secret"], ["--allow-secret"]);
  if (error) {
    return { ok: false, error };
  }
  if (!rest) {
    return { ok: false, error: "search needs a query or a URL." };
  }

  // `looksLikeUrl` is a test on the text alone, no lookup, so taking the mode
  // from it here costs nothing and lets the refusal say which mode it was.
  const mode = looksLikeUrl(rest) ? "fetch" : "search";
  const refused = secretsRefusal("search", rest, flags);
  if (refused) {
    return { ...refused, mode };
  }

  let prompt;
  if (mode === "fetch") {
    const guard = await guardFetchUrl(rest, lookup);
    if (!guard.ok) {
      return { ok: false, failure: "url-blocked", mode: "fetch", error: `fetch refused: ${guard.reason}` };
    }
    prompt = renderPrompt("fetch", { URL: guard.url.href });
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
    // only for a bare scheme mention (isBareSchemeMention: no slash after
    // the scheme, nothing after the label).
    //
    // `\S+` also grabs trailing prose punctuation a URL is not part of
    // ("see https://example.com, then stop" would otherwise guard the host
    // "example.com,"), so it is stripped before the token reaches the
    // guard by stripTrailingQueryPunctuation, which knows to leave a
    // bracketed IPv6 literal's own closing bracket alone and takes a
    // possessive "'s" the same way.
    //
    // Every token still gets the scheme and credentials checks: a query
    // naming the same host twice, once plainly and once with a user name
    // ("https://example.com/ and https://user@example.com/x"), must refuse
    // the second mention even though the first already passed. (A user name
    // with a password, "user:pw@", never gets this far: the secret scan
    // above refuses it as a credential-url first.)
    // Deduping applies only to the DNS lookup itself, the one step that is
    // genuinely expensive and genuinely safe to skip once a host is known:
    // `cachedLookup` resolves a given host once per call to `search`, no
    // matter how many tokens name it, while `guardFetchUrl` still runs in
    // full for every token. A query that needs more than MAX_SCANNED_HOSTS
    // distinct hosts resolved is refused outright rather than resolving an
    // unbounded list one at a time; the count is taken inside `cachedLookup`,
    // so a host the guard never looks up (a dotless scheme mention, an IP
    // literal) does not use any of it.
    const realLookup = lookup ?? dns.promises.lookup;
    const lookupCache = new Map();
    let capExceeded = false;
    const cachedLookup = async (host, options) => {
      const key = host.toLowerCase();
      if (lookupCache.has(key)) {
        return lookupCache.get(key);
      }
      if (lookupCache.size >= MAX_SCANNED_HOSTS) {
        // The guard turns this throw into a plain refusal reason; the flag
        // is what tells the loop below it was the cap.
        capExceeded = true;
        throw new Error(`more than ${MAX_SCANNED_HOSTS} distinct hosts to resolve`);
      }
      const result = await realLookup(host, options);
      lookupCache.set(key, result);
      return result;
    };
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
      const guard = await guardFetchUrl(token, cachedLookup, {
        skipSingleLabelLookup: isBareSchemeMention(token)
      });
      if (capExceeded) {
        return {
          ok: false,
          failure: "url-blocked",
          mode: "search",
          error: `search refused: query names more than ${MAX_SCANNED_HOSTS} distinct hosts to check`
        };
      }
      if (!guard.ok) {
        const number = bareNumberAfterScheme(token);
        const hint = number === null
          ? ""
          : ` (the number ${number} after "${parsed.protocol}" was read as an address; if you meant a port or a count, reword the query)`;
        return { ok: false, failure: "url-blocked", mode: "search", error: `search refused: ${guard.reason}${hint}` };
      }
    }
    prompt = renderPrompt("search", { QUERY: rest });
  }

  const out = runIsolated(prompt, { model: flags.model, printTimeout: "3m" }, run);
  return resultPayload({ run: out, effortDropped: false }, { mode });
}

// `run` is the low-level runner forwarded into `runIsolated`, the same
// injectable third parameter `runIsolated` itself already defines (defaulting
// to the real `runPrompt`). research sends no repository text and never
// touches the workspace, but its argument text is scanned for secrets first;
// isolation is not something a caller can opt out of by injecting a runner. `--out` is
// resolved and validated before agy ever runs, so a bad path fails without
// spending a run; the file is written by the companion after a successful
// run, never by agy itself, which stays isolated throughout. `now` is the
// injectable clock the effort rerun measures its budget with.
export function research(argument, run = runPrompt, available = agyAvailable, root = workspace(), now = () => performance.now()) {
  if (!available()) {
    return NOT_INSTALLED;
  }
  const { flags, rest, error } = parseFlaggedArguments(
    argument,
    ["--model", "--effort", "--out", "--allow-secret"],
    ["--allow-secret"]
  );
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

  const refused = secretsRefusal("research", rest, flags);
  if (refused) {
    return refused;
  }
  const prompt = renderPrompt("research", { TOPIC: rest });
  const out = runWithEffortFallback(
    prompt,
    { model: flags.model, effort: flags.effort, printTimeout: "8m" },
    (p, options) => runIsolated(p, options, run, now),
    now
  );
  const payload = resultPayload(out);
  if (payload.ok && target) {
    const body = String(out.run.result?.response ?? "");
    if (body.trim() === "") {
      // F82. An `ok: true` run that produced nothing would otherwise still
      // create the file (the write below is unconditional on `body`, empty
      // string included) and report `outPath` as if a report had been
      // written. The user is told the file exists and finds it empty, and
      // because the write uses "wx", the name is now occupied for a rerun.
      // Skip the write and say why instead of creating that file.
      payload.outError = "the response was empty; no --out file was written.";
    } else {
      // F70. resolveOutputPath already proved `target`'s parent was inside
      // the workspace when --out was first checked, but the run above can
      // take minutes, and a parent directory swapped for a symlink in that
      // window is not caught by the "wx" write, which follows the symlink
      // the same way the earlier check's realpathSync did. Re-check
      // immediately before writing.
      const recheck = reconfirmContainment(target, root);
      if (!recheck.ok) {
        payload.outError = `--out refused: ${recheck.reason}`;
      } else {
        try {
          fs.writeFileSync(target, body, { flag: "wx" });
          payload.outPath = target;
        } catch (error) {
          // The report was produced; only the write failed (a race on the
          // target name, or a parent that turned unwritable after the
          // checks above). Losing `result.response` on top of that would
          // waste the whole run, so the payload keeps it and only the file
          // write is reported as failed.
          payload.outError = error.message;
        }
      }
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
// to the real `runPrompt`). image sends no repository text and never touches
// the workspace, but its argument text is scanned for secrets first;
// isolation is not something a caller can opt out of by injecting a runner. `--out` is
// resolved and validated before agy ever runs, so a bad path fails without
// spending a run; the copy is made by the companion after a successful run
// and a path that checks out under `brainDir`, never by agy itself, which
// stays isolated throughout. `now` is the injectable clock the effort rerun
// measures its budget with.
export function image(argument, run = runPrompt, available = agyAvailable, root = workspace(), brainDir = DEFAULT_BRAIN_DIR, now = () => performance.now()) {
  if (!available()) {
    return NOT_INSTALLED;
  }
  const { flags, rest, error } = parseFlaggedArguments(
    argument,
    ["--model", "--effort", "--out", "--allow-secret"],
    ["--allow-secret"]
  );
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

  const refused = secretsRefusal("image", rest, flags);
  if (refused) {
    return refused;
  }
  const prompt = renderPrompt("image", { DESCRIPTION: rest });
  const out = runWithEffortFallback(
    prompt,
    { model: flags.model, effort: flags.effort, printTimeout: "5m" },
    (p, options) => runIsolated(p, options, run, now),
    now
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
    // F70. Same re-check as research's, on the copy instead of the write:
    // resolveOutputPath's containment check ran before the run above, which
    // can take minutes; a parent swapped for a symlink to somewhere else in
    // that window is not caught by COPYFILE_EXCL, which follows the symlink
    // the same way "wx" does.
    const recheck = reconfirmContainment(target, root);
    if (!recheck.ok) {
      payload.outError = `--out refused: ${recheck.reason}`;
    } else {
      try {
        fs.copyFileSync(found.path, target, fs.constants.COPYFILE_EXCL);
        payload.outPath = target;
      } catch (error) {
        // The image was produced and passed both containment checks; only
        // the copy failed (a race on the target name, or a parent that
        // turned unwritable after the checks above). Losing `imagePath` on
        // top of that would waste the whole run, so the payload keeps it
        // and only the copy is reported as failed, mirroring research's
        // --out race handling.
        payload.outError = error.message;
      }
      if (payload.outPath) {
        // Its own try: the copy already succeeded, so a failure to read the
        // copied file back only skips the advisory warning and must never
        // turn that success into an outError.
        try {
          const warning = extensionMismatchWarning(target);
          if (warning) {
            payload.warning = warning;
          }
        } catch {
          // No warning: the check is advisory.
        }
      }
    }
  }
  return payload;
}

const EXTENSION_IMAGE_FORMATS = { ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".webp": "webp" };

// Sniffs the file's magic bytes, never its filename: a symlink or a renamed
// file could claim any extension, so only the bytes say what format it
// really is. image() calls it on the copied file at --out, the bytes
// actually written there.
function sniffImageFormat(filePath) {
  const buf = Buffer.alloc(12);
  let bytesRead = 0;
  const fd = fs.openSync(filePath, "r");
  try {
    bytesRead = fs.readSync(fd, buf, 0, 12, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (bytesRead >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "png";
  }
  if (bytesRead >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "jpeg";
  }
  if (bytesRead >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return "webp";
  }
  return null;
}

// F73. resolveOutputPath is content-agnostic by design: it only checks the
// path, never the bytes. agy can return any of the three formats regardless
// of the extension the user typed on --out, and the copy carries the bytes
// across unchanged, so a mismatch would otherwise be silent. This only
// warns; it never refuses or renames the copy.
function extensionMismatchWarning(targetPath) {
  const actual = sniffImageFormat(targetPath);
  const wantedExt = path.extname(targetPath).toLowerCase();
  const wanted = EXTENSION_IMAGE_FORMATS[wantedExt];
  if (actual && !wanted) {
    // F105. An extension that names no format the copy could be (`.txt`,
    // `.gif`, none at all) is a mismatch too, only a different kind.
    return wantedExt
      ? `the copied image's bytes look like ${actual}, but the ${wantedExt} extension --out named is not one of png, jpg, jpeg or webp`
      : `the copied image's bytes look like ${actual}, but the --out name has no extension (png, jpg, jpeg or webp expected)`;
  }
  if (!actual || actual === wanted) {
    return null;
  }
  return `the copied image's bytes look like ${actual}, not the ${wantedExt.slice(1)} extension --out named`;
}

// F102. The failure kind is always named, even when agy wrote stderr: a
// timeout that also left partial stderr behind would otherwise read as
// whatever that stderr says, with nothing saying the call timed out.
export function quotaRunError(run) {
  const reason = run.stderr || "the /usage call failed";
  return run.failure ? `${reason} (${run.failure})` : reason;
}

function quota() {
  if (!agyAvailable()) {
    return { ok: false, error: "agy is not installed or not on PATH. Run /agy:setup." };
  }
  const run = runSlashCommand("usage");
  if (!run.ok) {
    return { ok: false, error: quotaRunError(run) };
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
  // transfer alone takes the argv entries as they are: its command doc passes
  // the brief path and each flag value as separate shell words, which a join
  // and re-split would break apart at every space. The other commands pass
  // `"$ARGUMENTS"`, one entry, and read it with the string tokenizer.
  transfer: (argv) => transfer({ argument: argv }),
  quota,
  gate,
  whisper: (argument) => whisper(argument),
  search: (argument) => search(argument),
  research: (argument) => research(argument),
  image: (argument) => image(argument)
};

const PRE_SPLIT_SUBCOMMANDS = new Set(["transfer"]);

// `handlers` defaults to the real table and is injectable only so a test can
// see what argument shape each subcommand receives without running agy.
export function main(argv, handlers = SUBCOMMANDS) {
  const [subcommand, ...rest] = argv;
  const handler = handlers[subcommand];
  if (!handler) {
    return {
      ok: false,
      error: `Unknown subcommand: ${subcommand ?? "<none>"}. Known: ${Object.keys(handlers).join(", ")}.`
    };
  }
  return handler(PRE_SPLIT_SUBCOMMANDS.has(subcommand) ? rest : rest.join(" "));
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
