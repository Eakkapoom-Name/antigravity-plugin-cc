// Scans text that is about to leave on stdin for agy: review diffs and the
// transfer brief. Hand-rolled patterns, no dependency, because the plugin has
// none and runs on Node 18. Only the shape of a hit is reported, never the
// value, so the report itself is safe to paste.

const PLACEHOLDER = /^(?:x{3,}|\*{3,}|changeme|change-me|<[^>]*>|\$\{[^}]*\}|your[-_a-z0-9]*|example[-_a-z0-9]*|placeholder)$/i;

// An environment-variable reference is not a secret, it is the mechanism a
// repository uses to avoid putting one in the text at all. The value group a
// secret-assignment or authorization-header match captures stops at the next
// quote or space, so a quoted lookup such as os.environ["NAME"] is often cut
// short before it ever reaches this check, but an unquoted one, or
// process.env.NAME, or a bare $NAME, reaches the pattern whole. Matching from
// the start rather than requiring the whole string covers both cases without
// depending on whatever a quote may already have cut off the end.
const ENV_REFERENCE = /^(?:process\.env(?:\.[A-Za-z0-9_]+|\[)|os\.environ\[|os\.getenv\(|ENV\[|\$[A-Za-z_][A-Za-z0-9_]*)/;

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

  lines.forEach((line, index) => {
    if (diff && (!line.startsWith("+") || line.startsWith("+++"))) {
      return;
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
      hits.push({ line: index + 1, kind, sample: sampleOf(value, { hideValue: Boolean(valueGroup) }) });
      break;
    }
  });

  return { hits };
}
