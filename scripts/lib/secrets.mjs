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
// letters, digits, underscores, starting with a letter or underscore):
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
    kind: "authorization-header",
    regex: /\b(?:Authorization\s*:\s*)?Bearer\s+([A-Za-z0-9._~+\/=-]{20,})/i,
    valueGroup: 1
  },
  {
    kind: "secret-assignment",
    regex: /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY)[A-Z0-9_]*\s*[=:]\s*["']?([^\s"']{16,})["']?/,
    valueGroup: 1
  }
];

export const SECRET_KINDS = PATTERNS.map((pattern) => pattern.kind);

function compileAllow(allow) {
  return allow.map((source) => {
    try {
      return new RegExp(source);
    } catch (error) {
      throw new Error(`invalid allow pattern ${JSON.stringify(source)}: ${error.message}`);
    }
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

  // Diff bookkeeping: which file, and which line of that file's new content,
  // a `+` line lands on. Without this a hit is reported at its offset into
  // the raw diff text, counting `diff --git`, `index` and `@@` lines, which
  // matches nothing a user can find in an editor.
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
  // `currentFile` is set from the `+++ b/<path>` header seen inside the zone
  // (reset to null the moment the zone opens, so a multi-file diff never
  // carries a stale name into the next file even for a hunk-less section
  // such as a binary-file notice). `newLine` comes from each hunk's
  // `@@ -a,b +c,d @@` header and is then walked forward one line at a time:
  // every line that is not a removal advances it, including a content line
  // that happens to read `+++ ...` or `--- ...`, because it still occupies a
  // real line in the new file even though (per the existing, unchanged
  // contract) a line starting with `+++` is never itself scanned. Until a
  // hunk header has actually been seen, there is no reliable line number to
  // report; a hit in that state falls back to the raw line offset with no
  // file, rather than reporting a number that looks right but is not.
  let currentFile = null;
  let newLine = null;
  let inHeaderZone = false;

  lines.forEach((line, index) => {
    let hitLine = index + 1;
    let hitFile = null;

    if (diff) {
      if (line.startsWith("diff --git ")) {
        inHeaderZone = true;
        currentFile = null;
        newLine = null;
        return;
      }

      if (inHeaderZone) {
        if (line.startsWith("---")) {
          return; // old-file header; the path this function tracks comes from +++
        }
        const fileHeader = line.match(/^\+\+\+ (?:b\/)?(.*)$/);
        if (fileHeader) {
          currentFile = fileHeader[1] === "/dev/null" ? null : fileHeader[1];
          return;
        }
        const hunkHeader = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunkHeader) {
          inHeaderZone = false;
          newLine = Number(hunkHeader[1]) - 1;
        }
        // Any other line before the first `@@` (mode/rename/index lines, a
        // binary-file notice) carries no line to advance or scan.
        return;
      }

      // Past the header zone: a further `@@` opens this file's next hunk.
      const hunkHeader = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkHeader) {
        newLine = Number(hunkHeader[1]) - 1;
        return;
      }

      const isRemoved = line.startsWith("-");
      if (newLine !== null && !isRemoved) {
        newLine += 1;
      }
      const isAdded = line.startsWith("+") && !line.startsWith("+++");
      if (!isAdded) {
        return;
      }
      hitLine = newLine !== null ? newLine : index + 1;
      hitFile = newLine !== null ? currentFile : null;
    }

    if (allowed.some((pattern) => pattern.test(line))) {
      return;
    }
    for (const { kind, regex, valueGroup } of PATTERNS) {
      const match = line.match(regex);
      if (!match) {
        continue;
      }
      const value = valueGroup ? match[valueGroup] : match[0];
      if (valueGroup && (PLACEHOLDER.test(value) || ENV_REFERENCE.test(value))) {
        continue;
      }
      const hit = { line: hitLine, kind, sample: sampleOf(value, { hideValue: Boolean(valueGroup) }) };
      if (diff) {
        hit.file = hitFile;
      }
      hits.push(hit);
      break;
    }
  });

  return { hits };
}
