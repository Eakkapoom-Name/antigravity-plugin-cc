// Scans text that is about to leave on stdin for agy: review diffs and the
// transfer brief. Hand-rolled patterns, no dependency, because the plugin has
// none and runs on Node 18. Only the shape of a hit is reported, never the
// value, so the report itself is safe to paste.

const PLACEHOLDER = /^(?:x{3,}|\*{3,}|changeme|change-me|<[^>]*>|\$\{[^}]*\}|your[-_a-z0-9]*|example[-_a-z0-9]*|placeholder)$/i;

// An environment-variable reference is not a secret, it is the mechanism a
// repository uses to avoid putting one in the text at all, so it is only an
// exclusion when it accounts for the ENTIRE captured value, not just its
// first few characters. Every branch below is anchored at both ends: a
// secret concatenated straight onto "process.env" with no separator, for
// example, still ends the string with characters the dotted or bracketed
// branches do not allow, so it still counts as a hit. The bare $NAME branch
// is further narrowed to the conventional shell-variable shape (upper-case
// letters, digits, underscores, starting with an upper-case letter or
// underscore):
// without that narrowing, anchoring alone would not help, because a real
// secret that happens to be pure mixed-case letters and digits after a
// leading $ is, by shape, indistinguishable from a variable name.
//
// A quoted lookup such as os.environ["NAME"] is excluded by accident, not by
// this regex: the value capture in PATTERNS stops at the first quote, so what
// reaches here is a fixed short prefix (os.environ[ is 11 characters, ENV[ is
// 4, and so on) that never reaches the 16-character minimum the
// secret-assignment pattern requires. This regex is never even evaluated for
// those lines; do not read its absence of a quote-aware branch as a gap.
const ENV_REFERENCE =
  /^(?:process\.env\.[A-Za-z0-9_]+|process\.env\[[A-Za-z0-9_]*\]|os\.environ\[[A-Za-z0-9_]*\]|os\.getenv\([A-Za-z0-9_]*\)|ENV\[[A-Za-z0-9_]*\]|\$[A-Z_][A-Z0-9_]*)$/;

