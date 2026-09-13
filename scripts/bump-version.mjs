#!/usr/bin/env node

// Version metadata for this plugin lives in three files that must agree:
// package.json, .claude-plugin/plugin.json, and the CHANGELOG heading.
// `--check` asserts they do; the bump mode sets them together and closes the
// [Unreleased] section, so a release is one command instead of three hand edits.
//
// Usage:
//   node scripts/bump-version.mjs --check [version]
//   node scripts/bump-version.mjs <version>

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const UNRELEASED_HEADING = "## [Unreleased]";

// marketplace.json carries no version of its own in this repository, so it is
// deliberately not a target; adding it here would assert a field that does not
// exist.
const JSON_TARGETS = [
  { file: "package.json", label: "version" },
  { file: ".claude-plugin/plugin.json", label: "version" }
];

export function validateVersion(version) {
  if (!VERSION_PATTERN.test(String(version ?? ""))) {
    throw new Error(`Expected a semver-like version such as 1.0.3, got: ${version}`);
  }
  return version;
}

export function readJson(root, file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

function writeJson(root, file, json) {
  fs.writeFileSync(path.join(root, file), `${JSON.stringify(json, null, 2)}\n`);
}

// The CHANGELOG is in sync when it documents this version, or when it still has
// an open [Unreleased] section holding work that has not shipped yet. Both are
// legitimate states between releases.
export function changelogState(source, version) {
  const text = String(source ?? "");
  return {
    hasUnreleased: text.includes(UNRELEASED_HEADING),
    hasVersion: text.includes(`## [${version}]`)
  };
}

export function closeUnreleased(source, version, date) {
  const text = String(source ?? "");
  if (!text.includes(UNRELEASED_HEADING)) {
    return { changed: false, text };
  }
  return {
    changed: true,
    text: text.replace(UNRELEASED_HEADING, `## [${version}] - ${date}`)
  };
}

export function checkVersions(root, expectedVersion) {
  const mismatches = [];

  for (const target of JSON_TARGETS) {
    const actual = readJson(root, target.file)[target.label];
    if (actual !== expectedVersion) {
      mismatches.push(
        `${target.file} ${target.label}: expected ${expectedVersion}, found ${actual ?? "<missing>"}`
      );
    }
  }

  const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  const state = changelogState(changelog, expectedVersion);
  if (!state.hasVersion && !state.hasUnreleased) {
    mismatches.push(
      `CHANGELOG.md: no "## [${expectedVersion}]" section and no "${UNRELEASED_HEADING}" section`
    );
  }

  return mismatches;
}

function bumpVersion(root, version, date) {
  const changedFiles = [];

  for (const target of JSON_TARGETS) {
    const json = readJson(root, target.file);
    if (json[target.label] === version) {
      continue;
    }
    json[target.label] = version;
    writeJson(root, target.file, json);
    changedFiles.push(target.file);
  }

  const changelogPath = path.join(root, "CHANGELOG.md");
  const closed = closeUnreleased(fs.readFileSync(changelogPath, "utf8"), version, date);
  if (closed.changed) {
    fs.writeFileSync(changelogPath, closed.text);
    changedFiles.push("CHANGELOG.md");
  }

  return changedFiles;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/bump-version.mjs <version>",
    "  node scripts/bump-version.mjs --check [version]",
    "",
    "Options:",
    "  --check       Verify version metadata. Uses package.json when version is omitted.",
    "  --root <dir>  Run against a different repository root.",
    "  --date <date> Release date for the CHANGELOG heading (default: today, UTC).",
    "  --help        Print this help."
  ].join("\n");
}

export function parseArgs(argv) {
  const options = { check: false, help: false, root: process.cwd(), version: null, date: null };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") {
      options.check = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--root" || arg === "--date") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(`${arg} requires a value.`);
      }
      options[arg === "--root" ? "root" : "date"] = value;
      i += 1;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (options.version) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    } else {
      options.version = arg;
    }
  }

  options.root = path.resolve(options.root);
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const version = options.version ?? (options.check ? readJson(options.root, "package.json").version : null);
  if (!version) {
    throw new Error(`Missing version.\n\n${usage()}`);
  }
  validateVersion(version);

  if (options.check) {
    const mismatches = checkVersions(options.root, version);
    if (mismatches.length > 0) {
      throw new Error(`Version metadata is out of sync:\n${mismatches.join("\n")}`);
    }
    console.log(`All version metadata matches ${version}.`);
    return;
  }

  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const changed = bumpVersion(options.root, version, date);
  console.log(
    `Set version metadata to ${version}: ${changed.length > 0 ? changed.join(", ") : "no files changed"}.`
  );
}

// Only act when invoked as a script; importing this module for tests must not
// rewrite the repository's manifests.
if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
