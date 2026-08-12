#!/usr/bin/env node

// Fail-closed release gate.
//
//   release-gate.mjs --repo PATH --tag vX.Y.Z --attestation /absolute/path/outside/the/repo.json
//
// The gate reads repository state and an external benchmark attestation. It
// never creates a remote, pushes a commit or a tag, or publishes a release:
// only the read-only Git subcommands in GIT_READ_COMMANDS may run.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { scanWorkingTree } from "./check-public-boundary.mjs";

export const GIT_READ_COMMANDS = new Set(["rev-parse", "status", "cat-file", "for-each-ref", "ls-files", "rev-list"]);
const PLUGIN_RELATIVE = join("plugins", "plain-english");
const STYLE_RELATIVE = join(PLUGIN_RELATIVE, "output-styles", "plain-english.md");
const MANIFEST_RELATIVE = join(PLUGIN_RELATIVE, ".claude-plugin", "plugin.json");
const FIXTURES_RELATIVE = join("fixtures", "claude-response-quality-cases.json");
const RELEASE_FACING_FILES = [
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  join("docs", "EVALUATION.md"),
  join("docs", "PROVENANCE.md"),
  join("docs", "PUBLICATION-CONTRACT.md"),
  join("docs", "RELEASE-CHECKLIST.md"),
];
const PLACEHOLDER = new RegExp(["TO" + "DO", "TB" + "D", "FIX" + "ME", "to be decided", "coming soon"].join("|"), "i");
const TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// The benchmark definition. These are the numbers the experiment was designed
// to produce; the gate does not negotiate them.
export const THRESHOLDS = {
  cases: 12,
  repetitions: 2,
  pairs: 24,
  responses: 48,
  reviewers: 2,
  ratings: 48,
  minimumNonTies: 36,
  minimumPlainEnglishShare: 0.6,
};

const ATTESTATION_SHAPE = {
  version: "number",
  benchmark: "string",
  release: { tag: "string", commit: "string", pluginVersion: "string" },
  execution: { claudeVersion: "string", model: "string", effort: "string" },
  hashes: { style: "string", plugin: "string", fixtures: "string" },
  matrix: { cases: "number", repetitions: "number", pairs: "number", responses: "number" },
  reviews: { reviewers: "number", ratings: "number", nonTies: "number" },
  results: {
    plainEnglishNonTieRatings: "number",
    defaultNonTieRatings: "number",
    pairWins: { "plain-english": "number", default: "number", tie: "number" },
    hardGate: {
      "plain-english": { total: "number", pass: "number" },
      default: { total: "number", pass: "number" },
    },
  },
  attestedBy: "string",
};
// A response body cannot hide inside an allowed field if every string is short.
const MAXIMUM_STRING_LENGTH = 200;