const PATTERNS = [
  { kind: "aws-access-key-id", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    kind: "private-key-block",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/
  },
  { kind: "github-token", regex: /\bgh[opusr]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { kind: "slack-token", regex: /\bxox[abprs]-[A-Za-z0-9-]{20,}\b/ },
  { kind: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    // `scheme://user:password@host`, the connection-string leak that no
    // identifier word catches (DATABASE_URL, CONNECTION_STRING). The user
    // part stops at `:` and the password at `@`, so the two runs never
    // overlap; the scheme run is capped because an unbounded one, retried
    // from every word boundary of a long `a.a.a.` line, went quadratic when
    // measured. No length floor: `hunter2` is the shape being caught.
    kind: "credential-url",
    regex: /\b[a-z][a-z0-9+.-]{0,63}:\/\/[^\s\/:@]*:([^\s\/?#@]+)@/i,
    valueGroup: 1
  },
  {
    kind: "authorization-header",
    regex: /\b(?:Authorization\s*:\s*)?Bearer\s+([A-Za-z0-9._~+\/=-]{20,})/i,
    valueGroup: 1
  },
  {
    // The original leading `[A-Z0-9_]*` run was unbounded, so on a line of
    // repeated name characters (a crafted diff, not a real identifier) the
    // whole line is one `\b`-delimited word, and that run backtracked through
    // every split point within it looking for a keyword match, each retry
    // then also paying for the trailing run's own backtrack to the end of
    // the line: that pairing is what went quadratic (152.9 ms at 40k
    // characters, 10.0 ms at 10k, measured). The keyword check is now a
    // lookahead, and a single `[A-Z0-9_]+` run then consumes the whole name
    // (keyword included); any backtrack into that run fails in one step,
    // because the next character is another name character rather than
    // whitespace, `=` or `:`, so the scan is linear. Detection is unchanged,
    // with no length cap on either side of the keyword: fuzzed against the old
    // pattern on 400,000 lines with zero disagreement on match index, match
    // text, or captured value. Measured: under 20 ms on every adversarial
    // shape tried at 1,000,000 to 2,000,000 characters (`SECRET_` repeated,
    // 1,000,000 `A`s before `SECRET=`, `TOKEN :` and `TOKEN= ` repeated).
    kind: "secret-assignment",
    regex: /\b(?=[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY))[A-Z0-9_]+\s*[=:]\s*["']?([^\s"']{16,})["']?/,
    valueGroup: 1
  }
];

export const SECRET_KINDS = PATTERNS.map((pattern) => pattern.kind);

// The length of an unbounded quantifier starting at `index`: `*`, `+`, or a
// brace with an open or ranged upper end (`{2,}`, `{1,5}`). `?` and an exact
// `{3}` repeat a bounded number of times and cannot multiply backtracking.
function quantifierLengthAt(source, index) {
  const char = source[index];
  if (char === "*" || char === "+") {
    return 1;
  }
  if (char === "{") {
    const brace = source.slice(index).match(/^\{\d+,\d*\}/);
    return brace ? brace[0].length : 0;
  }
  return 0;
}

// Heuristic ReDoS guard for a CLI-supplied allow pattern: a quantifier
// applied to a group that itself contains a quantifier (`(a+)+`, `(a*)*`,
// `((ab)+)*`) is the shape that hangs `RegExp.test` on an ordinary long line,
// and a syntax check alone lets it through. This walks the source once,
// skipping escapes and character classes, and tracks per group whether a
// quantifier was seen inside it. It is a heuristic: an overlapping
// alternation such as `(a|aa)+` is not caught.
function hasNestedQuantifier(source) {
  const outerSaw = [];
  let sawQuantifier = false;
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (char === "[") {
      // JavaScript, not POSIX: `[]` is an empty class and `[^]` matches any
      // character, so the first unescaped `]` always closes the class.
      i += 1;
      if (source[i] === "^") {
        i += 1;
      }
      while (i < source.length && source[i] !== "]") {
        i += source[i] === "\\" ? 2 : 1;
      }
      i += 1;
      continue;
    }
    if (char === "(") {
      outerSaw.push(sawQuantifier);
      sawQuantifier = false;
      i += 1;
      continue;
    }
    if (char === ")") {
      const innerSaw = sawQuantifier;
      sawQuantifier = (outerSaw.pop() ?? false) || innerSaw;
      i += 1;
      const length = quantifierLengthAt(source, i);
      if (length > 0) {
        if (innerSaw) {
          return true;
        }
        sawQuantifier = true; // the quantified group counts for its enclosing group
        i += length;
      }
      continue;
    }
    const length = quantifierLengthAt(source, i);
    if (length > 0) {
      sawQuantifier = true;
      i += length;
      continue;
    }
    i += 1;
  }
  return false;
}

function compileAllow(allow) {
  return allow.map((source) => {
    let pattern;
    try {
      pattern = new RegExp(source);
    } catch (error) {
      throw new Error(`invalid allow pattern ${JSON.stringify(source)}: ${error.message}`);
    }
    if (hasNestedQuantifier(source)) {
      throw new Error(
        `invalid allow pattern ${JSON.stringify(source)}: a quantifier nested inside a quantified group can hang the scan; rewrite it without the nesting`
      );
    }
    return pattern;
  });
}

// A match with no valueGroup carries a fixed, non-secret prefix ahead of the
// secret (AKIA, ghp_, AIza, xox, the private-key banner), so showing its
// first six characters is a shape marker, not the value. A match whose
// valueGroup is the captured secret itself (authorization-header,
// secret-assignment) has no such prefix: showing any of it would be showing
// the value, which the spec forbids, so those report the length alone.
function sampleOf(value, { hideValue = false } = {}) {
  if (hideValue) {
    return `(${value.length} chars)`;
  }
  return `${value.slice(0, 6)}... (${value.length} chars)`;
}

export function scanForSecrets(text, { allow = [], diff = false } = {}) {
  const allowed = compileAllow(allow);
  const hits = [];
  const lines = String(text ?? "").split(/\r?\n/);

  // Diff bookkeeping: which file, and which line of that file, a content
  // line lands on. Without this a hit is reported at its offset into the raw
  // diff text, counting `diff --git`, `index` and `@@` lines, which matches
  // nothing a user can find in an editor. Every content line is scanned,
  // added, removed and context alike: the whole diff leaves on stdin, and the
  // commonest real case is the review of the commit that removes a key
  // someone committed, whose value sits in a `-` line. An added or context
  // hit is numbered in the new file, the one a user can open; a removed hit
  // has no new-file line, so it is numbered in the old file from the
  // `@@ -a,b` side and named by the `---` path (a deleted file has no `+++`
  // path), and `side` on the hit says which numbering applies.
  //
  // A `+++`/`---` line is only ever trusted as a real file header inside a
  // "header zone": the span from a `diff --git` line up to that file's first
  // `@@` hunk header. `diff --git` is emitted by git itself, never derived
  // from either version of the file's content, because every genuine content
  // line in a diff is prefixed with a single `+`, `-` or space marker
  // character; a file line that itself reads `diff --git ...` would still
  // render with that marker in front (`+diff --git ...`), never as the bare
  // line git's own header uses. So this line cannot be spoofed by content,
  // which is why it, not `---`/`+++` order, is the anchor: once a hunk has
  // started (the zone has closed), a content line is never again mistaken
  // for a header, however many literal `+` or `-` characters it starts with,
  // until the next `diff --git` reopens the zone for the following file.
  //
  // F59. Every header recognized above (`---`, `+++`, the header zone
  // itself) only opens once a `diff --git` line has been seen; a hand-rolled
  // diff missing that line never opens a header zone, so its `---`/`+++`
  // lines are never read as headers and `currentFile`/`oldFile` stay null for
  // the whole input, even though a bare `@@ -a,b +c,d @@` line outside a zone
  // still sets line numbers (see "Past the header zone" below). A hit is
  // still reported, just with `file: null`, since only `scanForSecrets`'s one
  // caller in this plugin (the diff-mode review commands) is reachable today,
  // and it always feeds real `git diff` output that carries the line. Worth
  // revisiting only if `scanForSecrets` is ever handed some other diff
  // source.
  //
  // `currentFile` and `oldFile` are set from the `+++ b/<path>` and
  // `--- a/<path>` headers seen inside the zone (both reset to null the
  // moment the zone opens, so a multi-file diff never carries a stale name
  // into the next file even for a hunk-less section such as a binary-file
  // notice). `newLine` and `oldLine` come from each hunk's `@@ -a,b +c,d @@`
  // header and are then walked forward one line at a time: an added line
  // advances `newLine`, a removed line `oldLine`, a context line both,
  // including a content line that happens to read `+++ ...` or `--- ...`.
  // Past the header zone both of those are content and are scanned: a `+++`
  // line is only a file header inside the zone, and an added line whose own
  // text starts with `++` (a C increment, a Markdown diff snippet) renders
  // the same way; `--` is a common line prefix too, a CLI flag or an SQL
  // comment. The `\ No newline at end of file` marker advances neither,
  // being a note about the line just shown rather than a line of its own.
  // Until a hunk header has actually been seen, there is no reliable line
  // number to report; a hit in that state falls back to the raw line offset
  // with no file, rather than reporting a number that looks right but is not.
  //
  // Nothing that leaves goes unscanned. The text after a hunk header's
  // closing `@@` is git's funcname heuristic at work: a line copied from the
  // file near the hunk (in a `.env`, often the very line holding the key),
  // so it is scanned and a hit is reported with side "hunk-header", at the
  // hunk's new-file start line (the old-file start for a deleted file). A
  // header-zone line that is none of the lines git emits there is scanned
  // too, side "header", at its raw offset into the diff; so is any line past
  // the zone that carries no `+`, `-`, space or `\` marker, side
  // "unrecognized". The `diff --git`, `---`, `+++` and hunk-header lines
  // themselves are not scanned, nor are the other extended header lines git
  // writes (index, mode, rename, copy, similarity, binary notice): they carry
  // paths and hashes, not file content.
  //
  // `diffHeaders` and `hunks` count the `diff --git` and hunk-header lines
  // recognized, so a caller can refuse a diff whose shape was not recognized
  // at all (color escapes in front of every line, an external diff driver's
  // free-form output) instead of trusting a scan that found nothing to read.
  const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;
  const GIT_HEADER_LINE =
    /^(?:index [0-9a-f]+\.\.[0-9a-f]+(?: [0-7]+)?|(?:old|new|deleted file|new file) mode [0-7]+|similarity index \d+%|dissimilarity index \d+%|(?:rename|copy) (?:from|to) .*|Binary files .* differ|GIT binary patch)$/;
  let currentFile = null;
  let oldFile = null;
  let newLine = null;
  let oldLine = null;
  let inHeaderZone = false;
  let diffHeaders = 0;
  let hunks = 0;

  function scanText(line, text, location) {
    if (allowed.some((pattern) => pattern.test(line))) {
      return;
    }
    for (const { kind, regex, valueGroup } of PATTERNS) {
      const match = text.match(regex);
      if (!match) {
        continue;
      }
      const value = valueGroup ? match[valueGroup] : match[0];
      if (valueGroup && (PLACEHOLDER.test(value) || ENV_REFERENCE.test(value))) {
        continue;
      }
      const hit = { line: location.line, kind, sample: sampleOf(value, { hideValue: Boolean(valueGroup) }) };
      if (diff) {
        hit.file = location.file;
        hit.side = location.side;
      }
      hits.push(hit);
      return;
    }
  }

  // Opens a hunk and scans the text git copied in after its closing `@@`.
  function openHunk(line, hunkHeader) {
    hunks += 1;
    oldLine = Number(hunkHeader[1]) - 1;
    newLine = Number(hunkHeader[2]) - 1;
    const trailer = hunkHeader[3];
    if (trailer.trim()) {
      const newStart = Number(hunkHeader[2]);
      scanText(line, trailer, {
        line: newStart > 0 ? newStart : Number(hunkHeader[1]),
        file: currentFile ?? oldFile,
        side: "hunk-header"
      });
    }
  }

  lines.forEach((line, index) => {
    let hitLine = index + 1;
    let hitFile = null;
    let side = null;

    if (diff) {
      if (line.startsWith("diff --git ")) {
        diffHeaders += 1;
        inHeaderZone = true;
        currentFile = null;
        oldFile = null;
        newLine = null;
        oldLine = null;
        return;
      }

      if (inHeaderZone) {
        const oldHeader = line.match(/^--- (?:a\/)?(.*)$/);
        if (oldHeader) {
          oldFile = oldHeader[1] === "/dev/null" ? null : oldHeader[1];
          return;
        }
        const fileHeader = line.match(/^\+\+\+ (?:b\/)?(.*)$/);
        if (fileHeader) {
          currentFile = fileHeader[1] === "/dev/null" ? null : fileHeader[1];
          return;
        }
        const hunkHeader = line.match(HUNK_HEADER);
        if (hunkHeader) {
          inHeaderZone = false;
          openHunk(line, hunkHeader);
          return;
        }
        // The other lines git writes before the first `@@` (mode, rename,
        // index lines, a binary-file notice) carry no line to advance and no
        // file content. Anything else is scanned as a safety net.
        if (!line || GIT_HEADER_LINE.test(line)) {
          return;
        }
        scanText(line, line, { line: hitLine, file: currentFile ?? oldFile, side: "header" });
        return;
      }

      // Past the header zone: a further `@@` opens this file's next hunk.
      const hunkHeader = line.match(HUNK_HEADER);
      if (hunkHeader) {
        openHunk(line, hunkHeader);
        return;
      }

      // The leading marker says which file(s) the line occupies a line of.
      // `\ No newline at end of file` neither advances a counter nor is
      // scanned; a line with no marker at all is scanned at its raw offset.
      const tracked = newLine !== null;
      if (line.startsWith("+")) {
        side = "added";
        newLine = tracked ? newLine + 1 : null;
      } else if (line.startsWith("-")) {
        side = "removed";
        oldLine = tracked ? oldLine + 1 : null;
      } else if (line.startsWith(" ")) {
        side = "context";
        newLine = tracked ? newLine + 1 : null;
        oldLine = tracked ? oldLine + 1 : null;
      } else if (!line || line.startsWith("\\")) {
        return;
      } else {
        scanText(line, line, { line: hitLine, file: null, side: "unrecognized" });
        return;
      }
      if (tracked) {
        hitLine = side === "removed" ? oldLine : newLine;
        hitFile = side === "removed" ? oldFile : currentFile;
      }
    }

    scanText(line, line, { line: hitLine, file: hitFile, side });
  });

  return diff ? { hits, diffHeaders, hunks } : { hits };
}
