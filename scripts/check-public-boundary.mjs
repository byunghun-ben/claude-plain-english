#!/usr/bin/env node

// Fail-closed check on what this repository publishes.
//
//   check-public-boundary.mjs --repo PATH --working-tree
//
// Failures are reported by kind and count only. A report that quotes the
// offending path or the matched value would publish the thing it is trying to
// keep private; reproduce locally to see the file.

import { readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

const CONTRACT = "docs/PUBLICATION-CONTRACT.md";

// Split so this file does not contain a literal that matches its own patterns.
const joined = (...parts) => parts.join("");

const CONTENT_PATTERNS = [
  { kind: "secret", regex: new RegExp(joined("AK", "IA", "[A-Z0-9]{16}")) },
  { kind: "secret", regex: new RegExp(joined("AS", "IA", "[A-Z0-9]{16}")) },
  { kind: "secret", regex: new RegExp(joined("gh", "[posur]_[A-Za-z0-9]{30,}")) },
  { kind: "secret", regex: new RegExp(joined("github", "_pat_[A-Za-z0-9_]{30,}"), "i") },
  { kind: "secret", regex: new RegExp(joined("sk", "-ant-[A-Za-z0-9_-]{20,}"), "i") },
  { kind: "secret", regex: new RegExp(joined("xox", "[abprs]-[A-Za-z0-9-]{20,}"), "i") },
  { kind: "secret", regex: new RegExp(joined("-----BEGIN ", "(?:RSA |EC |OPENSSH )?PRIVATE KEY-----")) },
  { kind: "personal-data", regex: new RegExp(joined("/Us", "ers/")) },
  { kind: "personal-data", regex: new RegExp(joined("/ho", "me/[A-Za-z0-9._-]+")) },
  { kind: "personal-data", regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/ },
  { kind: "raw-response", regex: new RegExp(joined("\"expected", "Matrix\"")) },
  { kind: "raw-response", regex: new RegExp(joined("\"variant", "Mapping\"")) },
];

const PROHIBITED_PATH = new RegExp(
  [
    "(?:^|/)(?:",
    "\\.env(?:[.-]|$)",
    "|(?:raws?(?:[-_ ]?(?:model|output|response)s?)?",
    "|evidence|evaluation[-_ ]?evidence",
    "|transcripts?|session[-_ ]?logs?)(?:[./_-]|$)",
    ")",
  ].join(""),
  "i",
);

function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git inspection failed: ${args[0]}`);
  return result.stdout;
}

export function readAllowlist(repo) {
  const source = readFileSync(join(repo, CONTRACT), "utf8");
  const section = source.match(/## Path allowlist\s+([\s\S]*?)(?=\n## )/);
  if (!section) throw new Error("the publication contract has no path allowlist");
  const entries = [...section[1].matchAll(/^- `([^`]+)`\s*$/gm)].map((match) => match[1]);
  if (entries.length === 0 || new Set(entries).size !== entries.length) {
    throw new Error("the path allowlist is empty or has duplicates");
  }
  return new Set(entries);
}

export function pathViolations(relativePath, allowlist, locationKind) {
  const normalized = relativePath.split(sep).join("/").replace(/^\.\//, "");
  const violations = [];
  if (!allowlist.has(normalized)) violations.push({ kind: "path-not-allowlisted", locationKind });
  if (PROHIBITED_PATH.test(normalized)) violations.push({ kind: "prohibited-path", locationKind });
  return violations;
}

export function contentViolations(buffer, locationKind) {
  if (buffer.includes(0)) return [{ kind: "binary-content", locationKind }];
  const text = buffer.toString("utf8");
  return CONTENT_PATTERNS.filter(({ regex }) => regex.test(text)).map(({ kind }) => ({ kind, locationKind }));
}

// Git modes carry what a clone would receive: 100644 is a regular file, 100755
// is executable, 120000 is a symbolic link, 160000 is a nested repository.
const MODE_VIOLATIONS = new Map([
  ["100755", "executable-file"],
  ["120000", "symbolic-link"],
  ["160000", "nested-repository"],
]);

export function parseIndex(stageOutput) {
  return stageOutput
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = record.match(/^(\d{6}) [0-9a-f]+ \d\t(.*)$/s);
      if (!match) throw new Error("could not read the Git index");
      return { mode: match[1], path: match[2] };
    });
}

export function scanIndex(repo, allowlist, entries) {
  const violations = [];
  for (const entry of entries) {
    violations.push(...pathViolations(entry.path, allowlist, "index"));
    const modeViolation = MODE_VIOLATIONS.get(entry.mode);
    if (modeViolation) {
      violations.push({ kind: modeViolation, locationKind: "index" });
      continue;
    }
    violations.push(...contentViolations(readFileSync(join(repo, entry.path)), "tracked-content"));
  }
  return violations;
}

// Files Git ignores are not published, so they are out of scope. Files that are
// untracked but not ignored are in scope, because the next `git add -A` would
// publish them.
export function scanWorkingTree(repo) {
  const allowlist = readAllowlist(repo);
  const entries = parseIndex(git(repo, ["ls-files", "--stage", "-z"]));
  const violations = scanIndex(repo, allowlist, entries);
  for (const path of git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean)) {
    violations.push(...pathViolations(path, allowlist, "untracked"));
  }
  return violations;
}

export function formatFailure(violations) {
  const counts = new Map();
  for (const violation of violations) counts.set(violation.kind, (counts.get(violation.kind) || 0) + 1);
  return [
    `Public boundary failed: ${violations.length} violation(s).`,
    ...[...counts].sort().map(([kind, count]) => `- ${kind}: ${count}`),
    "Offending paths and matched values are redacted on purpose.",
    "Reproduce locally: node scripts/check-public-boundary.mjs --repo . --working-tree",
  ].join("\n");
}

function parseArgs(argv) {
  let repo;
  let mode;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repo") repo = argv[++index];
    else if (argument === "--working-tree") mode = "working-tree";
    else throw new Error("unknown public-boundary argument");
  }
  if (!repo || !mode) throw new Error("Usage: check-public-boundary.mjs --repo PATH --working-tree");
  return { repo: realpathSync(repo), mode };
}

function main() {
  try {
    const { repo, mode } = parseArgs(process.argv.slice(2));
    const violations = scanWorkingTree(repo);
    if (violations.length) {
      console.error(formatFailure(violations));
      process.exitCode = 1;
    } else {
      console.log(`Public boundary passed (${mode}).`);
    }
  } catch {
    console.error("Public boundary failed before it could finish. Details are redacted.");
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
