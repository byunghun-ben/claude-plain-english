#!/usr/bin/env node

// Fail-closed release gate.
//
//   release-gate.mjs --repo PATH --tag vX.Y.Z
//
// The gate verifies repository and release metadata only. The optional paid
// Default-versus-Plain-English comparison is deliberately outside this gate.
// Only the read-only Git subcommands in GIT_READ_COMMANDS may run.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { scanWorkingTree } from "./check-public-boundary.mjs";

export const GIT_READ_COMMANDS = new Set(["rev-parse", "status", "for-each-ref"]);
const MANIFEST_RELATIVE = join("plugins", "plain-english", ".claude-plugin", "plugin.json");
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

function git(repo, args) {
  if (!GIT_READ_COMMANDS.has(args[0])) throw new Error(`the release gate may not run git ${args[0]}`);
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || "").trim()}`);
  return result.stdout;
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

export function runGate({ repo, tag }) {
  const repoRoot = resolve(repo);
  const problems = [];

  problems.push(...readGitState(repoRoot, tag).problems);

  const manifestVersion = JSON.parse(readFileSync(join(repoRoot, MANIFEST_RELATIVE), "utf8")).version;
  const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
  problems.push(...checkVersionAlignment({ tag, manifestVersion, changelog }));
  problems.push(...checkPlaceholders(repoRoot));

  const boundary = scanWorkingTree(repoRoot);
  if (boundary.length) problems.push(`the public boundary reports ${boundary.length} violation(s)`);

  return problems;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const key = { "--repo": "repo", "--tag": "tag" }[argument];
    if (!key) throw new Error(`unknown release-gate argument: ${argument}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${argument}`);
    options[key] = value;
  }
  for (const required of ["repo", "tag"]) {
    if (!options[required]) throw new Error("Usage: release-gate.mjs --repo PATH --tag vX.Y.Z");
  }
  return options;
}

function main() {
  let problems;
  try {
    problems = runGate(parseArgs(process.argv.slice(2)));
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
