// Version parsing shared by /agy:setup's gates and the runtime's per-run
// `--settings` gate in lib/agy.mjs. Moved here unchanged from
// scripts/agy-setup.mjs, which re-exports compareVersions and
// extractVersionNumber, so both read a version the same way.

// F74. compareVersions and the two gates in scripts/agy-setup.mjs read a
// version the same way: the
// numeric core extractVersionNumber pulls out ("1.2.4-beta" and "v1.2.4" both
// read as 1.2.4, and every part of a longer one is kept, so "1.2.11.1" stays
// above "1.2.11"), or a bare dotted number that has fewer than three parts
// ("1.2"). Anything else has no core. Before this the gates rejected the
// prefixed and suffixed shapes outright while compareVersions read a
// non-numeric part as 0, so the two disagreed on the same input.
export function versionCore(raw) {
  const extracted = extractVersionNumber(raw);
  if (extracted) {
    return extracted;
  }
  const bare = String(raw ?? "").trim();
  return /^\d+(\.\d+)*$/.test(bare) ? bare : null;
}

export function compareVersions(a, b) {
  const parse = (value) => (versionCore(value) ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) {
      return l > r ? 1 : -1;
    }
  }
  return 0;
}

// agy's own `--version` output is a bare number today ("1.2.6"). If that output
// ever grows a prefix or suffix ("agy 1.3.0", "1.2.4-beta", "v1.2.4"), checkAgy
// would print a literal, doubled "agy agy 1.3.0 is below the 1.2.4 floor", a
// false claim about a version that may well be fine (F80). Extracting the
// numeric core first keeps the gates, compareVersions, and the printed detail
// all reading the same value (F74: the gates and compareVersions read the core
// through this function too); returns null when the output carries no such
// pattern. Three or more dotted parts are taken whole: stopping at three read
// "1.2.11.1" as 1.2.11, equal to the verified version instead of above it.
export function extractVersionNumber(raw) {
  const match = String(raw ?? "").match(/\d+(?:\.\d+){2,}/);
  return match ? match[0] : null;
}
