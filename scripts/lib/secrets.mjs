// Scans text that is about to leave on stdin for agy: review diffs and the
// transfer brief. Hand-rolled patterns, no dependency, because the plugin has
// none and runs on Node 18. Only the shape of a hit is reported, never the
// value, so the report itself is safe to paste.

// A quoted value may hold spaces, so the word-shaped branches take them too
// (`"your password here"`, `"change me please"`, `"xxxxxxxx xxxxxxxx"`). Each
// is one character-class run, not a repeated group: a repeated group on a
// 16 MB value would overflow V8's backtrack stack.
const PLACEHOLDER =
  /^(?:x[x ]{2,}|\*[* ]{2,}|change[- ]?me[- a-z]*|<[^>]*>|\$\{[^}]*\}|your[-_a-z0-9 ]*|example[-_a-z0-9 ]*|placeholder)$/i;

// An environment-variable reference is not a secret, it is how a repository
// keeps one out of the text, so it only excludes a hit when it is the ENTIRE
// captured value. Every branch is anchored at both ends: a secret run straight
// onto "process.env" still hits. The bare $NAME branch is limited to the
// shell-variable shape (upper case, digits, underscores) because a mixed-case
// secret after a leading $ is, by shape, a variable name (F55, F56 are the
// accepted costs). A `${{ secrets.X }}` CI template reference is excluded for
// the same reason; it needs its own branch because the quoted-value capture
// keeps spaces. A quoted lookup such as os.environ["NAME"] is excluded by
// accident: the capture stops at the first quote and never reaches the
// 16-character floor, so this regex never sees it (pinned by a test).
const ENV_REFERENCE =
  /^(?:process\.env\.[A-Za-z0-9_]+|process\.env\[[A-Za-z0-9_]*\]|os\.environ\[[A-Za-z0-9_]*\]|os\.getenv\([A-Za-z0-9_]*\)|ENV\[[A-Za-z0-9_]*\]|\$[A-Z_][A-Z0-9_]*|\$\{\{[^}]*\}\})$/;

// An unquoted value that reads as code rather than data: a call or subscript
// (`generate_token_for(user)`, `response.json()[`), a dotted member path
// (`self.token_store.value,`, `this.store.token;`), or a snake_case or
// CONSTANT_CASE identifier (`private_key_password`, `_PASSWORD_DEFAULT`),
// each optionally inside an opening bracket or before closing punctuation.
// Only the lower-case name branch of secret-assignment consults it, because
// lower-case names are what ordinary code assigns to. The cost is a secret of
// that shape written unquoted under a lower-case name (`password:
// my.pass.word.1234`, `api_key: abc_def_ghi_jkl_mno`), which passes. Base64
// and hex are not dotted and rarely hold `_`, and a URL fails the leading
// identifier run at `:`. Each branch is anchored, plain runs over disjoint
// classes with no repeated group (the same stack reason as PLACEHOLDER), and
// the `_` is required by a lookahead so the runs never split the value two
// ways: linear on any length.
const CODE_VALUE =
  /^[([{]?[A-Za-z_$][\w$.]*[([]|^[([{]?[A-Za-z_$][\w$]*\.[\w$.]*[,;:)\]}]*$|^(?=[a-z0-9_]*_)[a-z_][a-z0-9_]*[,;:)\]}]*$|^(?=[A-Z0-9_]*_)[A-Z_][A-Z0-9_]*[,;:)\]}]*$/;

