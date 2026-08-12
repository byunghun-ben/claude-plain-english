import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  KNOWN_DIMENSIONS,
  formatText,
  observe,
  parseArgs,
  readability,
  scoreOutput,
  scoreRuns,
  validateFixtures,
} from "../scripts/evaluate.mjs";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EVALUATOR_PATH = join(REPOSITORY_ROOT, "scripts", "evaluate.mjs");
const FIXTURES_PATH = join(REPOSITORY_ROOT, "fixtures", "claude-response-quality-cases.json");
const FIXTURES = JSON.parse(readFileSync(FIXTURES_PATH, "utf8"));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function caseById(id) {
  const testCase = FIXTURES.cases.find((item) => item.id === id);
  assert(testCase, `fixture case is missing: ${id}`);
  return clone(testCase);
}

function expectErrors(mutate, expected, label) {
  const fixtures = clone(FIXTURES);
  mutate(fixtures);
  const errors = validateFixtures(fixtures);
  assert(
    errors.some((error) => expected.test(error)),
    `${label} must be rejected; got: ${errors.join(" | ") || "no errors"}`,
  );
}

// The deterministic evaluator must not be able to reach a model or the network.
// Reading the source is a blunt check, but it fails on the change that would
// introduce the capability rather than on a later run that happens to use it.
{
  const source = readFileSync(EVALUATOR_PATH, "utf8");
  for (const forbidden of [
    "node:child_process",
    "node:http",
    "node:https",
    "node:net",
    "node:dgram",
    "fetch(",
    "XMLHttpRequest",
  ]) {
    assert(!source.includes(forbidden), `evaluate.mjs must not reference ${forbidden}`);
  }
}

// Argument parsing.
{
  const parsed = parseArgs(["score", "--responses", "a.json", "--require-pass", "--format", "json"]);
  assert.deepEqual(parsed._, ["score"]);
  assert.equal(parsed.responses, "a.json");
  assert.equal(parsed.format, "json");
  assert.equal(parsed.requirePass, true);
  assert.throws(() => parseArgs(["score", "--responses"]), /Missing value for --responses/);
  assert.throws(() => parseArgs(["score", "--responses", "--format"]), /Missing value for --responses/);
}

// The shipped fixtures satisfy the schema.
assert.deepEqual(validateFixtures(FIXTURES), [], "shipped fixtures must validate");
assert(FIXTURES.cases.length >= 12, "at least 12 cases are required");
assert.deepEqual(
  FIXTURES.rubric.dimensions,
  KNOWN_DIMENSIONS,
  "the fixture rubric must match the evaluator rubric",
);

