// Scans text that is about to leave on stdin for agy: review diffs and the
// transfer brief. Hand-rolled patterns, no dependency, because the plugin has
// none and runs on Node 18. Only the shape of a hit is reported, never the
// value, so the report itself is safe to paste.

const PLACEHOLDER = /^(?:x{3,}|\*{3,}|changeme|change-me|<[^>]*>|\$\{[^}]*\}|your[-_a-z0-9]*|example[-_a-z0-9]*|placeholder)$/i;

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

function sampleOf(value) {
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
      if (valueGroup && PLACEHOLDER.test(value)) {
        continue;
      }
      hits.push({ line: index + 1, kind, sample: sampleOf(value) });
      break;
    }
  });

  return { hits };
}
