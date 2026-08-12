import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GIT_READ_COMMANDS,
  THRESHOLDS,
  checkBinding,
  checkPlaceholders,
  checkShape,
  checkThresholds,
  checkVersionAlignment,
  hashDirectory,
  readAttestation,
  readGitState,
  runGate,
} from "../scripts/release-gate.mjs";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GATE_PATH = join(REPOSITORY_ROOT, "scripts", "release-gate.mjs");
const TAG = "v0.1.0";
const VERSION = "0.1.0";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function baseAttestation(overrides = {}) {
  return {
    version: 1,
    benchmark: "plain-english-blind-ab",
    release: { tag: TAG, commit: "0".repeat(40), pluginVersion: VERSION },
    execution: { claudeVersion: "2.1.228 (Claude Code)", model: "claude-sample-model", effort: "medium" },
    hashes: { style: sha256("style"), plugin: sha256("plugin"), fixtures: sha256("fixtures") },
    matrix: { cases: 12, repetitions: 2, pairs: 24, responses: 48 },
    reviews: { reviewers: 2, ratings: 48, nonTies: 40 },
    results: {
      plainEnglishNonTieRatings: 28,
      defaultNonTieRatings: 12,
      pairWins: { "plain-english": 14, default: 4, tie: 6 },
      hardGate: { "plain-english": { total: 24, pass: 24 }, default: { total: 24, pass: 22 } },
    },
    attestedBy: "operator",
    ...overrides,
  };
}

// ----- the gate can only read -------------------------------------------------

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
}

// ----- attestation shape -------------------------------------------------------

{
  assert.deepEqual(checkShape(baseAttestation(), shapeOf()), []);

  const withRaw = baseAttestation();
  withRaw.responses = { a: "a full response body" };
  assert(
    checkShape(withRaw, shapeOf()).some((problem) => /fields the gate does not know: responses/.test(problem)),
    "an attestation carrying raw output must be rejected",
  );

  const missing = baseAttestation();
  delete missing.reviews;
  assert(checkShape(missing, shapeOf()).some((problem) => /attestation\.reviews is missing/.test(problem)));

  const wrongType = baseAttestation();
  wrongType.reviews = { reviewers: "two", ratings: 48, nonTies: 40 };
  assert(checkShape(wrongType, shapeOf()).some((problem) => /reviewers must be a number/.test(problem)));

  const smuggled = baseAttestation();
  smuggled.attestedBy = "x".repeat(400);
  assert(
    checkShape(smuggled, shapeOf()).some((problem) => /attestedBy must be a short non-empty string/.test(problem)),
    "a long string could hide a response body",
  );

  const nested = baseAttestation();
  nested.results.pairWins.unexpected = 1;
  assert(checkShape(nested, shapeOf()).some((problem) => /pairWins has fields the gate does not know/.test(problem)));
}