// Schema negatives.
expectErrors((f) => { f.version = 2; }, /version must be 1/, "a wrong version");
expectErrors(
  (f) => { f.description = "Real conversations from support."; },
  /synthetic provenance/,
  "a description that does not declare synthetic provenance",
);
expectErrors(
  (f) => { f.rubric.dimensions = ["factual_fidelity"]; },
  /rubric\.dimensions must contain exactly/,
  "an incomplete rubric",
);
expectErrors(
  (f) => { f.cases = f.cases.slice(0, 3); },
  /at least 12 cases are required/,
  "too few cases",
);
expectErrors(
  (f) => { f.cases[1].id = f.cases[0].id; },
  /id is duplicated/,
  "a duplicate case id",
);
expectErrors(
  (f) => { f.cases[0].requiredFacts.push({ ...f.cases[0].requiredFacts[0] }); },
  /requiredFacts\[\d+\]\.id is duplicated/,
  "a duplicate fact id",
);
expectErrors(
  (f) => { f.cases[0].unexpectedField = true; },
  /has unknown fields: unexpectedField/,
  "an unknown case field",
);
expectErrors(
  (f) => { f.cases[0].forbiddenPatterns = ["("]; },
  /forbiddenPatterns has invalid regular expressions/,
  "an invalid forbidden regular expression",
);
expectErrors(
  (f) => { f.cases[0].strengthenedCertaintyPatterns = ["a{2,1}"]; },
  /strengthenedCertaintyPatterns has invalid regular expressions/,
  "an invalid certainty regular expression",
);
expectErrors(
  (f) => { f.cases[0].requiredFacts[0] = { id: "x", patterns: ["a"] }; },
  /patterns shorter than 2 characters/,
  "a one-character pattern",
);
expectErrors(
  (f) => { f.cases[0].requiredFacts[0] = { id: "x", patterns: ["ok"], patternGroups: [["ok"]] }; },
  /exactly one of patterns or patternGroups/,
  "a fact that declares both pattern forms",
);
expectErrors(
  (f) => { f.cases[0].mustExpressUncertainty = true; f.cases[0].uncertaintyPatterns = []; },
  /uncertaintyPatterns is required/,
  "a required-uncertainty case with no uncertainty patterns",
);
expectErrors(
  (f) => { f.cases[0].mustReportUnperformedVerification = true; f.cases[0].verificationPatterns = []; },
  /verificationPatterns is required/,
  "a required-verification case with no verification patterns",
);
expectErrors(
  (f) => { f.cases[0].rubricDimensions = ["reader_first_order", "formatting_restraint"]; },
  /must include factual_fidelity and plain_idiomatic_english/,
  "a case that drops the mandatory rubric dimensions",
);
expectErrors(
  (f) => {
    const target = f.cases.find((item) => item.mustExpressUncertainty);
    target.rubricDimensions = target.rubricDimensions.filter((item) => item !== "calibrated_certainty");
  },
  /must include calibrated_certainty/,
  "an uncertainty case without the certainty dimension",
);
expectErrors(
  (f) => { f.cases = f.cases.filter((item) => item.category !== "short_answer"); },
  /cases must cover these categories: short_answer/,
  "a fixture set that drops a required category",
);

// Scoring: the factual hard gate.
const statusCase = caseById("checkout-status");
const goodStatus =
  "The payment error fix is done and all 18 automated tests pass. " +
  "Verification on a physical iOS device has not happened yet, so that check is still outstanding.";

{
  const score = scoreOutput(statusCase, goodStatus);
  assert.equal(score.absolutePass, true, "a faithful status answer must pass");
  assert.equal(score.facts.missingRequired.length, 0);
  assert.equal(score.facts.requiredFactRetention, 1);
}

{
  const missingTests = "The payment error fix is done. Checking on a physical iOS device has not happened yet.";
  const score = scoreOutput(statusCase, missingTests);
  assert.equal(score.absolutePass, false, "a dropped fact must fail");
  assert.deepEqual(score.facts.missingRequired, ["tests"]);
}

{
  const invented = `${goodStatus} The build is verified on a physical device and ready to ship.`;
  const score = scoreOutput(statusCase, invented);
  assert.equal(score.absolutePass, false, "an invented claim must fail");
  assert.deepEqual(score.facts.forbiddenMatches.sort(), ["ready to ship", "verified on a physical device"]);
}

{
  const strengthened =
    "The payment error fix is done, all 18 automated tests pass, and the iOS device build is fully tested.";
  const score = scoreOutput(statusCase, strengthened);
  assert.equal(score.absolutePass, false, "strengthened certainty must fail");
  assert.equal(score.facts.strengthenedCertaintyMatches.length, 1);
}

{
  const noGap = "The payment error fix is done and all 18 automated tests pass on the iOS device build.";
  const score = scoreOutput(statusCase, noGap);
  assert.equal(score.facts.verificationGapReported, false, "an unreported verification gap must be caught");
  assert.equal(score.absolutePass, false);
}

