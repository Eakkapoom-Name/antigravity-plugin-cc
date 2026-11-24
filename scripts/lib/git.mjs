import { runCommand } from "./process.mjs";
import { scanForSecrets } from "./secrets.mjs";

// Diffs are collected here rather than by the model so the bytes go straight
// from git into agy's stdin. They are never interpolated into a command line,
// which is what made large diffs fail (F5) and what made `$(cat ...)` necessary
// before.
const MAX_DIFF_BUFFER = 64 * 1024 * 1024;

// Color is also switched off through config, ahead of the subcommand, as a
// second lock behind `--no-color` on the diff itself. `diff.suppressBlankEmpty`
// has no command-line flag: set, it prints a blank context line as an empty
// line instead of a lone space, and the scanner stops counting those lines.
// `core.fsmonitor=false` keeps a repository's own config from starting a
// filesystem-monitor command on every call.
function git(args, cwd) {
  return runCommand("git", ["-c", "color.ui=never", "-c", "color.diff=never", "-c", "diff.suppressBlankEmpty=false", "-c", "core.fsmonitor=false", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_DIFF_BUFFER
  });
}

const ORIGIN_REMOTE_PREFIX = "refs/remotes/origin/";

export function defaultBranch(cwd) {
  const remote = git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], cwd);
  if (remote.status === 0) {
    const ref = String(remote.stdout ?? "").trim();
    // The branch name is everything after the remote-tracking prefix, not
    // just the last path segment: a slashed name such as `release/2026`
    // otherwise loses everything but `2026`. A name starting with `-` is
    // refused: git's ref rules allow it, and a remote could set its default
    // branch to `--output=<path>`.
    if (ref.startsWith(ORIGIN_REMOTE_PREFIX)) {
      const name = ref.slice(ORIGIN_REMOTE_PREFIX.length);
      if (name && !name.startsWith("-")) {
        return name;
      }
    }
  }
  // No origin/HEAD (a fresh clone, or no remote). Fall back to whichever common
  // name actually exists rather than guessing one.
  for (const candidate of ["main", "master"]) {
    if (git(["rev-parse", "--verify", "--quiet", candidate], cwd).status === 0) {
      return candidate;
    }
  }
  return "main";
}

// Whether `ref` names a real commit in this repository. Used to tell a scope
// argument (a branch, tag or commit) from ordinary review focus text that
// happens to look like one (F125): `--end-of-options` keeps a token starting
// with `-` from being read as a `rev-parse` flag rather than a literal ref.
//
// Resolving is not enough on its own: a short hex English word (`dead`,
// `cafe`, `added`, `2024`) can resolve as an abbreviated commit id. So the
// token counts only when git names it as a ref (`--symbolic-full-name`
// prints the full name of a branch, tag or remote-tracking branch, and
// nothing for a bare commit id), or when it is at least 7 hex digits, and
// either way it must resolve to a commit.
const COMMIT_ID = /^[0-9a-f]{7,64}$/i;

export function refResolves(ref, cwd) {
  const commit = git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], cwd);
  if (commit.status !== 0) {
    return false;
  }
  const named = git(["rev-parse", "--symbolic-full-name", "--verify", "--quiet", "--end-of-options", ref], cwd);
  if (named.status === 0 && String(named.stdout ?? "").trim() !== "") {
    return true;
  }
  return COMMIT_ID.test(ref);
}

// The secret scanner reads git's own unified format, and the user's git
// config can change that format: `color.ui=always` puts an ANSI escape in
// front of every line (the scanner then recognizes no line at all), and
// `diff.external` or a textconv filter replaces the diff with a program's
// free-form output. `diff.noprefix`/`diff.mnemonicPrefix` change the path
// prefixes a hit is attributed by, and `diff.submodule=log` drops the
// `diff --git` header for a submodule change. Every diff pins all of these.
const PINNED_DIFF_FLAGS = [
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--submodule=short"
];

// `staged`, `branch`, a base ref, or the working tree. Returns the scope that
// was actually used, so the caller can report it rather than assume.
export function resolveScope(argument, cwd) {
  const scope = String(argument ?? "").trim();
  if (scope === "staged") {
    return { kind: "staged", args: ["diff", ...PINNED_DIFF_FLAGS, "--cached"], label: "staged changes" };
  }
  if (!scope) {
    return { kind: "working-tree", args: ["diff", ...PINNED_DIFF_FLAGS, "HEAD"], label: "working tree against HEAD" };
  }
  const base = scope === "branch" ? defaultBranch(cwd) : scope;
  return {
    kind: "branch",
    // `--end-of-options` so a base that starts with `-` is a revision, never
    // a `git diff` option such as `--output=<path>`.
    args: ["diff", ...PINNED_DIFF_FLAGS, "--end-of-options", `${base}...HEAD`],
    label: `branch against ${base}`
  };
}

