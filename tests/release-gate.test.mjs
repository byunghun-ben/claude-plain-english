import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GIT_READ_COMMANDS,
  checkPlaceholders,
  checkVersionAlignment,
  readGitState,
  runGate,
} from "../scripts/release-gate.mjs";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GATE_PATH = join(REPOSITORY_ROOT, "scripts", "release-gate.mjs");
const TAG = "v0.1.0";
const VERSION = "0.1.0";

// The release gate may inspect Git state, but it may not mutate the repository.
{
  for (const forbidden of ["push", "remote", "tag", "commit", "clone", "fetch"]) {
    assert.equal(GIT_READ_COMMANDS.has(forbidden), false, `the gate must not be allowed to run git ${forbidden}`);
  }
  const source = readFileSync(GATE_PATH, "utf8");
  assert.equal((source.match(/spawnSync\(/g) || []).length, 1, "the gate must have exactly one subprocess call site");
  assert(source.includes("GIT_READ_COMMANDS.has(args[0])"), "that call site must be guarded by the allowlist");
  for (const forbidden of ["node:http", "node:https", "node:net", "fetch("]) {
    assert(!source.includes(forbidden), `the gate must not reference ${forbidden}`);
  }
  assert(!source.includes("attestation"), "a paid comparison attestation must not be a release requirement");
}

// Release metadata must agree.
{
  const changelog = `# Changelog\n\n## v${VERSION}\n\nAdded things.\n`;
  assert.deepEqual(checkVersionAlignment({ tag: TAG, manifestVersion: VERSION, changelog }), []);
  assert(
    checkVersionAlignment({ tag: TAG, manifestVersion: "0.0.0", changelog }).some((problem) =>
      /plugin manifest is 0\.0\.0/.test(problem),
    ),
  );
  assert(
    checkVersionAlignment({ tag: TAG, manifestVersion: VERSION, changelog: "# Changelog\n\n## Unreleased\n" }).some(
      (problem) => /changelog has no section for 0\.1\.0/.test(problem),
    ),
  );
  assert(
    checkVersionAlignment({ tag: "0.1.0", manifestVersion: VERSION, changelog }).some((problem) =>
      /not a v-prefixed semantic version/.test(problem),
    ),
  );
}

// Release-facing documents must not contain placeholders.
{
  const root = mkdtempSync(join(tmpdir(), "plain-english-placeholder-"));
  writeFileSync(join(root, "clean.md"), "A finished sentence.\n");
  writeFileSync(join(root, "unfinished.md"), `A sentence with a ${"TO" + "DO"} in it.\n`);
  assert.deepEqual(checkPlaceholders(root, ["clean.md"]), []);
  assert.equal(checkPlaceholders(root, ["unfinished.md"]).length, 1);
  rmSync(root, { recursive: true, force: true });
  assert.deepEqual(checkPlaceholders(REPOSITORY_ROOT), []);
}

function makeReleaseRepo() {
  const repo = mkdtempSync(join(tmpdir(), "plain-english-release-"));
  const write = (path, contents) => {
    const absolute = join(repo, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  };
  const files = [
    "docs/PUBLICATION-CONTRACT.md",
    "README.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "docs/EVALUATION.md",
    "docs/PROVENANCE.md",
    "docs/RELEASE-CHECKLIST.md",
    "plugins/plain-english/.claude-plugin/plugin.json",
    "plugins/plain-english/output-styles/plain-english.md",
  ];
  write(
    "docs/PUBLICATION-CONTRACT.md",
    ["# Publication contract", "", "## Path allowlist", "", ...files.map((file) => `- \`${file}\``), "", "## Never published", "", "Everything else.", ""].join("\n"),
  );
  write("README.md", "A synthetic release repository.\n");
  write("CHANGELOG.md", `# Changelog\n\n## v${VERSION}\n\nFirst release.\n`);
  write("CONTRIBUTING.md", "Contribute carefully.\n");
  write("SECURITY.md", "Report privately.\n");
  write("docs/EVALUATION.md", "Deterministic tests and optional blinded review.\n");
  write("docs/PROVENANCE.md", "Everything here is invented.\n");
  write("docs/RELEASE-CHECKLIST.md", "Run the gate.\n");
  write("plugins/plain-english/.claude-plugin/plugin.json", `{\n  "version": "${VERSION}"\n}\n`);
  write("plugins/plain-english/output-styles/plain-english.md", "---\nname: Plain English\n---\n\nWrite plainly.\n");

  const git = (...args) => {
    const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args[0]} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Release Test");
  git("config", "user.email", ["release", "@", "test.invalid"].join(""));
  git("add", "-A");
  git("commit", "-q", "-m", "Synthetic release commit");
  git("tag", "-a", TAG, "-m", `Plain English ${TAG}`);
  return { repo, git };
}

{
  const { repo, git } = makeReleaseRepo();
  assert.deepEqual(runGate({ repo, tag: TAG }), [], "a clean, aligned, annotated release must pass");

  writeFileSync(join(repo, "README.md"), "Edited after the tag.\n");
  assert(
    runGate({ repo, tag: TAG }).some((problem) => /working tree is not clean/.test(problem)),
    "a dirty tree must fail",
  );
  git("checkout", "--", "README.md");

  assert(runGate({ repo, tag: "v9.9.9" }).some((problem) => /does not exist/.test(problem)));
  git("tag", "v0.1.1");
  assert(readGitState(repo, "v0.1.1").problems.some((problem) => /is not annotated/.test(problem)));

  git("commit", "-q", "--allow-empty", "-m", "A commit after the tag");
  assert(
    readGitState(repo, TAG).problems.some((problem) => /does not point at the release commit/.test(problem)),
    "a tag behind HEAD must fail",
  );

  git("checkout", "-q", "-b", "release-attempt");
  assert(readGitState(repo, TAG).problems.some((problem) => /must be cut from main/.test(problem)));
  rmSync(repo, { recursive: true, force: true });
}

// The CLI accepts only repository and tag, and passing never performs release actions.
{
  const { repo } = makeReleaseRepo();
  const passed = spawnSync(process.execPath, [GATE_PATH, "--repo", repo, "--tag", TAG], { encoding: "utf8" });
  assert.equal(passed.status, 0, `the gate should pass: ${passed.stderr}`);
  assert.match(passed.stdout, /Release gate passed/);
  assert.match(passed.stdout, /did not create a remote, push a commit or a tag, or publish a release/);

  const malformed = spawnSync(process.execPath, [GATE_PATH, "--repo", repo], { encoding: "utf8" });
  assert.equal(malformed.status, 2, "an incomplete invocation must fail closed");
  rmSync(repo, { recursive: true, force: true });
}

// This unreleased branch cannot pass the release gate yet.
{
  const result = spawnSync(process.execPath, [GATE_PATH, "--repo", REPOSITORY_ROOT, "--tag", "v0.1.0"], {
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0, "the unreleased repository must not pass");
}

console.log("release gate: ok");
