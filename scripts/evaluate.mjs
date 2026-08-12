#!/usr/bin/env node

// Deterministic evaluation for the Plain English output style.
//
// This script never calls a model and never opens a network connection. It
// reads fixtures and recorded responses from disk and scores them. Producing
// responses is a separate, opt-in harness; keeping the two apart is what lets
// CI run this file on every commit.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_FIXTURES = path.join(ROOT, "fixtures", "claude-response-quality-cases.json");

export const KNOWN_DIMENSIONS = [
  "factual_fidelity",
  "calibrated_certainty",
  "reader_first_order",
  "plain_idiomatic_english",
  "terminology_clarity",
  "formatting_restraint",
];
// The issue lists the response shapes the fixture set has to cover. Checking
// them here means a future edit cannot quietly drop a shape.
const REQUIRED_CATEGORIES = [
  "status",
  "missing_information",
  "decision",
  "recommendation",
  "technical_explanation",
  "short_answer",
  "long_answer",
  "necessary_list",
  "unnecessary_list",
];
const MINIMUM_CASES = 12;
// Every case is rated on how well it keeps the facts and on whether the English
// reads naturally, so those two dimensions are mandatory.
const MANDATORY_DIMENSIONS = ["factual_fidelity", "plain_idiomatic_english"];
const CASE_KEYS = new Set([
  "id",
  "category",
  "prompt",
  "requiredFacts",
  "forbiddenFacts",
  "forbiddenPatterns",
  "mustExpressUncertainty",
  "uncertaintyPatterns",
  "mustReportUnperformedVerification",
  "verificationPatterns",
  "strengthenedCertaintyPatterns",
  "rubricDimensions",
]);
const FACT_KEYS = new Set(["id", "patterns", "patternGroups"]);
// A one-character pattern matches incidental letters, so a fact built from one
// would pass on a response that never states it.
const MINIMUM_PATTERN_LENGTH = 2;

// Observational only. These lists name habits the style asks writers to avoid;
// they never decide whether a response passes.
const PADDED_OPENINGS = [
  "great question",
  "good question",
  "i'd be happy to",
  "i would be happy to",
  "happy to help",
  "sure thing",
  "certainly!",
  "absolutely!",
  "let me take a look",
  "let's dive in",
  "thanks for asking",
];
const HEDGES = ["might", "maybe", "perhaps", "possibly", "it seems", "arguably", "somewhat", "fairly"];
const BOOSTERS = [
  "seamlessly",
  "robust",
  "leverage",
  "significantly",
  "dramatically",
  "effortlessly",
  "cutting-edge",
  "game-changing",
  "blazing fast",
];

function usage(exitCode = 0) {
  const message = `Usage:
  evaluate.mjs validate [--fixtures PATH]
  evaluate.mjs score --responses PATH [--ratings PATH] [--fixtures PATH]
                     [--format text|json] [--require-pass]

validate checks the fixture schema. score reads recorded responses and applies
the factual hard gate. Neither command calls a model or opens a network
connection.`;
  (exitCode ? console.error : console.log)(message);
  process.exit(exitCode);
}

export function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      parsed._.push(argument);
      continue;
    }
    const key = argument.slice(2);
    if (key === "require-pass") {
      parsed.requirePass = true;
      continue;
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    parsed[key] = value;
  }
  return parsed;
}

