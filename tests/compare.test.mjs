import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CHOICES,
  VARIANTS,
  aggregate,
  assertEvidencePathOutsideRepository,
  assertPacketCarriesNoMetadata,
  buildEvidence,
  buildExecutionArgs,
  buildExecutionEnv,
  buildPacket,
  buildRunPlan,
  executionSeed,
  makeRng,
  parseArgs,
  reviewerSeed,
  shuffle,
  variantSettings,
  verifyCommitments,
} from "../scripts/compare.mjs";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const COMPARE_PATH = join(REPOSITORY_ROOT, "scripts", "compare.mjs");
const FIXTURES = JSON.parse(
  readFileSync(join(REPOSITORY_ROOT, "fixtures", "claude-response-quality-cases.json"), "utf8"),
);
const SEED = "a1b2c3d4e5f60718";
const CASE_IDS = ["checkout-status", "nightly-job-failure", "dry-run-question"];

assert.equal(FIXTURES.cases.length, 14, "the documented optional comparison must stay aligned with the fixture set");

function canonical(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const IDENTITY = {
  claudeVersion: "2.1.228 (Claude Code)",
  model: "claude-sample-model",
  effort: "medium",
  fixturesSha256: sha256("fixtures"),
  styleSha256: sha256("style"),
};

function outputFor(execution) {
  return {
    body: `Response for ${execution.caseId} rep ${execution.repetition} from ${execution.variant}.`,
    identity: IDENTITY,
    settingsSha256: sha256(canonical(variantSettings(execution.variant))),
  };
}

function outputsFor(plan, override = () => ({})) {
  return new Map(
    plan.map((execution) => [
      `${execution.caseId}|${execution.repetition}|${execution.variant}`,
      { ...outputFor(execution), ...override(execution) },
    ]),
  );
}

function makeEvidence({ repetitions = 2 } = {}) {
  const plan = buildRunPlan({ caseIds: CASE_IDS, repetitions, seed: SEED });
  return { plan, evidence: buildEvidence({ plan, outputs: outputsFor(plan), salt: "s".repeat(64), identity: IDENTITY }) };
}

// ----- argument parsing and the model-call guard -----------------------------

{
  const parsed = parseArgs(["run", "--evidence", "/tmp/e", "--case", "a", "--case", "b", "--allow-model-calls"]);
  assert.deepEqual(parsed._, ["run"]);
  assert.deepEqual(parsed.case, ["a", "b"]);
  assert.equal(parsed.allowModelCalls, true);
  assert.throws(() => parseArgs(["run", "--evidence"]), /Missing value for --evidence/);
}

{
  // Without the flag the command must stop before it can reach an executable.
  // --claude points at a path that does not exist, so a call would surface as a
  // different error than the refusal.
  const result = spawnSync(
    process.execPath,
    [
      COMPARE_PATH,
      "run",
      "--evidence",
      join(tmpdir(), "plain-english-guard-evidence"),
      "--claude",
      "/nonexistent/claude",
      "--model",
      "claude-sample-model",
      "--effort",
      "medium",
      "--seed",
      SEED,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2, "run without --allow-model-calls must exit 2");
  assert.match(result.stderr, /model calls require --allow-model-calls/);
}

// ----- evidence location ----------------------------------------------------

assert.throws(
  () => assertEvidencePathOutsideRepository(join(REPOSITORY_ROOT, "evidence")),
  /must live outside the repository/,
  "evidence inside the working tree must be refused",
);
assert.throws(() => assertEvidencePathOutsideRepository("relative/path"), /must be an absolute path/);
assert.equal(assertEvidencePathOutsideRepository(tmpdir()), tmpdir());

// ----- reproducible, independent randomization ------------------------------

{
  const fullPlan = buildRunPlan({
    caseIds: FIXTURES.cases.map((testCase) => testCase.id),
    repetitions: 2,
    seed: SEED,
  });
  assert.equal(fullPlan.length, 56, "14 cases by 2 repetitions by 2 variants must produce 56 responses");
}

{
  const first = buildRunPlan({ caseIds: CASE_IDS, repetitions: 2, seed: SEED });
  const second = buildRunPlan({ caseIds: CASE_IDS, repetitions: 2, seed: SEED });
  assert.deepEqual(first, second, "the same seed must produce the same execution order");
  assert.equal(first.length, CASE_IDS.length * 2 * VARIANTS.length);

  const other = buildRunPlan({ caseIds: CASE_IDS, repetitions: 2, seed: "ffffffffffffffff" });
  assert.notDeepEqual(first, other, "a different seed must produce a different execution order");

  const counts = new Map();
  for (const execution of first) {
    const key = `${execution.caseId}|${execution.repetition}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  assert(
    [...counts.values()].every((count) => count === VARIANTS.length),
    "every case and repetition must appear once per variant",
  );

  assert.notEqual(executionSeed(SEED), reviewerSeed(SEED, "reviewer-a"));
  assert.notEqual(reviewerSeed(SEED, "reviewer-a"), reviewerSeed(SEED, "reviewer-b"));
  assert.equal(reviewerSeed(SEED, "reviewer-a"), reviewerSeed(SEED, "reviewer-a"));

  assert.throws(() => buildRunPlan({ caseIds: [], repetitions: 1, seed: SEED }), /caseIds must not be empty/);
  assert.throws(() => buildRunPlan({ caseIds: ["a", "a"], repetitions: 1, seed: SEED }), /caseIds must be unique/);
  assert.throws(() => buildRunPlan({ caseIds: ["a"], repetitions: 0, seed: SEED }), /repetitions must be/);
  assert.throws(() => buildRunPlan({ caseIds: ["a"], repetitions: 1, seed: "SHORT" }), /seed must be/);

  const rng = makeRng("seed");
  const sample = Array.from({ length: 5 }, rng);
  assert(sample.every((value) => value >= 0 && value < 1));
  assert.deepEqual(Array.from({ length: 5 }, makeRng("seed")), sample, "the stream must be reproducible");
  assert.deepEqual(shuffle([1, 2, 3, 4], makeRng("x")).sort(), [1, 2, 3, 4], "shuffle must preserve members");
}

// ----- evidence construction -------------------------------------------------

const { plan, evidence } = makeEvidence();

{
  assert.equal(evidence.runFile.responseCount, CASE_IDS.length * 2 * VARIANTS.length);
  assert.equal(evidence.runFile.pairCount, CASE_IDS.length * 2);
  assert.equal(Object.keys(evidence.responsesFile.responses).length, evidence.runFile.responseCount);
  for (const pair of Object.values(evidence.mappingFile.pairs)) {
    assert.deepEqual(Object.keys(pair.responseIds).sort(), [...VARIANTS].sort(), "each pair needs both variants");
  }
  // Opaque ids must not repeat the case id or the variant.
  for (const responseId of Object.keys(evidence.responsesFile.responses)) {
    assert.match(responseId, /^[0-9a-f]{32}$/);
    for (const caseId of CASE_IDS) assert(!responseId.includes(caseId));
  }
  verifyCommitments(evidence.commitments, evidence.responsesFile, evidence.mappingFile);
}

assert.throws(
  () => buildEvidence({ plan, outputs: outputsFor(plan.slice(1)), salt: "s".repeat(64), identity: IDENTITY }),
  /missing output for/,
  "a missing execution must be rejected",
);

assert.throws(
  () => {
    const unbalanced = plan.filter(
      (execution) => !(execution.caseId === CASE_IDS[0] && execution.repetition === 1 && execution.variant === "default"),
    );
    return buildEvidence({ plan: unbalanced, outputs: outputsFor(unbalanced), salt: "s".repeat(64), identity: IDENTITY });
  },
  /is unbalanced, missing: default/,
  "an unbalanced pair must be rejected",
);

assert.throws(
  () => buildEvidence({ plan: [...plan, plan[0]], outputs: outputsFor(plan), salt: "s".repeat(64), identity: IDENTITY }),
  /duplicate execution for/,
  "a duplicated execution must be rejected",
);

assert.throws(
  () =>
    buildEvidence({
      plan,
      outputs: outputsFor(plan, (execution) =>
        execution.variant === "plain-english" ? { identity: { ...IDENTITY, effort: "high" } } : {},
      ),
      salt: "s".repeat(64),
      identity: IDENTITY,
    }),
  /execution identity drifted/,
  "a pair whose members differ by more than the variant must be rejected",
);

assert.throws(
  () =>
    buildEvidence({
      plan,
      outputs: outputsFor(plan, () => ({ settingsSha256: sha256("tampered") })),
      salt: "s".repeat(64),
      identity: IDENTITY,
    }),
  /settings drifted/,
  "settings that do not match the variant must be rejected",
);

assert.throws(
  () => buildEvidence({ plan, outputs: outputsFor(plan, () => ({ body: "   " })), salt: "s".repeat(64), identity: IDENTITY }),
  /empty output for/,
);

assert.throws(() => buildEvidence({ plan, outputs: outputsFor(plan), salt: "short", identity: IDENTITY }), /salt must be/);

// Hash mismatch: any edit after the commitment must be caught.
assert.throws(
  () => {
    const tampered = JSON.parse(JSON.stringify(evidence.responsesFile));
    const first = Object.keys(tampered.responses)[0];
    tampered.responses[first].body = "edited after the commitment";
    return verifyCommitments(evidence.commitments, tampered, evidence.mappingFile);
  },
  /responses\.json does not match its commitment hash/,
);
assert.throws(
  () => {
    const tampered = JSON.parse(JSON.stringify(evidence.mappingFile));
    const first = Object.keys(tampered.responses)[0];
    tampered.responses[first].variant = "default";
    return verifyCommitments(evidence.commitments, evidence.responsesFile, tampered);
  },
  /mapping\.json does not match its commitment hash/,
);

// ----- rating packets --------------------------------------------------------

const packetA = buildPacket({
  reviewer: "reviewer-a",
  seed: SEED,
  responsesFile: evidence.responsesFile,
  mappingFile: evidence.mappingFile,
});
const packetB = buildPacket({
  reviewer: "reviewer-b",
  seed: SEED,
  responsesFile: evidence.responsesFile,
  mappingFile: evidence.mappingFile,
});

{
  assert.equal(packetA.items.length, evidence.runFile.pairCount);
  assert.equal(new Set(packetA.items.map((item) => item.pairId)).size, packetA.items.length);
  assertPacketCarriesNoMetadata(packetA, evidence.mappingFile);
  assertPacketCarriesNoMetadata(packetB, evidence.mappingFile);

  const serialized = JSON.stringify(packetA.items.map((item) => ({ ...item, left: item.left.responseId, right: item.right.responseId })));
  for (const marker of [...VARIANTS, ...CASE_IDS, IDENTITY.model, IDENTITY.effort, IDENTITY.claudeVersion]) {
    assert(!serialized.includes(marker), `packet identifiers must not carry ${marker}`);
  }

  // Reviewers get independent orders, so one reviewer's layout says nothing
  // about another's.
  const orderA = packetA.items.map((item) => item.pairId);
  const orderB = packetB.items.map((item) => item.pairId);
  assert.notDeepEqual(orderA, orderB, "reviewers must see different pair orders");
  const sideA = new Map(packetA.items.map((item) => [item.pairId, item.left.responseId]));
  const flipped = packetB.items.filter((item) => sideA.get(item.pairId) !== item.left.responseId);
  assert(flipped.length > 0, "reviewers must not share one left/right layout");

  const repeat = buildPacket({
    reviewer: "reviewer-a",
    seed: SEED,
    responsesFile: evidence.responsesFile,
    mappingFile: evidence.mappingFile,
  });
  assert.deepEqual(repeat, packetA, "a reviewer's layout must be reproducible");
}

assert.throws(
  () => assertPacketCarriesNoMetadata({ items: [{ ...packetA.items[0], caseId: CASE_IDS[0] }] }, evidence.mappingFile),
  /packet item has unexpected fields/,
  "a leaked case id must be rejected",
);
assert.throws(
  () =>
    assertPacketCarriesNoMetadata(
      { items: [{ ...packetA.items[0], left: { ...packetA.items[0].left, variant: "default" } }] },
      evidence.mappingFile,
    ),
  /packet left has unexpected fields/,
  "a leaked variant must be rejected",
);
assert.throws(
  () =>
    assertPacketCarriesNoMetadata(
      { items: [{ ...packetA.items[0], left: { responseId: "plain-english", body: "x" } }] },
      evidence.mappingFile,
    ),
  /not an opaque digest/,
);
assert.throws(
  () => buildPacket({ reviewer: "../escape", seed: SEED, responsesFile: evidence.responsesFile, mappingFile: evidence.mappingFile }),
  /reviewer must be a short name/,
);

// ----- aggregation -----------------------------------------------------------

const packets = { "reviewer-a": packetA, "reviewer-b": packetB };

function ratingsPreferring(packet, variant, { tiePairIds = [] } = {}) {
  return {
    version: 1,
    reviewer: packet.reviewer,
    ratings: packet.items.map((item) => {
      if (tiePairIds.includes(item.pairId)) return { pairId: item.pairId, choice: "tie" };
      const leftVariant = evidence.mappingFile.responses[item.left.responseId].variant;
      return { pairId: item.pairId, choice: leftVariant === variant ? "left" : "right" };
    }),
  };
}

{
  const report = aggregate({
    mappingFile: evidence.mappingFile,
    responsesFile: evidence.responsesFile,
    packets,
    ratingFiles: [ratingsPreferring(packetA, "plain-english"), ratingsPreferring(packetB, "plain-english")],
    fixtures: FIXTURES,
  });
  assert.equal(report.pairs, evidence.runFile.pairCount);
  assert.equal(report.ratings, evidence.runFile.pairCount * 2);
  assert.equal(report.nonTies, evidence.runFile.pairCount * 2);
  assert.equal(report.totals["plain-english"], evidence.runFile.pairCount * 2);
  assert.equal(report.totals.default, 0);
  assert.equal(report.plainEnglishNonTieShare, 1);
  assert.equal(report.pairOutcomes["plain-english"], evidence.runFile.pairCount);
  assert.equal(report.pairOutcomes.tie, 0);
  assert(report.hardGate, "the aggregate must report the factual hard gate");
  assert.equal(report.hardGate.default.total, evidence.runFile.pairCount);
  assert.equal(report.hardGate["plain-english"].total, evidence.runFile.pairCount);
}

{
  // Reviewers who disagree produce a tie at the pair level even though both
  // ratings are non-ties.
  const report = aggregate({
    mappingFile: evidence.mappingFile,
    responsesFile: evidence.responsesFile,
    packets,
    ratingFiles: [ratingsPreferring(packetA, "plain-english"), ratingsPreferring(packetB, "default")],
  });
  assert.equal(report.nonTies, evidence.runFile.pairCount * 2);
  assert.equal(report.pairOutcomes.tie, evidence.runFile.pairCount);
  assert.equal(report.pairOutcomes["plain-english"], 0);
  assert.equal(report.pairOutcomes.default, 0);
  assert.equal(report.plainEnglishNonTieShare, 0.5);
  assert.equal(report.hardGate, undefined, "the hard gate is only reported when fixtures are supplied");
}

{
  const tied = packetA.items[0].pairId;
  const report = aggregate({
    mappingFile: evidence.mappingFile,
    responsesFile: evidence.responsesFile,
    packets,
    ratingFiles: [
      ratingsPreferring(packetA, "plain-english", { tiePairIds: [tied] }),
      ratingsPreferring(packetB, "plain-english", { tiePairIds: [tied] }),
    ],
  });
  assert.equal(report.totals.tie, 2);
  assert.equal(report.nonTies, (evidence.runFile.pairCount - 1) * 2);
  assert.equal(report.pairOutcomes.tie, 1);
}

function expectAggregateError(ratingFiles, pattern, label) {
  assert.throws(
    () =>
      aggregate({
        mappingFile: evidence.mappingFile,
        responsesFile: evidence.responsesFile,
        packets,
        ratingFiles,
      }),
    pattern,
    label,
  );
}

expectAggregateError(
  [
    { version: 1, reviewer: "reviewer-a", ratings: ratingsPreferring(packetA, "plain-english").ratings.slice(1) },
    ratingsPreferring(packetB, "plain-english"),
  ],
  /left 1 pairs unrated/,
  "an incomplete rating set must be rejected",
);

expectAggregateError(
  [
    (() => {
      const base = ratingsPreferring(packetA, "plain-english");
      return { ...base, ratings: [...base.ratings, base.ratings[0]] };
    })(),
    ratingsPreferring(packetB, "plain-english"),
  ],
  /rated .* more than once/,
  "a duplicated rating must be rejected",
);

expectAggregateError(
  [
    (() => {
      const base = ratingsPreferring(packetA, "plain-english");
      return { ...base, ratings: [...base.ratings.slice(1), { pairId: "f".repeat(32), choice: "left" }] };
    })(),
    ratingsPreferring(packetB, "plain-english"),
  ],
  /rated an unknown pair/,
  "an unknown pair must be rejected",
);

expectAggregateError(
  [
    (() => {
      const base = ratingsPreferring(packetA, "plain-english");
      return { ...base, ratings: base.ratings.map((rating, index) => (index ? rating : { ...rating, choice: "best" })) };
    })(),
    ratingsPreferring(packetB, "plain-english"),
  ],
  /invalid choice/,
  "an invalid choice must be rejected",
);

expectAggregateError(
  [ratingsPreferring(packetA, "plain-english"), ratingsPreferring(packetA, "default")],
  /submitted more than one rating file/,
  "one reviewer must not submit twice",
);

expectAggregateError(
  [{ version: 1, reviewer: "reviewer-c", ratings: [] }],
  /no packet was issued to reviewer reviewer-c/,
  "a rating from an unissued reviewer must be rejected",
);

assert.deepEqual(CHOICES, ["left", "right", "tie"]);

// ----- execution isolation ---------------------------------------------------

{
  const settingsPath = "/tmp/isolated/run-settings.json";
  const shared = { prompt: "Explain the sample change.", model: "claude-sample-model", effort: "medium", settingsPath };
  const defaultArgs = buildExecutionArgs({ ...shared, variant: "default" });
  const plainArgs = buildExecutionArgs({ ...shared, variant: "plain-english" });

  for (const args of [defaultArgs, plainArgs]) {
    assert(args.includes("--strict-mcp-config"), "MCP must be restricted");
    assert.equal(
      args[args.indexOf("--mcp-config") + 1],
      '{"mcpServers":{}}',
      "no MCP server may enter the run, and Claude Code rejects a bare {}",
    );
    assert.equal(args[args.indexOf("--settings") + 1], settingsPath, "settings must come from the isolated file");
    assert.equal(args[args.indexOf("--setting-sources") + 1], "", "no settings source may enter the run");
    assert.equal(args[args.indexOf("--model") + 1], shared.model);
    assert.equal(args[args.indexOf("--effort") + 1], shared.effort);
    assert.equal(args[args.indexOf("--tools") + 1], "", "built-in tools must be disabled");
    assert(args.includes("--disable-slash-commands"), "skills must be disabled");
    assert(args.includes("--no-session-persistence"), "comparison sessions must not be saved");
    // --mcp-config is variadic, so the prompt has to lead, not trail.
    assert.equal(args[0], shared.prompt, "the prompt must be the first argument");
    assert.equal(args.indexOf(shared.prompt), 0);
    assert(args.indexOf("--mcp-config") < args.length - 1);
  }
  assert.throws(() => buildExecutionArgs({ ...shared, variant: "default", prompt: "  " }), /prompt must not be empty/);
  assert.equal(defaultArgs.includes("--plugin-dir"), false, "the default variant must load no plugin");
  assert(plainArgs.includes("--plugin-dir"), "the plain-english variant must load the plugin");
  assert.deepEqual(
    plainArgs.filter((argument, index) => !(argument === "--plugin-dir" || plainArgs[index - 1] === "--plugin-dir")),
    defaultArgs,
    "only the plugin flag may differ between the two variants",
  );
  assert.throws(() => buildExecutionArgs({ ...shared, variant: "other" }), /unknown variant/);

  assert.deepEqual(variantSettings("default"), {});
  assert.deepEqual(variantSettings("plain-english"), { outputStyle: "plain-english:Plain English" });
  assert.throws(() => variantSettings("other"), /unknown variant/);

  const sandbox = { home: "/tmp/s/home", config: "/tmp/s/config", cache: "/tmp/s/cache", project: "/tmp/s/project" };
  const env = buildExecutionEnv(
    {
      HOME: "/opt/operator-home",
      CLAUDE_CONFIG_DIR: "/opt/operator-home/.claude",
      AWS_ACCESS_KEY_ID: "leak",
      GH_TOKEN: "leak",
      RANDOM_OPERATOR_VALUE: "leak",
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      ANTHROPIC_API_KEY: "test-auth-value",
    },
    sandbox,
  );
  assert.equal(env.HOME, sandbox.home, "the operator HOME must not reach the run");
  assert.equal(env.CLAUDE_CONFIG_DIR, sandbox.config, "the operator config directory must not reach the run");
  assert.equal(env.CLAUDE_CODE_PLUGIN_CACHE_DIR, sandbox.cache);
  assert.equal("AWS_ACCESS_KEY_ID" in env, false, "unrelated provider credentials must be dropped");
  assert.equal("GH_TOKEN" in env, false, "forge credentials must be dropped");
  assert.equal("RANDOM_OPERATOR_VALUE" in env, false, "unknown shell state must be dropped");
  assert.equal(env.PATH, "/usr/bin", "the executable path must survive");
  assert.equal(env.LANG, "en_US.UTF-8", "the locale must survive");
  assert.equal(env.ANTHROPIC_API_KEY, "test-auth-value", "supported model authentication must survive");
  assert.deepEqual(
    Object.keys(env).sort(),
    [
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "CLAUDE_CODE_PLUGIN_CACHE_DIR",
      "CLAUDE_CONFIG_DIR",
      "DISABLE_TELEMETRY",
      "HOME",
      "LANG",
      "NO_COLOR",
      "PATH",
    ].sort(),
    "the child environment must remain an allowlist",
  );
  assert.throws(
    () => buildExecutionEnv({}, { ...sandbox, config: join(process.env.HOME ?? "/root", ".claude", "config") }),
    /escaped into the real ~\/\.claude/,
  );
}

// ----- the packet CLI freezes the evidence -----------------------------------

{
  const evidenceRoot = mkdtempSync(join(tmpdir(), "plain-english-evidence-"));
  const write = (name, value) => {
    const target = join(evidenceRoot, name);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, canonical(value), { mode: 0o600 });
    chmodSync(target, 0o600);
  };
  write("run.json", { ...evidence.runFile, seed: SEED });
  write("responses.json", evidence.responsesFile);
  write("mapping.json", evidence.mappingFile);
  write("commitments.json", evidence.commitments);
  writeFileSync(join(evidenceRoot, "salt"), `${"s".repeat(64)}\n`, { mode: 0o600 });
  chmodSync(join(evidenceRoot, "salt"), 0o600);

  const runCli = (args) => spawnSync(process.execPath, [COMPARE_PATH, ...args], { encoding: "utf8" });

  const issued = runCli(["packet", "--evidence", evidenceRoot, "--reviewer", "reviewer-a"]);
  assert.equal(issued.status, 0, `packet failed: ${issued.stderr}`);
  const packetPath = join(evidenceRoot, "packets", "reviewer-a.json");
  assert.equal(lstatSync(packetPath).mode & 0o777, 0o600, "the packet must be written mode 0600");
  for (const name of ["responses.json", "mapping.json", "salt", "commitments.json"]) {
    assert.equal(lstatSync(join(evidenceRoot, name)).mode & 0o777, 0o600, `${name} must stay mode 0600`);
  }
  assertPacketCarriesNoMetadata(JSON.parse(readFileSync(packetPath, "utf8")), evidence.mappingFile);

  const secondPacket = runCli(["packet", "--evidence", evidenceRoot, "--reviewer", "reviewer-b"]);
  assert.equal(secondPacket.status, 0, `packet failed: ${secondPacket.stderr}`);
  assert.deepEqual(
    JSON.parse(readFileSync(join(evidenceRoot, "packets", "reviewer-b.json"), "utf8")),
    packetB,
    "the CLI packet must match the reproducible layout",
  );

  const ratingPaths = [packetA, packetB].map((packet) => {
    const path = join(evidenceRoot, `ratings-${packet.reviewer}.json`);
    writeFileSync(path, canonical(ratingsPreferring(packet, "plain-english")), { mode: 0o600 });
    return path;
  });
  const aggregated = runCli([
    "aggregate",
    "--evidence",
    evidenceRoot,
    "--ratings",
    ratingPaths[0],
    "--ratings",
    ratingPaths[1],
    "--format",
    "json",
  ]);
  assert.equal(aggregated.status, 0, `aggregate failed: ${aggregated.stderr}`);
  const report = JSON.parse(aggregated.stdout);
  assert.deepEqual(report.reviewers.sort(), ["reviewer-a", "reviewer-b"]);
  assert.equal(report.pairOutcomes["plain-english"], evidence.runFile.pairCount);
  assert.equal(report.plainEnglishNonTieShare, 1);

  const repeat = runCli(["packet", "--evidence", evidenceRoot, "--reviewer", "reviewer-a"]);
  assert.equal(repeat.status, 1);
  assert.match(repeat.stderr, /already issued to reviewer-a/);

  // Rating has begun, so a new run must not overwrite the responses or mapping.
  const rerun = runCli([
    "run",
    "--evidence",
    evidenceRoot,
    "--claude",
    "/nonexistent/claude",
    "--model",
    "claude-sample-model",
    "--effort",
    "medium",
    "--seed",
    SEED,
    "--allow-model-calls",
  ]);
  assert.equal(rerun.status, 1);
  assert.match(rerun.stderr, /rating has begun/);

  // A tampered responses file must fail the commitment check.
  const tampered = JSON.parse(readFileSync(join(evidenceRoot, "responses.json"), "utf8"));
  tampered.responses[Object.keys(tampered.responses)[0]].body = "swapped after the fact";
  write("responses.json", tampered);
  const afterTamper = runCli(["packet", "--evidence", evidenceRoot, "--reviewer", "reviewer-b"]);
  assert.equal(afterTamper.status, 1);
  assert.match(afterTamper.stderr, /does not match its commitment hash/);

  rmSync(evidenceRoot, { recursive: true, force: true });
}

console.log("comparison harness: ok");