// A length floor is written `X{16}X*`, never `X{16,}`: the same language, but
// V8 pushes a backtrack entry per character of an open `{n,}` run with a large
// `n`, and a 16 MB run of one overflowed its stack and threw (measured).
const PATTERNS = [
  { kind: "aws-access-key-id", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    kind: "private-key-block",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/
  },
  { kind: "github-token", regex: /\bgh[opusr]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{40}[A-Za-z0-9_]*\b/ },
  { kind: "slack-token", regex: /\bxox[abprs]-[A-Za-z0-9-]{20}[A-Za-z0-9-]*\b/ },
  { kind: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "stripe-secret-key", regex: /\bsk_(?:live|test)_[A-Za-z0-9]{24}[A-Za-z0-9]*\b/ },
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
    regex: /\b(?:Authorization\s*:\s*)?Bearer\s+([A-Za-z0-9._~+\/=-]{20}[A-Za-z0-9._~+\/=-]*)/i,
    valueGroup: 1
  },
  {
    // Three base64url runs split by literal dots, so they never overlap. The
    // lookbehind (not `\b`) keeps a start from opening inside an
    // `eyJ-eyJ-...` run: `-` is a base64url character yet still a word
    // boundary, so with `\b` every start would rescan the rest of the line.
    // After authorization-header, so a bearer JWT keeps that older kind.
    kind: "jwt",
    regex: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/
  },
  {
    // The name is one `[A-Z0-9_]+` run behind a keyword lookahead. A leading
    // `[A-Z0-9_]*` run before the keyword backtracked through every split point
    // of a long word and went quadratic (152.9 ms at 40k characters, measured);
    // a backtrack into the single run now fails in one step, because the next
    // character is another name character, so the scan is linear. Detection is
    // unchanged (fuzzed against the old pattern on 400,000 lines, no
    // disagreement), with no length cap.
    //
    // F123. The name is all upper case or all lower case (`password:` in YAML),
    // never mixed: mixed case would catch `tokenType` and `secretName` (F35).
    // Each case is its own branch so both stay linear. A closing quote may sit
    // before the separator (`"API_KEY": "..."`). The value is a quoted run
    // (spaces allowed) or an unquoted run, each stopping at its own delimiter.
    // Group 1 is the name, so `ignore` can tell the lower-case branch apart:
    // there an unquoted CODE_VALUE is code, not a secret
    // (`token = getAccessToken(scope);`).
    kind: "secret-assignment",
    regex:
      /\b((?=[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY))[A-Z0-9_]+|(?=[a-z0-9_]*(?:secret|token|password|api_key))[a-z0-9_]+)["']?\s*[=:]\s*(?:"([^"]{16}[^"]*)"|'([^']{16}[^']*)'|["']?([^\s"']{16}[^\s"']*))/,
    valueGroup: [2, 3, 4],
    ignore: (match) => match[4] !== undefined && /[a-z]/.test(match[1]) && CODE_VALUE.test(match[4])
  }
].map((pattern) => ({ ...pattern, global: new RegExp(pattern.regex.source, `${pattern.regex.flags}g`) }));

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

// The first value on the line that `pattern` reports, or undefined. A pattern
// with a valueGroup can match a placeholder, an env reference or code first and
// a real secret later on the same line (`TOKEN="${{ secrets.X }}" API_KEY=...`),
// so every match is tried. After an unquoted value the search resumes at the
// match's end: resuming inside it would rescan a `NAME=${NAME=${...}` chain
// once per link, which is quadratic. After a quoted value it resumes at the
// value's start, because quotes let an assignment sit inside a placeholder
// (`TOKEN="<paste API_KEY=... here>"`); each quote opens at most one value, so
// that rescan stays linear too.
function firstValue(text, { regex, global, valueGroup, ignore }) {
  if (!valueGroup) {
    return text.match(regex)?.[0];
  }
  global.lastIndex = 0;
  let match;
  while ((match = global.exec(text)) !== null) {
    // `valueGroup` is one group index, or several alternatives of which one matched.
    const value = [].concat(valueGroup).map((group) => match[group]).find((found) => found !== undefined);
    if (!PLACEHOLDER.test(value) && !ENV_REFERENCE.test(value) && !ignore?.(match)) {
      return value;
    }
    // A quoted value (or credential-url's) has exactly one character after it.
    const end = match.index + match[0].length;
    global.lastIndex = match[0].endsWith(value) ? end : Math.max(match.index + 1, end - 1 - value.length);
  }
  return undefined;
}

const C_ESCAPES = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };

// Git writes a path holding a control character, `"`, `\` or (by default) a
// non-ASCII byte as a C-style quoted string: octal escapes are raw UTF-8
// bytes, so they are collected as bytes and decoded together.
function unquoteGitPath(body) {
  const parts = [];
  for (const [, escape, literal] of body.matchAll(/\\([0-7]{3}|[\s\S])|([^\\]+)/g)) {
    if (literal !== undefined) {
      parts.push(Buffer.from(literal));
    } else if (/^[0-7]{3}$/.test(escape)) {
      parts.push(Buffer.from([parseInt(escape, 8) & 0xff]));
    } else {
      parts.push(escape in C_ESCAPES ? Buffer.from([C_ESCAPES[escape]]) : Buffer.from(escape));
    }
  }
  return Buffer.concat(parts).toString("utf8");
}

// The path in a `---`/`+++` (or `diff --cc`) line, as a user would type it:
// git pads an unquoted path that holds a space with a trailing tab, quotes the
// rest as above with the `a/`/`b/` prefix inside the quotes, and names an
// absent side `/dev/null`.
function diffPath(raw, prefix) {
  let value = raw.replace(/\t$/, "");
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = unquoteGitPath(value.slice(1, -1));
  }
  if (value === "/dev/null") {
    return null;
  }
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