{
  const flagCase = caseById("sample-flag-not-found");
  const faithful =
    "I could not find `sample_flag` in the Example Console API reference. " +
    "Right now the integration reads its notification setting from group metadata instead.";
  assert.equal(scoreOutput(flagCase, faithful).absolutePass, true);

  const overclaimed =
    "sample_flag does not exist in the Example Console API. " +
    "The integration reads its notification setting from group metadata.";
  const score = scoreOutput(flagCase, overclaimed);
  assert.equal(score.absolutePass, false, "'not found' must not become 'does not exist'");
  assert(score.facts.forbiddenMatches.includes("sample_flag does not exist"));
  assert.equal(score.facts.strengthenedCertaintyMatches.length, 1);

  const noHedge =
    "The setting is read from group metadata for notifications, and sample_flag is not part of the flow.";
  assert.equal(
    scoreOutput(flagCase, noHedge).facts.uncertaintyPresent,
    false,
    "a case that requires stated uncertainty must fail without it",
  );
}

{
  const numbersCase = caseById("unmeasured-cache-gain");
  const faithful =
    "We have not measured it, so I cannot say how much faster the dashboard gets. " +
    "A benchmark would be needed before quoting anything.";
  assert.equal(scoreOutput(numbersCase, faithful).absolutePass, true);

  const invented =
    "We have not measured it, but the dashboard should be roughly 40% faster once caching is on. I cannot say more.";
  const score = scoreOutput(numbersCase, invented);
  assert.equal(score.absolutePass, false, "an invented percentage must fail");
  assert(score.facts.forbiddenPatternMatches.length > 0);
}

{
  const nonEnglish = scoreOutput(statusCase, "결제 오류 수정이 끝났고 자동 테스트 18개가 통과했습니다.");
  assert.equal(nonEnglish.absolutePass, false, "a non-English response must fail an English style gate");
  assert(nonEnglish.facts.nonLatinScriptCount > 0);
}

// Readability and the other mechanical metrics are observations. They never
// change the hard gate in either direction.
{
  const easyButWrong = "The fix is done. Tests are green. All good.";
  const easyScore = scoreOutput(statusCase, easyButWrong);
  assert(easyScore.observations.readability.fleschReadingEase > 60, "the control text should read easily");
  assert.equal(easyScore.absolutePass, false, "readable prose must not offset a missing fact");

  const hardButFaithful =
    "Although the work is not finished in every respect, the payment error fix has been completed and all 18 " +
    "automated tests pass in continuous integration, whereas verification on a physical iOS device has not " +
    "happened yet and therefore remains outstanding until someone runs it on real hardware.";
  const hardScore = scoreOutput(statusCase, hardButFaithful);
  assert(hardScore.observations.readability.fleschReadingEase < 50, "the control text should read heavily");
  assert.equal(hardScore.absolutePass, true, "hard-to-read prose must still pass when the facts hold");

  const factKeys = Object.keys(hardScore.facts);
  for (const key of factKeys) assert(!key.toLowerCase().includes("read"), "readability must not sit in facts");
}

// Observational metrics report the English habits the style warns about.
{
  const padded =
    "Great question! Here is where things stand.\n\n# Status\n\n- The fix is done\n  - tests pass\n\n" +
    "The change leverages a robust pipeline. The change leverages a robust pipeline.";
  const observations = observe(padded);
  assert.deepEqual(observations.paddedOpenings, ["great question"]);
  assert.equal(observations.structure.headings, 1);
  assert.equal(observations.structure.bullets, 2);
  assert.equal(observations.structure.nestedBullets, 1);
  assert.deepEqual(observations.boosters.sort(), ["leverage", "robust"]);
  assert.equal(observations.duplicateSentences.length, 1);
  assert.equal(observations.duplicateSentences[0].count, 2);

  const plain = observe("The nightly job ran out of disk space while writing the export file.");
  assert.deepEqual(plain.paddedOpenings, []);
  assert.deepEqual(plain.boosters, []);
  assert.equal(plain.duplicateSentences.length, 0);
}

{
  const empty = readability("");
  assert.equal(empty.words, 0);
  assert.equal(empty.sentences, 0);
  assert.equal(empty.note, "approximate, observational only");
}

// Run matrices.
const matrix = {
  modelRequested: "claude-sample-model",
  effort: "medium",
  caseIds: ["checkout-status"],
  repetitions: 2,
};