// The shape lives in the gate; the test mirrors only what it needs to call it.
function shapeOf() {
  return {
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
}

// ----- thresholds ---------------------------------------------------------------

assert.deepEqual(checkThresholds(baseAttestation()), [], "a benchmark that meets the definition must pass");

function expectThreshold(mutate, pattern, label) {
  const attestation = baseAttestation();
  mutate(attestation);
  const problems = checkThresholds(attestation);
  assert(problems.some((problem) => pattern.test(problem)), `${label} must fail: ${problems.join(" | ") || "no problems"}`);
}

expectThreshold((a) => { a.matrix.pairs = 20; }, /matrix\.pairs must be 24/, "a short matrix");
expectThreshold((a) => { a.matrix.responses = 40; }, /matrix\.responses must be 48/, "too few responses");
expectThreshold((a) => { a.reviews.reviewers = 1; }, /reviews\.reviewers must be 2/, "a single reviewer");
expectThreshold((a) => { a.reviews.ratings = 47; }, /reviews\.ratings must be 48/, "a missing rating");
expectThreshold(
  (a) => {
    a.reviews.nonTies = 30;
    a.results.plainEnglishNonTieRatings = 20;
    a.results.defaultNonTieRatings = 10;
  },
  /nonTies must be at least 36/,
  "too many ties",
);
expectThreshold(
  (a) => {
    a.results.plainEnglishNonTieRatings = 22;
    a.results.defaultNonTieRatings = 18;
  },
  /below 60%/,
  "a share under the threshold",
);
expectThreshold((a) => { a.results.defaultNonTieRatings = 11; }, /do(?:es)? not match reviews\.nonTies/, "a sum mismatch");
expectThreshold(
  (a) => { a.results.pairWins = { "plain-english": 8, default: 8, tie: 8 }; },
  /pair wins \(8\) must exceed Default \(8\)/,
  "pair wins that do not exceed Default",
);
expectThreshold((a) => { a.results.pairWins.tie = 5; }, /pair outcomes sum to 23/, "pair outcomes that do not sum");
expectThreshold(
  (a) => { a.results.hardGate["plain-english"].pass = 23; },
  /all Plain English responses must pass/,
  "a Plain English hard-gate failure",
);
expectThreshold(
  (a) => { a.results.hardGate.default.pass = 24; a.results.hardGate["plain-english"].pass = 23; },
  /pass rate is lower than Default/,
  "a pass rate below Default",
);

assert.equal(THRESHOLDS.pairs, 24);
assert.equal(THRESHOLDS.minimumNonTies, 36);

// ----- binding and staleness -----------------------------------------------------

{
  const actual = {
    tag: TAG,
    commit: "0".repeat(40),
    pluginVersion: VERSION,
    claudeVersion: "2.1.228 (Claude Code)",
    hashes: { style: sha256("style"), plugin: sha256("plugin"), fixtures: sha256("fixtures") },
  };
  assert.deepEqual(checkBinding(baseAttestation(), actual), []);

  const movedCommit = clone(baseAttestation());
  movedCommit.release.commit = "1".repeat(40);
  assert(checkBinding(movedCommit, actual).some((problem) => /stale: it is bound to a different commit/.test(problem)));

  const movedStyle = clone(baseAttestation());
  movedStyle.hashes.style = sha256("edited style");
  assert(checkBinding(movedStyle, actual).some((problem) => /stale: the style hash has moved/.test(problem)));

  const otherTag = clone(baseAttestation());
  otherTag.release.tag = "v0.2.0";
  assert(checkBinding(otherTag, actual).some((problem) => /names a different tag/.test(problem)));

  const otherVersion = clone(baseAttestation());
  otherVersion.release.pluginVersion = "0.2.0";
  assert(checkBinding(otherVersion, actual).some((problem) => /names a different plugin version/.test(problem)));

  const otherClaude = clone(baseAttestation());
  otherClaude.execution.claudeVersion = "2.0.0 (Claude Code)";
  assert(checkBinding(otherClaude, actual).some((problem) => /different Claude Code version/.test(problem)));
  assert.deepEqual(
    checkBinding(otherClaude, { ...actual, claudeVersion: null }),
    [],
    "the Claude Code check is skipped when the caller cannot supply a version",
  );
}

// ----- version alignment ----------------------------------------------------------

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

// ----- placeholders ----------------------------------------------------------------

{
  const root = mkdtempSync(join(tmpdir(), "plain-english-placeholder-"));
  writeFileSync(join(root, "clean.md"), "A finished sentence.\n");
  writeFileSync(join(root, "unfinished.md"), `A sentence with a ${"TO" + "DO"} in it.\n`);
  assert.deepEqual(checkPlaceholders(root, ["clean.md"]), []);
  assert.equal(checkPlaceholders(root, ["unfinished.md"]).length, 1);
  rmSync(root, { recursive: true, force: true });

  // The repository's own release-facing files must be free of them.
  assert.deepEqual(checkPlaceholders(REPOSITORY_ROOT), []);
}

// ----- a synthetic release repository -----------------------------------------------

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
    "fixtures/claude-response-quality-cases.json",
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
  write("docs/EVALUATION.md", "Deterministic tests and blinded review.\n");
  write("docs/PROVENANCE.md", "Everything here is invented.\n");
  write("docs/RELEASE-CHECKLIST.md", "Run the gate.\n");
  write("fixtures/claude-response-quality-cases.json", '{"version": 1}\n');
  write("plugins/plain-english/.claude-plugin/plugin.json", `{\n  "version": "${VERSION}"\n}\n`);
  write("plugins/plain-english/output-styles/plain-english.md", "---\nname: Plain English\n---\n\nWrite plainly.\n");

  const git = (...args) => {
    const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args[0]} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Release Test");
  // Assembled at run time so this file holds no literal address for the
  // public-boundary check to flag.
  git("config", "user.email", ["release", "@", "test.invalid"].join(""));
  git("add", "-A");
  git("commit", "-q", "-m", "Synthetic release commit");
  git("tag", "-a", TAG, "-m", `Plain English ${TAG}`);
  return { repo, git, commit: git("rev-parse", "HEAD") };
}

