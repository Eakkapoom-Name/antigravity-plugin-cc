import { runCommand } from "./process.mjs";

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

// Untracked files never appear in `git diff`, so an empty diff alone does not
// mean there is nothing to review.
export function untrackedFiles(cwd) {
  const result = git(["ls-files", "--others", "--exclude-standard"], cwd);
  if (result.status !== 0) {
    return [];
  }
  return String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