function git(repo, args) {
  if (!GIT_READ_COMMANDS.has(args[0])) throw new Error(`the release gate may not run git ${args[0]}`);
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || "").trim()}`);
  return result.stdout;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function hashDirectory(root) {
  const records = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(current, entry.name);
      const relative = absolute.slice(root.length + 1).split(sep).join("/");
      if (entry.isSymbolicLink()) throw new Error("the plugin directory must not contain symbolic links");
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) records.push(`${relative}\0${sha256(readFileSync(absolute))}\n`);
      else throw new Error("the plugin directory has an unsupported entry");
    }
  };
  visit(root);
  if (!records.length) throw new Error("the plugin directory is empty");
  return sha256(records.join(""));
}

// ----- shape and threshold checks -------------------------------------------

export function checkShape(value, shape, at = "attestation") {
  const problems = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    problems.push(`${at} must be an object`);
    return problems;
  }
  const expectedKeys = Object.keys(shape).sort();
  const actualKeys = Object.keys(value).sort();
  const unknown = actualKeys.filter((key) => !expectedKeys.includes(key));
  if (unknown.length) problems.push(`${at} has fields the gate does not know: ${unknown.join(", ")}`);
  for (const [key, expected] of Object.entries(shape)) {
    if (!(key in value)) {
      problems.push(`${at}.${key} is missing`);
      continue;
    }
    const actual = value[key];
    if (typeof expected === "object") {
      problems.push(...checkShape(actual, expected, `${at}.${key}`));
      continue;
    }
    if (typeof actual !== expected) {
      problems.push(`${at}.${key} must be a ${expected}`);
      continue;
    }
    if (expected === "string" && (!actual.trim() || actual.length > MAXIMUM_STRING_LENGTH)) {
      problems.push(`${at}.${key} must be a short non-empty string`);
    }
    if (expected === "number" && (!Number.isFinite(actual) || actual < 0)) {
      problems.push(`${at}.${key} must be a non-negative number`);
    }
  }
  return problems;
}

export function checkThresholds(attestation) {
  const problems = [];
  const { matrix, reviews, results } = attestation;

  for (const [key, expected] of Object.entries({
    cases: THRESHOLDS.cases,
    repetitions: THRESHOLDS.repetitions,
    pairs: THRESHOLDS.pairs,
    responses: THRESHOLDS.responses,
  })) {
    if (matrix[key] !== expected) problems.push(`matrix.${key} must be ${expected}, found ${matrix[key]}`);
  }
  if (reviews.reviewers !== THRESHOLDS.reviewers) {
    problems.push(`reviews.reviewers must be ${THRESHOLDS.reviewers}, found ${reviews.reviewers}`);
  }
  if (reviews.ratings !== THRESHOLDS.ratings) {
    problems.push(`reviews.ratings must be ${THRESHOLDS.ratings}, found ${reviews.ratings}`);
  }
  if (reviews.nonTies < THRESHOLDS.minimumNonTies) {
    problems.push(`reviews.nonTies must be at least ${THRESHOLDS.minimumNonTies}, found ${reviews.nonTies}`);
  }
  if (reviews.nonTies > reviews.ratings) problems.push("reviews.nonTies cannot exceed reviews.ratings");

  const nonTieSum = results.plainEnglishNonTieRatings + results.defaultNonTieRatings;
  if (nonTieSum !== reviews.nonTies) {
    problems.push(`the non-tie ratings sum to ${nonTieSum}, which does not match reviews.nonTies`);
  }
  const share = reviews.nonTies ? results.plainEnglishNonTieRatings / reviews.nonTies : 0;
  if (share < THRESHOLDS.minimumPlainEnglishShare) {
    problems.push(
      `Plain English holds ${(share * 100).toFixed(1)}% of non-tie ratings, below ${
        THRESHOLDS.minimumPlainEnglishShare * 100
      }%`,
    );
  }

  const wins = results.pairWins;
  const winSum = wins["plain-english"] + wins.default + wins.tie;
  if (winSum !== THRESHOLDS.pairs) problems.push(`pair outcomes sum to ${winSum}, not ${THRESHOLDS.pairs}`);
  if (!(wins["plain-english"] > wins.default)) {
    problems.push(`Plain English pair wins (${wins["plain-english"]}) must exceed Default (${wins.default})`);
  }

  const plainGate = results.hardGate["plain-english"];
  const defaultGate = results.hardGate.default;
  if (plainGate.total !== THRESHOLDS.pairs) problems.push(`the Plain English hard gate must cover ${THRESHOLDS.pairs} responses`);
  if (plainGate.pass !== plainGate.total) {
    problems.push(`all Plain English responses must pass the factual hard gate, found ${plainGate.pass}/${plainGate.total}`);
  }
  if (defaultGate.total !== THRESHOLDS.pairs) problems.push(`the Default hard gate must cover ${THRESHOLDS.pairs} responses`);
  const plainRate = plainGate.total ? plainGate.pass / plainGate.total : 0;
  const defaultRate = defaultGate.total ? defaultGate.pass / defaultGate.total : 0;
  if (plainRate < defaultRate) problems.push("the Plain English hard-gate pass rate is lower than Default's");

  return problems;
}

export function checkBinding(attestation, actual) {
  const problems = [];
  if (attestation.release.tag !== actual.tag) problems.push("the attestation names a different tag");
  if (attestation.release.commit !== actual.commit) {
    problems.push("the attestation is stale: it is bound to a different commit");
  }
  if (attestation.release.pluginVersion !== actual.pluginVersion) {
    problems.push("the attestation names a different plugin version");
  }
  for (const key of ["style", "plugin", "fixtures"]) {
    if (attestation.hashes[key] !== actual.hashes[key]) {
      problems.push(`the attestation is stale: the ${key} hash has moved since the run`);
    }
  }
  if (attestation.execution.claudeVersion !== actual.claudeVersion && actual.claudeVersion !== null) {
    problems.push("the attestation names a different Claude Code version");
  }
  return problems;
}

export function checkVersionAlignment({ tag, manifestVersion, changelog }) {
  const problems = [];
  if (!TAG_PATTERN.test(tag)) problems.push(`the tag ${tag} is not a v-prefixed semantic version`);
  const version = tag.replace(/^v/, "");
  if (manifestVersion !== version) {
    problems.push(`the plugin manifest is ${manifestVersion}, which does not match the tag`);
  }
  if (!new RegExp(`^##\\s+v?${version.replace(/\./g, "\\.")}\\b`, "m").test(changelog)) {
    problems.push(`the changelog has no section for ${version}`);
  }
  return problems;
}