function readJson(filePath, label) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`${label} cannot be read: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function unknownKeys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).filter((key) => !allowed.has(key));
}

function nonEmptyStrings(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && item.length > 0)
  );
}

function stringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function shortPatterns(fact) {
  const groups = fact?.patternGroups ?? (fact?.patterns ? [fact.patterns] : []);
  if (!Array.isArray(groups)) return [];
  return groups
    .flat()
    .filter((pattern) => typeof pattern === "string" && pattern.trim().length < MINIMUM_PATTERN_LENGTH);
}

function invalidRegExpSources(sources) {
  return sources.filter((source) => {
    try {
      new RegExp(source, "i");
      return false;
    } catch {
      return true;
    }
  });
}

function validatePatternList(errors, testCase, field, at) {
  const value = testCase?.[field];
  if (!stringArray(value)) {
    errors.push(`${at}.${field} must contain only non-empty strings`);
    return;
  }
  if (new Set(value).size !== value.length) {
    errors.push(`${at}.${field} must not repeat a pattern`);
    return;
  }
  const invalid = invalidRegExpSources(value);
  if (invalid.length) {
    errors.push(`${at}.${field} has invalid regular expressions: ${invalid.join(", ")}`);
  }
}

export function validateFixtures(data) {
  const errors = [];
  if (!data || data.version !== 1) errors.push("version must be 1");
  if (typeof data?.description !== "string" || !data.description.toLowerCase().includes("synthetic")) {
    errors.push("description must declare synthetic provenance");
  }

  const dimensions = data?.rubric?.dimensions;
  if (
    !Array.isArray(dimensions) ||
    dimensions.length !== KNOWN_DIMENSIONS.length ||
    new Set(dimensions).size !== KNOWN_DIMENSIONS.length ||
    dimensions.some((item) => !KNOWN_DIMENSIONS.includes(item))
  ) {
    errors.push(`rubric.dimensions must contain exactly: ${KNOWN_DIMENSIONS.join(", ")}`);
  }

  const cases = Array.isArray(data?.cases) ? data.cases : null;
  if (!cases || cases.length < MINIMUM_CASES) errors.push(`at least ${MINIMUM_CASES} cases are required`);

  const caseIds = new Set();
  const categories = new Set();
  for (const [caseIndex, testCase] of (cases || []).entries()) {
    const at = `cases[${caseIndex}]`;
    const extras = unknownKeys(testCase, CASE_KEYS);
    if (extras.length) errors.push(`${at} has unknown fields: ${extras.join(", ")}`);

    if (typeof testCase?.id !== "string" || !testCase.id) errors.push(`${at}.id is required`);
    else if (caseIds.has(testCase.id)) errors.push(`${at}.id is duplicated: ${testCase.id}`);
    else caseIds.add(testCase.id);

    if (typeof testCase?.category !== "string" || !testCase.category) errors.push(`${at}.category is required`);
    else categories.add(testCase.category);

    if (typeof testCase?.prompt !== "string" || !testCase.prompt) errors.push(`${at}.prompt is required`);

    if (!Array.isArray(testCase?.requiredFacts) || testCase.requiredFacts.length === 0) {
      errors.push(`${at}.requiredFacts must be a non-empty array`);
    }
    const factIds = new Set();
    for (const [factIndex, fact] of (testCase?.requiredFacts || []).entries()) {
      const factAt = `${at}.requiredFacts[${factIndex}]`;
      const factExtras = unknownKeys(fact, FACT_KEYS);
      if (factExtras.length) errors.push(`${factAt} has unknown fields: ${factExtras.join(", ")}`);
      if (typeof fact?.id !== "string" || !fact.id) errors.push(`${factAt}.id is required`);
      else if (factIds.has(fact.id)) errors.push(`${factAt}.id is duplicated: ${fact.id}`);
      else factIds.add(fact.id);
      const hasPatterns = nonEmptyStrings(fact?.patterns);
      const hasGroups =
        Array.isArray(fact?.patternGroups) &&
        fact.patternGroups.length > 0 &&
        fact.patternGroups.every(nonEmptyStrings);
      if (hasPatterns === hasGroups) errors.push(`${factAt} must have exactly one of patterns or patternGroups`);
      const short = shortPatterns(fact);
      if (short.length) {
        errors.push(
          `${factAt} has patterns shorter than ${MINIMUM_PATTERN_LENGTH} characters: ${short.join(", ")}`,
        );
      }
    }

    if (!nonEmptyStrings(testCase?.forbiddenFacts)) {
      errors.push(`${at}.forbiddenFacts must contain non-empty strings`);
    } else if (new Set(testCase.forbiddenFacts).size !== testCase.forbiddenFacts.length) {
      errors.push(`${at}.forbiddenFacts must not repeat a claim`);
    }

    validatePatternList(errors, testCase, "forbiddenPatterns", at);
    validatePatternList(errors, testCase, "strengthenedCertaintyPatterns", at);

    if (typeof testCase?.mustExpressUncertainty !== "boolean") {
      errors.push(`${at}.mustExpressUncertainty must be boolean`);
    }
    if (!stringArray(testCase?.uncertaintyPatterns)) {
      errors.push(`${at}.uncertaintyPatterns must contain only non-empty strings`);
    } else if (testCase?.mustExpressUncertainty && testCase.uncertaintyPatterns.length === 0) {
      errors.push(`${at}.uncertaintyPatterns is required when mustExpressUncertainty is true`);
    }

    if (typeof testCase?.mustReportUnperformedVerification !== "boolean") {
      errors.push(`${at}.mustReportUnperformedVerification must be boolean`);
    }
    if (!stringArray(testCase?.verificationPatterns)) {
      errors.push(`${at}.verificationPatterns must contain only non-empty strings`);
    } else if (testCase?.mustReportUnperformedVerification && testCase.verificationPatterns.length === 0) {
      errors.push(`${at}.verificationPatterns is required when mustReportUnperformedVerification is true`);
    }

    const rubricDimensions = testCase?.rubricDimensions;
    if (
      !Array.isArray(rubricDimensions) ||
      rubricDimensions.length === 0 ||
      new Set(rubricDimensions).size !== rubricDimensions.length ||
      rubricDimensions.some((item) => !KNOWN_DIMENSIONS.includes(item))
    ) {
      errors.push(`${at}.rubricDimensions must contain unique known dimensions`);
    } else {
      const missing = MANDATORY_DIMENSIONS.filter((item) => !rubricDimensions.includes(item));
      if (missing.length) errors.push(`${at}.rubricDimensions must include ${missing.join(" and ")}`);
      const certaintyCase =
        testCase.mustExpressUncertainty ||
        testCase.mustReportUnperformedVerification ||
        (testCase.strengthenedCertaintyPatterns || []).length > 0;
      if (certaintyCase && !rubricDimensions.includes("calibrated_certainty")) {
        errors.push(`${at}.rubricDimensions must include calibrated_certainty`);
      }
    }
  }

  if (cases) {
    const missingCategories = REQUIRED_CATEGORIES.filter((category) => !categories.has(category));
    if (missingCategories.length) {
      errors.push(`cases must cover these categories: ${missingCategories.join(", ")}`);
    }
  }

  return errors;
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase();
}

function factPresent(text, fact) {
  const target = normalize(text);
  if (fact.patternGroups) {
    return fact.patternGroups.every((group) => group.some((pattern) => target.includes(normalize(pattern))));
  }
  return fact.patterns.every((pattern) => target.includes(normalize(pattern)));
}

// Literal forbidden claims are matched as substrings, so each one has to be
// phrased so that a correct, hedged answer cannot contain it. "the test suite
// passes" is safe; a bare "passes" would fire on "I cannot say whether it
// passes".
function matchLiterals(text, literals) {
  const target = normalize(text);
  return literals.filter((literal) => target.includes(normalize(literal)));
}

function matchPatterns(text, sources) {
  return sources.filter((source) => new RegExp(source, "i").test(text));
}

function sentences(text) {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function words(text) {
  return text.match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) || [];
}

// Deliberately approximate. It is reported as an observation, never as a gate.
function countSyllables(word) {
  const cleaned = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!cleaned) return 0;
  const groups = cleaned.match(/[aeiouy]+/g) || [];
  let count = groups.length;
  if (cleaned.endsWith("e") && count > 1 && !/[aeiouy]{2}e$/.test(cleaned)) count -= 1;
  return Math.max(count, 1);
}

export function readability(text) {
  const sentenceList = sentences(text);
  const wordList = words(text);
  const syllables = wordList.reduce((total, word) => total + countSyllables(word), 0);
  const wordsPerSentence = sentenceList.length ? wordList.length / sentenceList.length : 0;
  const syllablesPerWord = wordList.length ? syllables / wordList.length : 0;
  return {
    note: "approximate, observational only",
    sentences: sentenceList.length,
    words: wordList.length,
    wordsPerSentence: Number(wordsPerSentence.toFixed(2)),
    syllablesPerWord: Number(syllablesPerWord.toFixed(2)),
    fleschReadingEase: Number((206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord).toFixed(2)),
    longSentences: sentenceList.filter((sentence) => words(sentence).length >= 35).length,
  };
}

function duplicateSentences(text) {
  const counts = new Map();
  for (const sentence of sentences(normalize(text)).filter((item) => item.length >= 12)) {
    counts.set(sentence, (counts.get(sentence) || 0) + 1);
  }
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([sentence, count]) => ({ sentence, count }));
}

export function observe(text) {
  const lines = text.split(/\r?\n/);
  const target = normalize(text);
  const opening = normalize(sentences(text)[0] ?? "");
  return {
    chars: text.length,
    lines: lines.length,
    structure: {
      headings: lines.filter((line) => /^\s*#{1,6}\s+/.test(line)).length,
      bullets: lines.filter((line) => /^\s*(?:[-*+] |\d+\. )/.test(line)).length,
      nestedBullets: lines.filter((line) => /^\s{2,}(?:[-*+] |\d+\. )/.test(line)).length,
      tableRows: lines.filter((line) => /^\s*\|.*\|\s*$/.test(line)).length,
    },
    paddedOpenings: PADDED_OPENINGS.filter((phrase) => opening.includes(phrase)),
    hedges: HEDGES.filter((hedge) => target.includes(hedge)),
    boosters: BOOSTERS.filter((booster) => target.includes(booster)),
    duplicateSentences: duplicateSentences(text),
    readability: readability(text),
  };
}

export function scoreOutput(testCase, output) {
  const text = String(output ?? "");
  const target = normalize(text);
  const required = testCase.requiredFacts.map((fact) => ({ id: fact.id, present: factPresent(text, fact) }));
  const missingRequired = required.filter((fact) => !fact.present).map((fact) => fact.id);
  const forbiddenMatches = matchLiterals(text, testCase.forbiddenFacts);
  const forbiddenPatternMatches = matchPatterns(text, testCase.forbiddenPatterns ?? []);
  const strengthenedCertaintyMatches = matchPatterns(text, testCase.strengthenedCertaintyPatterns ?? []);
  const uncertaintyPresent =
    !testCase.mustExpressUncertainty ||
    testCase.uncertaintyPatterns.some((pattern) => target.includes(normalize(pattern)));
  const verificationGapReported =
    !testCase.mustReportUnperformedVerification ||
    testCase.verificationPatterns.some((pattern) => target.includes(normalize(pattern)));
  const latinLetters = (text.match(/[A-Za-z]/g) || []).length;
  const nonLatinScript = (text.match(/[぀-ヿ㐀-鿿가-힯]/g) || []).length;

  const facts = {
    requiredFactRetention: required.length ? (required.length - missingRequired.length) / required.length : 0,
    missingRequired,
    forbiddenMatches,
    forbiddenPatternMatches,
    strengthenedCertaintyMatches,
    uncertaintyPresent,
    verificationGapReported,
    englishPresent: latinLetters > 0,
    nonLatinScriptCount: nonLatinScript,
  };

  // The hard gate reads `facts` and nothing else. Observations are reported
  // beside it so that a smooth, readable answer can never buy back a missing
  // fact, an invented claim, or a certainty the source did not support.
  const absolutePass =
    facts.missingRequired.length === 0 &&
    facts.forbiddenMatches.length === 0 &&
    facts.forbiddenPatternMatches.length === 0 &&
    facts.strengthenedCertaintyMatches.length === 0 &&
    facts.uncertaintyPresent &&
    facts.verificationGapReported &&
    facts.englishPresent &&
    facts.nonLatinScriptCount === 0;

  return { caseId: testCase.id, facts, observations: observe(text), absolutePass };
}

function runKey(value) {
  return [value.modelRequested, value.effort, value.caseId, value.repetition].join("|");
}

function expectedKeys(matrix, caseMap) {
  if (!matrix || typeof matrix !== "object") throw new Error("responses.expectedMatrix is required");
  if (
    typeof matrix.modelRequested !== "string" ||
    !matrix.modelRequested ||
    typeof matrix.effort !== "string" ||
    !matrix.effort ||
    !Array.isArray(matrix.caseIds) ||
    matrix.caseIds.length === 0 ||
    new Set(matrix.caseIds).size !== matrix.caseIds.length ||
    !Number.isInteger(matrix.repetitions) ||
    matrix.repetitions < 1
  ) {
    throw new Error("responses.expectedMatrix is invalid");
  }
  const unknown = matrix.caseIds.filter((caseId) => !caseMap.has(caseId));
  if (unknown.length) throw new Error(`responses.expectedMatrix references unknown case: ${unknown.join(", ")}`);
  return matrix.caseIds.flatMap((caseId) =>
    Array.from({ length: matrix.repetitions }, (_, index) => runKey({ ...matrix, caseId, repetition: index + 1 })),
  );
}

export function scoreRuns(fixtures, responses, ratings = null) {
  if (!Array.isArray(responses?.runs)) throw new Error("responses.runs must be an array");
  const caseMap = new Map(fixtures.cases.map((item) => [item.id, item]));
  const expected = expectedKeys(responses.expectedMatrix, caseMap);
  const expectedSet = new Set(expected);
  const actual = new Set();

  for (const [index, run] of responses.runs.entries()) {
    if (!caseMap.has(run.caseId)) throw new Error(`responses.runs[${index}] references unknown case: ${run.caseId}`);
    if (
      run.modelRequested !== responses.expectedMatrix.modelRequested ||
      run.effort !== responses.expectedMatrix.effort ||
      !Number.isInteger(run.repetition) ||
      run.repetition < 1 ||
      typeof run.output !== "string"
    ) {
      throw new Error(`responses.runs[${index}] does not match the expected matrix`);
    }
    const key = runKey(run);
    if (actual.has(key)) throw new Error(`responses.runs[${index}] is duplicated: ${key}`);
    actual.add(key);
  }

  const missing = expected.filter((key) => !actual.has(key));
  const unexpected = [...actual].filter((key) => !expectedSet.has(key));
  if (missing.length || unexpected.length) {
    throw new Error(
      `response matrix is incomplete or unexpected (missing: ${missing.join(", ") || "none"}; unexpected: ${
        unexpected.join(", ") || "none"
      })`,
    );
  }

  const ratingMap = new Map();
  if (ratings !== null) {
    if (!Array.isArray(ratings?.ratings)) throw new Error("ratings.ratings must be an array");
    for (const [index, rating] of ratings.ratings.entries()) {
      const key = runKey(rating);
      if (ratingMap.has(key)) throw new Error(`ratings.ratings[${index}] is duplicated: ${key}`);
      ratingMap.set(key, rating);
    }
  }

  const results = responses.runs.map((run) => {
    const testCase = caseMap.get(run.caseId);
    let humanRating = null;
    if (ratings !== null) {
      humanRating = ratingMap.get(runKey(run));
      if (!humanRating) throw new Error(`missing human rating for run: ${runKey(run)}`);
      for (const dimension of testCase.rubricDimensions) {
        const value = humanRating.scores?.[dimension];
        if (!Number.isInteger(value) || value < 1 || value > 5) {
          throw new Error(`rating ${runKey(run)} needs an integer 1-5 for ${dimension}`);
        }
      }
    }
    return {
      caseId: run.caseId,
      modelRequested: run.modelRequested,
      effort: run.effort,
      repetition: run.repetition,
      ...(typeof run.claudeVersion === "string" ? { claudeVersion: run.claudeVersion } : {}),
      score: scoreOutput(testCase, run.output),
      ...(humanRating ? { humanRating } : {}),
    };
  });

  const passing = results.filter((item) => item.score.absolutePass).length;
  return {
    version: 1,
    summary: {
      total: results.length,
      absolutePass: passing,
      absoluteFail: results.length - passing,
      passRate: results.length ? passing / results.length : 0,
      complete: true,
      overallPass: passing === results.length,
    },
    results,
  };
}

export function formatText(report) {
  const lines = [
    "Plain English response quality evaluation",
    `Runs: ${report.summary.total}, pass: ${report.summary.absolutePass}, fail: ${report.summary.absoluteFail}`,
    `Overall: ${report.summary.overallPass ? "PASS" : "FAIL"}`,
  ];
  for (const result of report.results) {
    const { facts, observations } = result.score;
    const reasons = [
      facts.missingRequired.length ? `missing ${facts.missingRequired.join("/")}` : null,
      facts.forbiddenMatches.length ? `invented ${facts.forbiddenMatches.length}` : null,
      facts.forbiddenPatternMatches.length ? `forbidden pattern ${facts.forbiddenPatternMatches.length}` : null,
      facts.strengthenedCertaintyMatches.length ? `strengthened certainty ${facts.strengthenedCertaintyMatches.length}` : null,
      facts.uncertaintyPresent ? null : "uncertainty not stated",
      facts.verificationGapReported ? null : "verification gap not stated",
      facts.englishPresent ? null : "no English text",
      facts.nonLatinScriptCount ? "non-English script" : null,
    ].filter(Boolean);
    lines.push(
      `${result.score.absolutePass ? "PASS" : "FAIL"} ${result.caseId} — ` +
        `${Math.round(facts.requiredFactRetention * 100)}% facts` +
        (reasons.length ? `; ${reasons.join(", ")}` : "") +
        `; reading ease ${observations.readability.fleschReadingEase} (observational)`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function commandValidate(args) {
  const fixturesPath = args.fixtures ? path.resolve(args.fixtures) : DEFAULT_FIXTURES;
  const fixtures = readJson(fixturesPath, "fixtures");
  const errors = validateFixtures(fixtures);
  if (errors.length) {
    console.error(`Fixture validation failed (${errors.length}):`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(`Fixtures valid: ${fixtures.cases.length} cases, ${KNOWN_DIMENSIONS.length} rubric dimensions.`);
}

function commandScore(args) {
  if (!args.responses) usage(1);
  const fixturesPath = args.fixtures ? path.resolve(args.fixtures) : DEFAULT_FIXTURES;
  const fixtures = readJson(fixturesPath, "fixtures");
  const fixtureErrors = validateFixtures(fixtures);
  if (fixtureErrors.length) {
    console.error(`Fixture validation failed (${fixtureErrors.length}). Run validate for details.`);
    process.exit(1);
  }
  const responses = readJson(path.resolve(args.responses), "responses");
  const ratings = args.ratings ? readJson(path.resolve(args.ratings), "ratings") : null;
  const report = scoreRuns(fixtures, responses, ratings);
  const format = args.format ?? "text";
  if (format === "json") console.log(JSON.stringify(report, null, 2));
  else if (format === "text") process.stdout.write(formatText(report));
  else throw new Error(`unknown --format: ${format}`);
  if (args.requirePass && !report.summary.overallPass) process.exit(1);
}

function main(argv) {
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
    if (command === "validate") commandValidate(args);
    else if (command === "score") commandScore(args);
    else usage(command === undefined || command === "help" ? 0 : 1);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