export function collectDiff(scopeArgument, cwd) {
  const scope = resolveScope(scopeArgument, cwd);
  const result = git(scope.args, cwd);
  if (result.error?.code === "ENOENT") {
    return { ok: false, scope, diff: "", error: "git is not installed or not on PATH" };
  }
  if (result.status !== 0) {
    const detail = String(result.stderr ?? "").trim().split(/\r?\n/).slice(-1)[0];
    return { ok: false, scope, diff: "", error: detail || "git diff failed" };
  }
  const diff = String(result.stdout ?? "");
  return { ok: true, scope, diff, error: null, empty: diff.trim().length === 0 };
}

// What keeps a collected diff from leaving for agy, shared by /agy:review and
// the stop-review gate. Returns null for a diff that may be sent, otherwise
// `{ failure, ... }`: "unmerged" (with `paths`), "diff-shape", or "secrets"
// (with `hits`). Nothing leaves while a credential shape sits anywhere in the
// diff, removed and context lines included, since the whole diff goes on
// stdin. Blocking, not redacting: a redacted diff reviews differently.
export function screenDiff(diff, { allow = [] } = {}) {
  const scan = scanForSecrets(diff, { allow, diff: true });
  // During an unresolved merge `git diff --cached` prints `* Unmerged path
  // <file>` for each conflicted file and no diff section for it, so the file is
  // not in the text at all. Refused ahead of the shape test below, which would
  // otherwise send the user to their git config (only such lines, no `diff
  // --git` header) or, alongside ordinary sections, pass silently with the
  // conflicted file unreviewed.
  const unmerged = [...diff.matchAll(/^\* Unmerged path (.+?)\r?$/gm)].map((match) => match[1]);
  if (unmerged.length > 0) {
    const shown = unmerged.slice(0, 10).join(", ");
    const more = unmerged.length > 10 ? ` and ${unmerged.length - 10} more` : "";
    return {
      failure: "unmerged",
      paths: unmerged,
      error: `unresolved merge: ${shown}${more} ${unmerged.length === 1 ? "is" : "are"} unmerged, so the diff cannot cover ${unmerged.length === 1 ? "it" : "them"}. Resolve the merge (fix the conflict markers and stage the result), then rerun.`
    };
  }
  // Fail closed on a diff the scanner could not read as one: every real
  // `git diff` file section starts with a `diff --git` line (or, for a
  // combined diff, a `diff --cc` or `diff --combined` one), so a non-empty
  // diff with none of them is some other shape (color escapes, an external
  // driver's output) whose scan proves nothing. A section with no hunk (a
  // binary, mode-only or rename-only change) still has that line and still
  // passes.
  if (scan.diffHeaders === 0) {
    return {
      failure: "diff-shape",
      error:
        "diff shape not recognized, refusing to send it unscanned: git's output has no `diff --git`, `diff --cc` or `diff --combined` header the secret scanner can read. Check your git config for diff settings that change its output format."
    };
  }
  if (scan.hits.length > 0) {
    return { failure: "secrets", hits: scan.hits };
  }
  return null;
}

// Untracked files never appear in `git diff`, so an empty diff alone does not
// mean there is nothing to review.
export function untrackedFiles(cwd) {
  return pathList(git(["ls-files", "-z", "--others", "--exclude-standard"], cwd));
}

// Paths of tracked files that differ from HEAD, for when the diff itself is
// not sent.
export function changedFiles(cwd) {
  return pathList(git(["diff", "-z", "--name-only", "--no-ext-diff", "HEAD"], cwd));
}

// Paths staged in the index against HEAD, or against the empty tree when HEAD
// is unborn (no commit yet), which is when the gate needs them: such files are
// neither untracked nor in `git diff HEAD`.
export function stagedFiles(cwd) {
  return pathList(git(["diff", "-z", "--cached", "--name-only", "--no-ext-diff"], cwd));
}

function pathList(result) {
  if (result.status !== 0) {
    return [];
  }
  return String(result.stdout ?? "")
    .split("\0")
    .filter(Boolean);
}
