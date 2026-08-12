#!/usr/bin/env node

// Blinded comparison harness: Default versus Plain English.
//
//   compare.mjs run       --evidence DIR --claude PATH --model NAME --effort LEVEL
//                         --seed HEX --allow-model-calls [--repetitions N] [--case ID]...
//   compare.mjs packet    --evidence DIR --reviewer NAME
//   compare.mjs aggregate --evidence DIR --ratings PATH [--ratings PATH]... [--format text|json]
//
// `run` is the only command that can reach a model, and it refuses to do so
// without --allow-model-calls. Raw responses, the variant mapping, and the salt
// stay in the evidence directory, which must live outside this repository.

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { scoreOutput, validateFixtures } from "./evaluate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = join(ROOT, "plugins", "plain-english");
const STYLE_PATH = join(PLUGIN_ROOT, "output-styles", "plain-english.md");
const DEFAULT_FIXTURES = join(ROOT, "fixtures", "claude-response-quality-cases.json");

export const VARIANTS = ["default", "plain-english"];
export const CHOICES = ["left", "right", "tie"];
const STYLE_SETTING_VALUE = "plain-english:Plain English";
// Claude Code rejects a bare {} here: the config must declare the mcpServers
// record, empty in this case.
const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';
const RATING_BEGUN_MARKER = "rating-begun";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
// A comparison run needs a path to launch Claude Code, locale settings for
// stable text handling, and one supported Anthropic credential. Everything else
// from the operator's shell is excluded by default.
const PASSTHROUGH_ENV_KEYS = [
  "PATH",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
];

function usage(exitCode = 0) {
  const message = `Usage:
  compare.mjs run       --evidence DIR --claude PATH --model NAME --effort LEVEL
                        --seed HEX --allow-model-calls [--repetitions N] [--case ID]...
                        [--timeout SEC] [--fixtures PATH]
  compare.mjs packet    --evidence DIR --reviewer NAME
  compare.mjs aggregate --evidence DIR --ratings PATH [--ratings PATH]...
                        [--format text|json] [--fixtures PATH]

Only run can reach a model, and only with --allow-model-calls.`;
  (exitCode ? console.error : console.log)(message);
  process.exit(exitCode);
}

