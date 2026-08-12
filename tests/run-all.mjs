#!/usr/bin/env node

// Runs the deterministic suite, then the install E2E if a Claude Code
// executable is available. Nothing here calls a model.

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// tests/install-e2e.mjs is pinned to this version in CI. Raising it invalidates
// the recorded benchmark environment, so it moves in its own issue.
const PINNED_CLAUDE_VERSION = "2.1.228";
const PINNED_VERSION_OUTPUT = `${PINNED_CLAUDE_VERSION} (Claude Code)`;

const DETERMINISTIC = [
  "plugin-contract.test.mjs",
  "evaluate.test.mjs",
  "compare.test.mjs",
  "docs-contract.test.mjs",
  "public-boundary.test.mjs",
  "release-gate.test.mjs",
];

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit", env: process.env });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}

function reportPinnedVersion(problem) {
  console.error(`Deterministic tests passed. The install E2E did not run: ${problem}`);
  console.error(`It is pinned to Claude Code ${PINNED_VERSION_OUTPUT}.`);
  console.error("Install that version, or point CLAUDE_BIN at an absolute path to it:");
  console.error(`  npm install --global @anthropic-ai/claude-code@${PINNED_CLAUDE_VERSION}`);
  console.error("  CLAUDE_BIN=/absolute/path/to/claude node tests/run-all.mjs");
  process.exit(1);
}

run([join(ROOT, "scripts", "evaluate.mjs"), "validate"]);
for (const test of DETERMINISTIC) run([join(ROOT, "tests", test)]);
run([join(ROOT, "scripts", "check-public-boundary.mjs"), "--repo", ROOT, "--working-tree"]);

const claude =
  process.env.CLAUDE_BIN || spawnSync("sh", ["-c", "command -v claude"], { encoding: "utf8" }).stdout.trim();
if (!claude) reportPinnedVersion("no Claude executable was found.");

const version = spawnSync(claude, ["--version"], { encoding: "utf8" });
const reported = (version.stdout || "").trim();
if (version.error || version.status !== 0) reportPinnedVersion("the version check failed.");
if (reported !== PINNED_VERSION_OUTPUT) reportPinnedVersion(`${reported} answered instead.`);

for (const scope of ["user", "project"]) {
  run([
    join(ROOT, "tests", "install-e2e.mjs"),
    "--scope",
    scope,
    "--claude",
    claude,
    "--expect-claude-version",
    PINNED_VERSION_OUTPUT,
  ]);
}

console.log("full suite: ok");