export function scanForSecrets(text, { allow = [], diff = false } = {}) {
  const allowed = compileAllow(allow);
  const hits = [];
  const lines = String(text ?? "").split(/\r?\n/);

  // Diff bookkeeping: the file and line a content line lands on, so a hit
  // points at something findable in an editor. Every content line is scanned
  // (added, removed, context): the commonest real case is reviewing the commit
  // that removes a committed key, whose value sits in a `-` line. Added and
  // context hits use new-file numbers; a removed hit uses old-file numbers and
  // the `---` path (a deleted file has no `+++`); `side` says which.
  //
  // `---`/`+++` are file headers only inside a "header zone": from a `diff
  // --git` (or `diff --cc`/`--combined`) line to that file's first hunk
  // header. Git writes the `diff` line and a content line always carries a
  // marker, so a file line reading `diff --git` renders as `+diff --git` and
  // cannot open a zone. Once a hunk starts no line is a header again (`++i`,
  // an SQL `--` comment), whatever its first characters.
  //
  // F59. With no `diff` line (a hand-rolled diff) no zone opens and file stays
  // null; a bare `@@` still sets numbers. Fine while the only caller feeds real
  // `git diff` output.
  //
  // File names reset when a zone opens, so a hunk-less section (binary notice)
  // never inherits the previous name. Counters restart at each hunk header:
  // added moves the new side, removed the old, context both, whatever the
  // content reads; `\ No newline at end of file` moves neither. Before any
  // hunk header a hit falls back to the raw line offset, no file.
  //
  // A combined diff has one marker column per parent and a `@@@ ... @@@`
  // header. A row with `-` in any column is not in the result: it does not
  // advance the new side and is reported at the new-side line it precedes.
  //
  // Nothing that leaves goes unscanned. Text after a hunk header's closing `@@`
  // is git's funcname copy of a file line (often a `.env` key): side
  // "hunk-header". A header-zone line git does not emit is "header"; a line
  // past the zone with no `+`, `-`, space or `\` marker is "unrecognized". Both
  // are reported at the raw offset. Only the `diff` line, `---`, `+++`, hunk
  // headers and other extended headers (index, mode, rename, copy, similarity,
  // dissimilarity, binary notice) are skipped: they carry paths and hashes.
  //
  // `diffHeaders` and `hunks` count the recognized header lines, so a caller
  // can refuse a diff whose shape was not recognized (color escapes, an
  // external diff driver) rather than trust an empty scan.
  const DIFF_HEADER = /^diff --(git|cc|combined) (.*)$/;
  const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;
  // The per-parent repeats in a combined hunk header, index line and mode line
  // are capped: uncapped, a crafted 16 MB line of them overflowed V8's
  // backtrack stack and threw. Git writes one entry per parent; an unresolved
  // merge has two and an octopus merge rarely more than a handful, so 31 extra
  // entries (32 parents) is far past any real diff. A longer line is simply not
  // recognized as a header and falls to the safety-net scan, never skipped.
  const COMBINED_HUNK_HEADER = /^(@@@+) -(\d+)(?:,\d+)?(?: -\d+(?:,\d+)?){0,31} \+(\d+)(?:,\d+)? \1(.*)$/;
  const GIT_HEADER_LINE =
    /^(?:index [0-9a-f]+(?:,[0-9a-f]+){0,31}\.\.[0-9a-f]+(?: [0-7]+)?|(?:old|new|deleted file|new file) mode [0-7]+|mode [0-7]+(?:,[0-7]+){1,31}\.\.[0-7]+|similarity index \d+%|dissimilarity index \d+%|(?:rename|copy) (?:from|to) .*|Binary files .* differ|GIT binary patch)$/;
  let currentFile = null;
  let oldFile = null;
  let newLine = null;
  let oldLine = null;
  let columns = 1; // marker columns per content line: one per parent
  let inHeaderZone = false;
  let diffHeaders = 0;
  let hunks = 0;

  // F111. An allow pattern is written against the raw diff line, so
  // `^\+NAME=` clears the `+NAME=...` content line. The hunk-header copy of a
  // line (`text`, the trimmed trailer after the closing `@@`) has no marker of
  // its own, and a marker-anchored pattern must not clear it just by lending it
  // one: `^-API_KEY`, written to admit a removed revoked key, would then also
  // clear a live `API_KEY=...` git copied into a header. So a pattern clears a
  // trailer hit only when it matches the whole `@@` line or the trailer bare
  // (`FIXTURE_TOKEN=`, `^FIXTURE_TOKEN=`), or when the trailer is the text of a
  // content line anywhere in this diff that an allow pattern cleared: then the
  // copy leaks nothing the user has not already admitted. Git copies at most 80
  // bytes of the line, trailing whitespace trimmed, so a cleared line is also
  // remembered in that shortened form. A trailer can precede the line it was
  // copied from, so that check runs once the whole diff is read.
  const clearedContent = new Set();
  const trailerHits = [];

  function rememberCleared(content) {
    clearedContent.add(content.trim());
    if (Buffer.byteLength(content) > 80) {
      clearedContent.add(Buffer.from(content).subarray(0, 80).toString("utf8").trim());
    }
  }

  function scanText(line, text, location) {
    if (allowed.some((pattern) => pattern.test(line) || (text !== line && pattern.test(text)))) {
      if (location.side === "added" || location.side === "removed" || location.side === "context") {
        rememberCleared(line.slice(columns));
      }
      return;
    }
    for (const pattern of PATTERNS) {
      const value = firstValue(text, pattern);
      if (value === undefined) {
        continue;
      }
      const hit = { line: location.line, kind: pattern.kind, sample: sampleOf(value, { hideValue: Boolean(pattern.valueGroup) }) };
      if (diff) {
        hit.file = location.file;
        hit.side = location.side;
      }
      hits.push(hit);
      if (location.side === "hunk-header") {
        trailerHits.push({ hit, text });
      }
      return;
    }
  }

  // Opens a hunk and scans the text git copied in after its closing `@@`.
  function openHunk(line, { oldStart, newStart, trailer, parents }) {
    hunks += 1;
    columns = parents;
    oldLine = oldStart - 1;
    newLine = newStart - 1;
    if (trailer.trim()) {
      // The copied text is read from the old file (git's funcname heuristic
      // walks backward through the pre-image), so it is found at or above the
      // hunk's old-file start line. A new file has no old-file line at all
      // (old start 0), so only then does the new-file start line stand in.
      scanText(line, trailer.trim(), {
        line: oldStart > 0 ? oldStart : newStart,
        file: currentFile ?? oldFile,
        side: "hunk-header"
      });
    }
  }

  function parseHunkHeader(line) {
    const plain = line.match(HUNK_HEADER);
    if (plain) {
      return { oldStart: Number(plain[1]), newStart: Number(plain[2]), trailer: plain[3], parents: 1 };
    }
    const combined = line.match(COMBINED_HUNK_HEADER);
    if (combined) {
      return {
        oldStart: Number(combined[2]),
        newStart: Number(combined[3]),
        trailer: combined[4],
        parents: combined[1].length - 1
      };
    }
    return null;
  }

  lines.forEach((line, index) => {
    let hitLine = index + 1;
    let hitFile = null;
    let side = null;

    if (diff) {
      const diffHeader = line.match(DIFF_HEADER);
      if (diffHeader) {
        diffHeaders += 1;
        inHeaderZone = true;
        // A combined header names its file itself (no `a/`/`b/` prefix).
        currentFile = diffHeader[1] === "git" ? null : diffPath(diffHeader[2], "");
        oldFile = null;
        newLine = null;
        oldLine = null;
        return;
      }

      if (inHeaderZone) {
        const oldHeader = line.match(/^--- (.*)$/);
        if (oldHeader) {
          oldFile = diffPath(oldHeader[1], "a/");
          return;
        }
        const fileHeader = line.match(/^\+\+\+ (.*)$/);
        if (fileHeader) {
          currentFile = diffPath(fileHeader[1], "b/");
          return;
        }
        const hunkHeader = parseHunkHeader(line);
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
      const hunkHeader = parseHunkHeader(line);
      if (hunkHeader) {
        openHunk(line, hunkHeader);
        return;
      }

      // The leading marker column(s) say which file(s) the line occupies a
      // line of. `\ No newline at end of file` neither advances a counter nor
      // is scanned; a line with no marker at all is scanned at its raw offset.
      const tracked = newLine !== null;
      const combined = columns > 1;
      const marks = line.slice(0, columns);
      if (marks.length === columns && /^[-+ ]+$/.test(marks)) {
        if (marks.includes("-")) {
          side = "removed";
          oldLine = tracked && !combined ? oldLine + 1 : oldLine;
        } else if (marks.includes("+")) {
          side = "added";
          newLine = tracked ? newLine + 1 : null;
        } else {
          side = "context";
          newLine = tracked ? newLine + 1 : null;
          oldLine = tracked ? oldLine + 1 : null;
        }
      } else if (!line || line.startsWith("\\")) {
        return;
      } else {
        scanText(line, line, { line: hitLine, file: null, side: "unrecognized" });
        return;
      }
      if (tracked) {
        if (side === "removed" && !combined) {
          hitLine = oldLine;
          hitFile = oldFile;
        } else if (side === "removed") {
          hitLine = newLine + 1;
          hitFile = currentFile ?? oldFile;
        } else {
          hitLine = newLine;
          hitFile = currentFile;
        }
      }
    }

    scanText(line, line, { line: hitLine, file: hitFile, side });
  });

  const copiesOfCleared = new Set(trailerHits.filter(({ text }) => clearedContent.has(text)).map(({ hit }) => hit));
  const kept = copiesOfCleared.size ? hits.filter((hit) => !copiesOfCleared.has(hit)) : hits;
  return diff ? { hits: kept, diffHeaders, hunks } : { hits: kept };
}