export function parseArgs(argv) {
  const parsed = { _: [], case: [], ratings: [] };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      parsed._.push(argument);
      continue;
    }
    const key = argument.slice(2);
    if (key === "allow-model-calls") {
      parsed.allowModelCalls = true;
      continue;
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    if (key === "case") parsed.case.push(value);
    else if (key === "ratings") parsed.ratings.push(value);
    else parsed[key] = value;
  }
  return parsed;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function canonical(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJson(path, label) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`${label} cannot be read: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

// ----- evidence location ---------------------------------------------------

// Raw responses and the variant mapping must never land in the working tree,
// where a routine `git add -A` would publish them.
export function assertEvidencePathOutsideRepository(evidenceDir) {
  if (!isAbsolute(evidenceDir)) throw new Error("--evidence must be an absolute path");
  const resolved = resolve(evidenceDir);
  if (resolved === ROOT || resolved.startsWith(`${ROOT}${sep}`)) {
    throw new Error("the evidence directory must live outside the repository");
  }
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new Error("the evidence directory must not be a symbolic link");
  }
  return resolved;
}

function writePrivate(path, contents) {
  mkdirSync(dirname(path), { recursive: true, mode: DIRECTORY_MODE });
  writeFileSync(path, contents, { mode: FILE_MODE });
  chmodSync(path, FILE_MODE);
}

function evidencePaths(evidenceDir) {
  return {
    root: evidenceDir,
    run: join(evidenceDir, "run.json"),
    responses: join(evidenceDir, "responses.json"),
    mapping: join(evidenceDir, "mapping.json"),
    salt: join(evidenceDir, "salt"),
    commitments: join(evidenceDir, "commitments.json"),
    packets: join(evidenceDir, "packets"),
    marker: join(evidenceDir, "packets", RATING_BEGUN_MARKER),
  };
}

export function ratingHasBegun(evidenceDir) {
  return existsSync(evidencePaths(evidenceDir).marker);
}

function assertPrivateMode(path) {
  const mode = lstatSync(path).mode & 0o777;
  if (mode !== FILE_MODE) throw new Error(`${path} must be mode 0600, found 0${mode.toString(8)}`);
}

// ----- reproducible randomization ------------------------------------------

// A counter-mode SHA-256 stream. Same seed, same sequence, on any machine.
export function makeRng(seed) {
  let counter = 0;
  return function next() {
    const digest = createHash("sha256").update(String(seed)).update(String(counter++)).digest();
    return digest.readUInt32BE(0) / 2 ** 32;
  };
}

export function shuffle(items, rng) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const target = Math.floor(rng() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

// Execution order and each reviewer's display order come from separate
// derivations of the same run seed, so neither can be inferred from the other.
export function executionSeed(seed) {
  return sha256(`${seed}|execution`);
}

export function reviewerSeed(seed, reviewer) {
  return sha256(`${seed}|reviewer|${reviewer}`);
}

// ----- plan and evidence ----------------------------------------------------

export function buildRunPlan({ caseIds, repetitions, seed }) {
  if (!Array.isArray(caseIds) || caseIds.length === 0) throw new Error("caseIds must not be empty");
  if (new Set(caseIds).size !== caseIds.length) throw new Error("caseIds must be unique");
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error("repetitions must be a positive integer");
  if (typeof seed !== "string" || !/^[0-9a-f]{16,}$/.test(seed)) {
    throw new Error("seed must be a lowercase hex string of at least 16 characters");
  }
  const executions = caseIds.flatMap((caseId) =>
    Array.from({ length: repetitions }, (_, index) => index + 1).flatMap((repetition) =>
      VARIANTS.map((variant) => ({ caseId, repetition, variant })),
    ),
  );
  return shuffle(executions, makeRng(executionSeed(seed)));
}

function opaqueId(salt, ...parts) {
  return sha256(`${salt}|${parts.join("|")}`).slice(0, 32);
}

function identityKey(identity) {
  return [identity.claudeVersion, identity.model, identity.effort, identity.fixturesSha256, identity.styleSha256].join("|");
}

export function buildEvidence({ plan, outputs, salt, identity }) {
  if (typeof salt !== "string" || salt.length < 32) throw new Error("salt must be at least 32 characters");
  const responses = {};
  const responseMapping = {};
  const pairs = {};
  const executionOrder = [];

  for (const execution of plan) {
    const key = `${execution.caseId}|${execution.repetition}|${execution.variant}`;
    const record = outputs.get(key);
    if (!record) throw new Error(`missing output for ${key}`);
    if (typeof record.body !== "string" || !record.body.trim()) throw new Error(`empty output for ${key}`);
    // Only the variant may differ inside a pair; everything else is the run's
    // fixed execution identity.
    if (identityKey(record.identity) !== identityKey(identity)) {
      throw new Error(`execution identity drifted for ${key}`);
    }
    if (record.settingsSha256 !== expectedSettingsSha256(execution.variant)) {
      throw new Error(`settings drifted for ${key}`);
    }

    const responseId = opaqueId(salt, "response", execution.caseId, execution.repetition, execution.variant);
    if (responses[responseId]) throw new Error(`duplicate execution for ${key}`);
    responses[responseId] = { body: record.body };
    responseMapping[responseId] = { ...execution };
    executionOrder.push(responseId);

    const pairId = opaqueId(salt, "pair", execution.caseId, execution.repetition);
    pairs[pairId] ??= { caseId: execution.caseId, repetition: execution.repetition, responseIds: {} };
    pairs[pairId].responseIds[execution.variant] = responseId;
  }

  for (const [pairId, pair] of Object.entries(pairs)) {
    const missing = VARIANTS.filter((variant) => !pair.responseIds[variant]);
    if (missing.length) throw new Error(`pair ${pairId} is unbalanced, missing: ${missing.join(", ")}`);
  }

  const responsesFile = { version: 1, responses };
  const mappingFile = { version: 1, responses: responseMapping, pairs };
  const commitments = {
    version: 1,
    responsesSha256: sha256(canonical(responsesFile)),
    mappingSha256: sha256(canonical(mappingFile)),
  };
  const runFile = {
    version: 1,
    identity,
    pairCount: Object.keys(pairs).length,
    responseCount: executionOrder.length,
    executionOrder,
    pairIds: Object.keys(pairs).sort(),
  };
  return { responsesFile, mappingFile, commitments, runFile };
}

export function verifyCommitments(commitments, responsesFile, mappingFile) {
  if (commitments?.version !== 1) throw new Error("commitments.json has an unexpected version");
  if (sha256(canonical(responsesFile)) !== commitments.responsesSha256) {
    throw new Error("responses.json does not match its commitment hash");
  }
  if (sha256(canonical(mappingFile)) !== commitments.mappingSha256) {
    throw new Error("mapping.json does not match its commitment hash");
  }
}

// ----- rating packets -------------------------------------------------------

const PACKET_ITEM_KEYS = ["pairId", "left", "right"];
const PACKET_SIDE_KEYS = ["responseId", "body"];

// A packet carries opaque IDs and response bodies. It must not carry the case
// id, the variant, the model, the effort, or anything else that would tell the
// reviewer which side is which.
export function buildPacket({ reviewer, seed, responsesFile, mappingFile }) {
  if (typeof reviewer !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(reviewer)) {
    throw new Error("reviewer must be a short name of letters, digits, dot, dash, or underscore");
  }
  const pairIds = Object.keys(mappingFile.pairs).sort();
  if (pairIds.length === 0) throw new Error("mapping.json has no pairs");
  const rng = makeRng(reviewerSeed(seed, reviewer));
  const items = shuffle(pairIds, rng).map((pairId) => {
    const pair = mappingFile.pairs[pairId];
    const ordered = rng() < 0.5 ? [...VARIANTS] : [...VARIANTS].reverse();
    const [leftVariant, rightVariant] = ordered;
    const side = (variant) => {
      const responseId = pair.responseIds[variant];
      const response = responsesFile.responses[responseId];
      if (!response) throw new Error(`pair ${pairId} references a missing response`);
      return { responseId, body: response.body };
    };
    return { pairId, left: side(leftVariant), right: side(rightVariant) };
  });
  return { version: 1, reviewer, items };
}

export function assertPacketCarriesNoMetadata(packet, mappingFile) {
  if (!Array.isArray(packet?.items)) throw new Error("packet.items must be an array");
  const forbiddenValues = new Set(VARIANTS);
  for (const pair of Object.values(mappingFile.pairs)) {
    forbiddenValues.add(pair.caseId);
    forbiddenValues.add(String(pair.repetition));
  }
  for (const item of packet.items) {
    if (Object.keys(item).sort().join(",") !== [...PACKET_ITEM_KEYS].sort().join(",")) {
      throw new Error("packet item has unexpected fields");
    }
    for (const sideName of ["left", "right"]) {
      const side = item[sideName];
      if (Object.keys(side).sort().join(",") !== [...PACKET_SIDE_KEYS].sort().join(",")) {
        throw new Error(`packet ${sideName} has unexpected fields`);
      }
      if (typeof side.responseId !== "string" || !/^[0-9a-f]{32}$/.test(side.responseId)) {
        throw new Error("packet response id is not an opaque digest");
      }
      // The identifiers themselves must be opaque. Response bodies are model
      // output and are not filtered here.
      if (forbiddenValues.has(side.responseId)) throw new Error("packet leaks a mapping value");
    }
    if (!/^[0-9a-f]{32}$/.test(item.pairId)) throw new Error("packet pair id is not an opaque digest");
  }
  return true;
}

// ----- aggregation ----------------------------------------------------------

export function aggregate({ mappingFile, responsesFile, packets, ratingFiles, fixtures = null }) {
  const pairIds = Object.keys(mappingFile.pairs).sort();
  const reviewers = ratingFiles.map((file) => file.reviewer);
  if (new Set(reviewers).size !== reviewers.length) throw new Error("a reviewer submitted more than one rating file");
  if (reviewers.length === 0) throw new Error("at least one rating file is required");

  const perReviewer = {};
  const pairChoices = new Map(pairIds.map((pairId) => [pairId, []]));

  for (const ratingFile of ratingFiles) {
    const packet = packets[ratingFile.reviewer];
    if (!packet) throw new Error(`no packet was issued to reviewer ${ratingFile.reviewer}`);
    const sides = new Map(packet.items.map((item) => [item.pairId, item]));
    if (!Array.isArray(ratingFile.ratings)) throw new Error(`${ratingFile.reviewer} ratings must be an array`);

    const seen = new Set();
    const tally = { default: 0, "plain-english": 0, tie: 0 };
    for (const rating of ratingFile.ratings) {
      if (!sides.has(rating.pairId)) throw new Error(`${ratingFile.reviewer} rated an unknown pair: ${rating.pairId}`);
      if (seen.has(rating.pairId)) throw new Error(`${ratingFile.reviewer} rated ${rating.pairId} more than once`);
      seen.add(rating.pairId);
      if (!CHOICES.includes(rating.choice)) throw new Error(`${ratingFile.reviewer} used an invalid choice: ${rating.choice}`);

      let selected = "tie";
      if (rating.choice !== "tie") {
        const responseId = sides.get(rating.pairId)[rating.choice].responseId;
        const record = mappingFile.responses[responseId];
        if (!record) throw new Error(`rating ${rating.pairId} reveals an unknown response`);
        selected = record.variant;
      }
      tally[selected] += 1;
      pairChoices.get(rating.pairId).push(selected);
    }

    const missing = pairIds.filter((pairId) => !seen.has(pairId));
    if (missing.length) throw new Error(`${ratingFile.reviewer} left ${missing.length} pairs unrated`);
    perReviewer[ratingFile.reviewer] = tally;
  }

  // A pair counts as a variant win only when every reviewer picked that
  // variant. Any disagreement is a tie.
  const pairOutcomes = { default: 0, "plain-english": 0, tie: 0 };
  for (const choices of pairChoices.values()) {
    const unique = new Set(choices);
    if (unique.size === 1 && !unique.has("tie")) pairOutcomes[[...unique][0]] += 1;
    else pairOutcomes.tie += 1;
  }

  const totals = { default: 0, "plain-english": 0, tie: 0 };
  for (const tally of Object.values(perReviewer)) {
    for (const key of Object.keys(totals)) totals[key] += tally[key];
  }
  const nonTies = totals.default + totals["plain-english"];

  const hardGate = fixtures ? scoreHardGate(fixtures, mappingFile, responsesFile) : null;

  return {
    version: 1,
    reviewers,
    pairs: pairIds.length,
    ratings: nonTies + totals.tie,
    nonTies,
    totals,
    plainEnglishNonTieShare: nonTies ? totals["plain-english"] / nonTies : 0,
    pairOutcomes,
    ...(hardGate ? { hardGate } : {}),
  };
}

function scoreHardGate(fixtures, mappingFile, responsesFile) {
  const caseMap = new Map(fixtures.cases.map((item) => [item.id, item]));
  const result = Object.fromEntries(VARIANTS.map((variant) => [variant, { total: 0, pass: 0 }]));
  for (const [responseId, record] of Object.entries(mappingFile.responses)) {
    const testCase = caseMap.get(record.caseId);
    if (!testCase) throw new Error(`mapping references an unknown case: ${record.caseId}`);
    const body = responsesFile.responses[responseId]?.body;
    if (typeof body !== "string") throw new Error(`mapping references a missing response: ${responseId}`);
    result[record.variant].total += 1;
    if (scoreOutput(testCase, body).absolutePass) result[record.variant].pass += 1;
  }
  for (const variant of VARIANTS) {
    const bucket = result[variant];
    bucket.passRate = bucket.total ? bucket.pass / bucket.total : 0;
  }
  return result;
}

// ----- execution ------------------------------------------------------------

export function variantSettings(variant) {
  if (variant === "default") return {};
  if (variant === "plain-english") return { outputStyle: STYLE_SETTING_VALUE };
  throw new Error(`unknown variant: ${variant}`);
}

function expectedSettingsSha256(variant) {
  return sha256(canonical(variantSettings(variant)));
}

// Nothing from the operator's own configuration may reach the run: a fresh
// HOME, a fresh config directory, an empty project, an explicit settings file,
// and MCP restricted to an empty config.
export function buildExecutionArgs({ variant, prompt, model, effort, settingsPath }) {
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("prompt must not be empty");
  // The prompt comes first. --mcp-config takes a variable number of values, so
  // a trailing positional argument is read as another MCP config path instead
  // of as the prompt.
  const args = [
    prompt,
    "--print",
    "--output-format",
    "text",
    "--model",
    model,
    "--effort",
    effort,
    "--settings",
    settingsPath,
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    EMPTY_MCP_CONFIG,
    "--tools",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
  ];
  if (variant === "plain-english") args.push("--plugin-dir", PLUGIN_ROOT);
  else if (variant !== "default") throw new Error(`unknown variant: ${variant}`);
  return args;
}

export function buildExecutionEnv(baseEnv, sandbox) {
  const environment = {};
  for (const key of PASSTHROUGH_ENV_KEYS) {
    if (baseEnv[key] !== undefined) environment[key] = baseEnv[key];
  }
  Object.assign(environment, {
    HOME: sandbox.home,
    CLAUDE_CONFIG_DIR: sandbox.config,
    CLAUDE_CODE_PLUGIN_CACHE_DIR: sandbox.cache,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    NO_COLOR: "1",
  });
  const realRoot = resolve(join(homedir(), ".claude"));
  for (const path of [sandbox.home, sandbox.config, sandbox.cache, sandbox.project]) {
    const resolved = resolve(path);
    if (resolved === realRoot || resolved.startsWith(`${realRoot}${sep}`)) {
      throw new Error("an isolated path escaped into the real ~/.claude");
    }
  }
  return environment;
}

function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), "plain-english-compare-"));
  const sandbox = {
    root,
    home: join(root, "home"),
    config: join(root, "config"),
    cache: join(root, "cache"),
    project: join(root, "project"),
  };
  for (const path of [sandbox.home, sandbox.config, sandbox.cache, sandbox.project]) {
    mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE });
  }
  return sandbox;
}

function runCommand(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let settled = false;
    let timedOut = false;
    const settle = (fail, value) => {
      if (settled) return;
      settled = true;
      (fail ? reject : resolvePromise)(value);
    };
    const kill = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => settle(true, error));
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 750).unref();
    }, timeoutMs);
    child.on("close", (status) => {
      clearTimeout(timer);
      if (timedOut) settle(true, new Error(`command timed out after ${timeoutMs}ms: ${command}`));
      else
        settle(false, {
          status,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
    });
  });
}

async function executeOne({ execution, prompt, options, identity }) {
  const sandbox = makeSandbox();
  try {
    const settings = variantSettings(execution.variant);
    const settingsPath = join(sandbox.config, "run-settings.json");
    writePrivate(settingsPath, canonical(settings));
    const args = buildExecutionArgs({
      variant: execution.variant,
      prompt,
      model: options.model,
      effort: options.effort,
      settingsPath,
    });
    const result = await runCommand(options.claude, args, {
      cwd: sandbox.project,
      env: buildExecutionEnv(process.env, sandbox),
      timeoutMs: options.timeoutMs,
    });
    if (result.status !== 0) {
      throw new Error(`claude failed for ${execution.caseId}/${execution.variant}: ${(result.stderr || result.stdout).trim()}`);
    }
    return {
      body: result.stdout.trim(),
      identity,
      settingsSha256: sha256(canonical(settings)),
    };
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
}

async function commandRun(args) {
  if (!args.allowModelCalls) {
    console.error("Refusing to run: model calls require --allow-model-calls.");
    process.exit(2);
  }
  for (const required of ["evidence", "claude", "model", "effort", "seed"]) {
    if (!args[required]) usage(1);
  }
  if (!isAbsolute(args.claude)) throw new Error("--claude must be an absolute path");

  const evidenceDir = assertEvidencePathOutsideRepository(args.evidence);
  if (ratingHasBegun(evidenceDir)) {
    throw new Error("rating has begun for this evidence directory; refusing to overwrite responses or mapping");
  }
  const paths = evidencePaths(evidenceDir);
  for (const path of [paths.responses, paths.mapping, paths.commitments]) {
    if (existsSync(path)) throw new Error(`${path} already exists; use a fresh evidence directory`);
  }

  const fixturesPath = args.fixtures ? resolve(args.fixtures) : DEFAULT_FIXTURES;
  const fixtures = readJson(fixturesPath, "fixtures");
  const fixtureErrors = validateFixtures(fixtures);
  if (fixtureErrors.length) throw new Error(`fixtures are invalid: ${fixtureErrors[0]}`);

  const caseIds = args.case.length ? args.case : fixtures.cases.map((item) => item.id);
  const promptById = new Map(fixtures.cases.map((item) => [item.id, item.prompt]));
  for (const caseId of caseIds) if (!promptById.has(caseId)) throw new Error(`unknown case: ${caseId}`);

  const repetitions = args.repetitions ? Number(args.repetitions) : 1;
  const timeoutMs = (args.timeout ? Number(args.timeout) : 300) * 1000;
  const plan = buildRunPlan({ caseIds, repetitions, seed: args.seed });

  const versionResult = await runCommand(args.claude, ["--version"], { env: process.env, timeoutMs: 60_000 });
  if (versionResult.status !== 0) throw new Error("could not read the Claude Code version");
  const identity = {
    claudeVersion: versionResult.stdout.trim(),
    model: args.model,
    effort: args.effort,
    fixturesSha256: sha256File(fixturesPath),
    styleSha256: sha256File(STYLE_PATH),
  };

  const outputs = new Map();
  for (const [index, execution] of plan.entries()) {
    process.stderr.write(`[${index + 1}/${plan.length}] ${execution.caseId} rep ${execution.repetition}\n`);
    const record = await executeOne({
      execution,
      prompt: promptById.get(execution.caseId),
      options: { claude: args.claude, model: args.model, effort: args.effort, timeoutMs },
      identity,
    });
    outputs.set(`${execution.caseId}|${execution.repetition}|${execution.variant}`, record);
  }

  const salt = randomBytes(32).toString("hex");
  const evidence = buildEvidence({ plan, outputs, salt, identity });
  mkdirSync(evidenceDir, { recursive: true, mode: DIRECTORY_MODE });
  writePrivate(paths.salt, `${salt}\n`);
  writePrivate(paths.responses, canonical(evidence.responsesFile));
  writePrivate(paths.mapping, canonical(evidence.mappingFile));
  writePrivate(paths.commitments, canonical(evidence.commitments));
  writePrivate(paths.run, canonical({ ...evidence.runFile, seed: args.seed }));

  console.log(`Recorded ${evidence.runFile.responseCount} responses across ${evidence.runFile.pairCount} pairs.`);
  console.log(`Evidence: ${evidenceDir} (responses, mapping, salt, and commitments are mode 0600).`);
}

function loadEvidence(evidenceDir) {
  const paths = evidencePaths(evidenceDir);
  for (const path of [paths.run, paths.responses, paths.mapping, paths.commitments, paths.salt]) {
    if (!existsSync(path)) throw new Error(`evidence is incomplete, missing ${path}`);
    assertPrivateMode(path);
  }
  const responsesFile = readJson(paths.responses, "responses.json");
  const mappingFile = readJson(paths.mapping, "mapping.json");
  const commitments = readJson(paths.commitments, "commitments.json");
  verifyCommitments(commitments, responsesFile, mappingFile);
  return {
    paths,
    responsesFile,
    mappingFile,
    commitments,
    run: readJson(paths.run, "run.json"),
  };
}

function commandPacket(args) {
  if (!args.evidence || !args.reviewer) usage(1);
  const evidenceDir = assertEvidencePathOutsideRepository(args.evidence);
  const evidence = loadEvidence(evidenceDir);
  const packetPath = join(evidence.paths.packets, `${args.reviewer}.json`);
  if (existsSync(packetPath)) throw new Error(`a packet was already issued to ${args.reviewer}`);

  const packet = buildPacket({
    reviewer: args.reviewer,
    seed: evidence.run.seed,
    responsesFile: evidence.responsesFile,
    mappingFile: evidence.mappingFile,
  });
  assertPacketCarriesNoMetadata(packet, evidence.mappingFile);
  writePrivate(packetPath, canonical(packet));
  // From this point the responses and the mapping are frozen.
  writePrivate(evidence.paths.marker, `${args.reviewer}\n`);
  console.log(`Packet for ${args.reviewer}: ${packetPath} (${packet.items.length} pairs, opaque ids only).`);
}

function commandAggregate(args) {
  if (!args.evidence || args.ratings.length === 0) usage(1);
  const evidenceDir = assertEvidencePathOutsideRepository(args.evidence);
  const evidence = loadEvidence(evidenceDir);

  const packets = {};
  for (const entry of readdirSync(evidence.paths.packets)) {
    if (!entry.endsWith(".json")) continue;
    const packet = readJson(join(evidence.paths.packets, entry), entry);
    packets[packet.reviewer] = packet;
  }

  const ratingFiles = args.ratings.map((path) => readJson(resolve(path), `ratings ${path}`));
  const fixturesPath = args.fixtures ? resolve(args.fixtures) : DEFAULT_FIXTURES;
  const fixtures = readJson(fixturesPath, "fixtures");
  const report = aggregate({
    mappingFile: evidence.mappingFile,
    responsesFile: evidence.responsesFile,
    packets,
    ratingFiles,
    fixtures,
  });

  if ((args.format ?? "text") === "json") {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const lines = [
    "Blinded comparison, Default versus Plain English",
    `Reviewers: ${report.reviewers.join(", ")}`,
    `Pairs: ${report.pairs}, ratings: ${report.ratings}, non-ties: ${report.nonTies}`,
    `Ratings by variant — Plain English ${report.totals["plain-english"]}, Default ${report.totals.default}, tie ${report.totals.tie}`,
    `Plain English share of non-ties: ${(report.plainEnglishNonTieShare * 100).toFixed(1)}%`,
    `Pair outcomes — Plain English ${report.pairOutcomes["plain-english"]}, Default ${report.pairOutcomes.default}, tie ${report.pairOutcomes.tie}`,
  ];
  if (report.hardGate) {
    for (const variant of VARIANTS) {
      const bucket = report.hardGate[variant];
      lines.push(`Factual hard gate, ${variant}: ${bucket.pass}/${bucket.total}`);
    }
  }
  console.log(lines.join("\n"));
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    usage(1);
    return;
  }
  const command = args._[0];
  try {
    if (command === "run") await commandRun(args);
    else if (command === "packet") commandPacket(args);
    else if (command === "aggregate") commandAggregate(args);
    else usage(command === undefined || command === "help" ? 0 : 1);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