function writeAttestation(directory, attestation) {
  const path = join(directory, "attestation.json");
  writeFileSync(path, `${JSON.stringify(attestation, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

{
  const { repo, git, commit } = makeReleaseRepo();
  const evidence = mkdtempSync(join(tmpdir(), "plain-english-attestation-"));
  const attestation = baseAttestation();
  attestation.release.commit = commit;
  attestation.hashes = {
    style: sha256(readFileSync(join(repo, "plugins/plain-english/output-styles/plain-english.md"))),
    plugin: hashDirectory(join(repo, "plugins", "plain-english")),
    fixtures: sha256(readFileSync(join(repo, "fixtures/claude-response-quality-cases.json"))),
  };
  const attestationPath = writeAttestation(evidence, attestation);

  assert.deepEqual(
    runGate({ repo, tag: TAG, attestationPath }),
    [],
    "a complete, bound, threshold-meeting release must pass",
  );

  // Missing attestation.
  assert.throws(
    () => runGate({ repo, tag: TAG, attestationPath: join(evidence, "absent.json") }),
    /ENOENT|no such file/,
    "a missing attestation must fail closed",
  );

  // Wrong file mode.
  chmodSync(attestationPath, 0o644);
  assert.throws(() => readAttestation(attestationPath, repo), /must be mode 0600/);
  chmodSync(attestationPath, 0o600);

  // Inside the repository.
  const inside = writeAttestation(repo, attestation);
  assert.throws(() => readAttestation(inside, repo), /must live outside the repository/);
  rmSync(inside);

  // Relative path.
  assert.throws(() => readAttestation("attestation.json", repo), /must be an absolute path/);

  // A dirty working tree.
  writeFileSync(join(repo, "README.md"), "Edited after the tag.\n");
  assert(
    runGate({ repo, tag: TAG, attestationPath }).some((problem) => /working tree is not clean/.test(problem)),
    "a dirty tree must fail",
  );
  git("checkout", "--", "README.md");

  // A tag that does not exist, and one that is not annotated.
  assert(
    runGate({ repo, tag: "v9.9.9", attestationPath }).some((problem) => /does not exist/.test(problem)),
  );
  git("tag", "v0.1.1");
  const lightweight = readGitState(repo, "v0.1.1");
  assert(lightweight.problems.some((problem) => /is not annotated/.test(problem)));

  // A tag that does not point at the release commit.
  git("commit", "-q", "--allow-empty", "-m", "A commit after the tag");
  assert(
    readGitState(repo, TAG).problems.some((problem) => /does not point at the release commit/.test(problem)),
    "a tag behind HEAD must fail",
  );

  // A branch that is not main.
  git("checkout", "-q", "-b", "release-attempt");
  assert(readGitState(repo, TAG).problems.some((problem) => /must be cut from main/.test(problem)));

  rmSync(repo, { recursive: true, force: true });
  rmSync(evidence, { recursive: true, force: true });
}

// ----- the CLI reports and refuses ----------------------------------------------------

{
  const { repo, commit } = makeReleaseRepo();
  const evidence = mkdtempSync(join(tmpdir(), "plain-english-attestation-cli-"));
  const attestation = baseAttestation();
  attestation.release.commit = commit;
  attestation.hashes = {
    style: sha256(readFileSync(join(repo, "plugins/plain-english/output-styles/plain-english.md"))),
    plugin: hashDirectory(join(repo, "plugins", "plain-english")),
    fixtures: sha256(readFileSync(join(repo, "fixtures/claude-response-quality-cases.json"))),
  };
  const attestationPath = writeAttestation(evidence, attestation);

  const passed = spawnSync(
    process.execPath,
    [GATE_PATH, "--repo", repo, "--tag", TAG, "--attestation", attestationPath],
    { encoding: "utf8" },
  );
  assert.equal(passed.status, 0, `the gate should pass: ${passed.stderr}`);
  assert.match(passed.stdout, /Release gate passed/);
  assert.match(passed.stdout, /did not create a remote, push a commit or a tag, or publish a release/);

  const belowThreshold = clone(attestation);
  belowThreshold.results.plainEnglishNonTieRatings = 20;
  belowThreshold.results.defaultNonTieRatings = 20;
  const failing = spawnSync(
    process.execPath,
    [GATE_PATH, "--repo", repo, "--tag", TAG, "--attestation", writeAttestation(evidence, belowThreshold)],
    { encoding: "utf8" },
  );
  assert.equal(failing.status, 1);
  assert.match(failing.stderr, /Release gate failed/);
  assert.match(failing.stderr, /below 60%/);

  const malformed = spawnSync(process.execPath, [GATE_PATH, "--repo", repo], { encoding: "utf8" });
  assert.equal(malformed.status, 2, "an incomplete invocation must fail closed");

  rmSync(repo, { recursive: true, force: true });
  rmSync(evidence, { recursive: true, force: true });
}

// ----- this repository cannot be released yet -------------------------------------------

{
  const result = spawnSync(
    process.execPath,
    [GATE_PATH, "--repo", REPOSITORY_ROOT, "--tag", "v0.1.0", "--attestation", join(tmpdir(), "no-attestation.json")],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0, "without a benchmark attestation the gate must not pass");
}

console.log("release gate: ok");