export function checkPlaceholders(repo, files = RELEASE_FACING_FILES) {
  return files
    .filter((file) => PLACEHOLDER.test(readFileSync(join(repo, file), "utf8")))
    .map((file) => `${file} still contains a placeholder or a deferred decision`);
}

// ----- repository and attestation state -------------------------------------

export function readGitState(repo, tag) {
  const problems = [];
  const branch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (branch !== "main") problems.push(`the release must be cut from main, found ${branch}`);

  const status = git(repo, ["status", "--porcelain"]).trim();
  if (status) problems.push("the working tree is not clean");

  const commit = git(repo, ["rev-parse", "HEAD"]).trim();
  const tagRecords = git(repo, ["for-each-ref", "--format=%(refname:short) %(objecttype) %(*objectname)", "refs/tags"])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" "));
  const record = tagRecords.find(([name]) => name === tag);
  if (!record) {
    problems.push(`the tag ${tag} does not exist`);
  } else if (record[1] !== "tag") {
    problems.push(`the tag ${tag} is not annotated`);
  } else if (record[2] !== commit) {
    problems.push(`the tag ${tag} does not point at the release commit`);
  }
  return { commit, problems };
}

export function readAttestation(path, repoRoot) {
  const resolved = resolve(path);
  if (!isAbsolute(path)) throw new Error("--attestation must be an absolute path");
  if (resolved === repoRoot || resolved.startsWith(`${repoRoot}${sep}`)) {
    throw new Error("the attestation must live outside the repository");
  }
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink()) throw new Error("the attestation must not be a symbolic link");
  const mode = stat.mode & 0o777;
  if (mode !== 0o600) throw new Error(`the attestation must be mode 0600, found 0${mode.toString(8)}`);
  return JSON.parse(readFileSync(resolved, "utf8"));
}

export function runGate({ repo, tag, attestationPath, claudeVersion = null }) {
  const repoRoot = realpathSync(repo);
  const problems = [];

  const gitState = readGitState(repoRoot, tag);
  problems.push(...gitState.problems);

  const manifestVersion = JSON.parse(readFileSync(join(repoRoot, MANIFEST_RELATIVE), "utf8")).version;
  const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
  problems.push(...checkVersionAlignment({ tag, manifestVersion, changelog }));
  problems.push(...checkPlaceholders(repoRoot));

  const boundary = scanWorkingTree(repoRoot);
  if (boundary.length) problems.push(`the public boundary reports ${boundary.length} violation(s)`);

  const attestation = readAttestation(attestationPath, repoRoot);
  const shapeProblems = checkShape(attestation, ATTESTATION_SHAPE);
  problems.push(...shapeProblems);
  if (shapeProblems.length === 0) {
    if (attestation.version !== 1) problems.push("the attestation version must be 1");
    problems.push(...checkThresholds(attestation));
    problems.push(
      ...checkBinding(attestation, {
        tag,
        commit: gitState.commit,
        pluginVersion: manifestVersion,
        claudeVersion,
        hashes: {
          style: sha256(readFileSync(join(repoRoot, STYLE_RELATIVE))),
          plugin: hashDirectory(join(repoRoot, PLUGIN_RELATIVE)),
          fixtures: sha256(readFileSync(join(repoRoot, FIXTURES_RELATIVE))),
        },
      }),
    );
  }

  return problems;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const key = { "--repo": "repo", "--tag": "tag", "--attestation": "attestation", "--claude-version": "claudeVersion" }[
      argument
    ];
    if (!key) throw new Error(`unknown release-gate argument: ${argument}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${argument}`);
    options[key] = value;
  }
  for (const required of ["repo", "tag", "attestation"]) {
    if (!options[required]) {
      throw new Error("Usage: release-gate.mjs --repo PATH --tag vX.Y.Z --attestation ABSOLUTE_PATH [--claude-version VERSION]");
    }
  }
  return options;
}

function main() {
  let problems;
  try {
    const options = parseArgs(process.argv.slice(2));
    problems = runGate({
      repo: options.repo,
      tag: options.tag,
      attestationPath: options.attestation,
      claudeVersion: options.claudeVersion ?? null,
    });
  } catch (error) {
    console.error(`Release gate failed: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (problems.length) {
    console.error(`Release gate failed: ${problems.length} problem(s).`);
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log("Release gate passed.");
  console.log("It did not create a remote, push a commit or a tag, or publish a release. Those stay manual.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