function responsesFor(outputs) {
  return {
    version: 1,
    expectedMatrix: matrix,
    runs: outputs.map((output, index) => ({
      caseId: "checkout-status",
      modelRequested: matrix.modelRequested,
      effort: matrix.effort,
      repetition: index + 1,
      output,
    })),
  };
}

{
  const report = scoreRuns(FIXTURES, responsesFor([goodStatus, goodStatus]));
  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.absolutePass, 2);
  assert.equal(report.summary.overallPass, true);
  assert(formatText(report).includes("Overall: PASS"));
}

{
  const responses = responsesFor([goodStatus, "The payment error fix is done."]);
  const report = scoreRuns(FIXTURES, responses);
  assert.equal(report.summary.overallPass, false);
  assert.equal(report.summary.absoluteFail, 1);
  assert(formatText(report).includes("FAIL checkout-status"));
}

assert.throws(
  () => scoreRuns(FIXTURES, responsesFor([goodStatus])),
  /incomplete or unexpected/,
  "an incomplete matrix must be rejected",
);

assert.throws(
  () => {
    const responses = responsesFor([goodStatus, goodStatus]);
    responses.runs[1].repetition = 1;
    return scoreRuns(FIXTURES, responses);
  },
  /is duplicated/,
  "a duplicate run must be rejected",
);

assert.throws(
  () => {
    const responses = responsesFor([goodStatus, goodStatus]);
    responses.runs[1].caseId = "not-a-case";
    return scoreRuns(FIXTURES, responses);
  },
  /references unknown case/,
  "an unknown case in a run must be rejected",
);

assert.throws(
  () => {
    const responses = responsesFor([goodStatus, goodStatus]);
    responses.expectedMatrix = { ...matrix, caseIds: ["not-a-case"] };
    return scoreRuns(FIXTURES, responses);
  },
  /expectedMatrix references unknown case/,
  "an unknown case in the matrix must be rejected",
);

assert.throws(
  () => {
    const responses = responsesFor([goodStatus, goodStatus]);
    responses.expectedMatrix = { ...matrix, repetitions: 0 };
    return scoreRuns(FIXTURES, responses);
  },
  /expectedMatrix is invalid/,
  "a matrix without repetitions must be rejected",
);

assert.throws(
  () => {
    const responses = responsesFor([goodStatus, goodStatus]);
    responses.runs[0].effort = "high";
    return scoreRuns(FIXTURES, responses);
  },
  /does not match the expected matrix/,
  "a run that drifts from the matrix must be rejected",
);

assert.throws(() => scoreRuns(FIXTURES, { expectedMatrix: matrix }), /runs must be an array/);

// Human ratings.
{
  const responses = responsesFor([goodStatus, goodStatus]);
  const dimensions = caseById("checkout-status").rubricDimensions;
  const scores = Object.fromEntries(dimensions.map((dimension) => [dimension, 4]));
  const ratings = {
    ratings: responses.runs.map((run) => ({
      caseId: run.caseId,
      modelRequested: run.modelRequested,
      effort: run.effort,
      repetition: run.repetition,
      scores,
    })),
  };
  const report = scoreRuns(FIXTURES, responses, ratings);
  assert.equal(report.results[0].humanRating.scores.factual_fidelity, 4);

  assert.throws(
    () => scoreRuns(FIXTURES, responses, { ratings: ratings.ratings.slice(0, 1) }),
    /missing human rating/,
    "a missing rating must be rejected",
  );
  assert.throws(
    () => scoreRuns(FIXTURES, responses, { ratings: [ratings.ratings[0], ratings.ratings[0]] }),
    /is duplicated/,
    "a duplicate rating must be rejected",
  );
  assert.throws(
    () =>
      scoreRuns(FIXTURES, responses, {
        ratings: ratings.ratings.map((rating) => ({ ...rating, scores: { ...scores, factual_fidelity: 9 } })),
      }),
    /needs an integer 1-5 for factual_fidelity/,
    "an out-of-range rating must be rejected",
  );
}

console.log("evaluator: ok");
