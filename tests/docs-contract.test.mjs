import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readAllowlist } from "../scripts/check-public-boundary.mjs";
import { checkPlaceholders } from "../scripts/release-gate.mjs";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(REPOSITORY_ROOT, path), "utf8");

const README = read("README.md");
const EVALUATION = read("docs/EVALUATION.md");
const RELEASE_CHECKLIST = read("docs/RELEASE-CHECKLIST.md");
const CHANGELOG = read("CHANGELOG.md");
const MANIFEST = JSON.parse(read("plugins/plain-english/.claude-plugin/plugin.json"));
const PLUGIN_ID = "plain-english@claude-plain-english";
const PINNED_CLAUDE_VERSION = "2.1.228";

// Every allowlisted path must exist, or the contract describes a repository that
// is not this one.
{
  const allowlist = readAllowlist(REPOSITORY_ROOT);
  const missing = [...allowlist].filter((path) => !existsSync(join(REPOSITORY_ROOT, path)));
  assert.deepEqual(missing, [], `the publication contract lists paths that do not exist: ${missing.join(", ")}`);
}

// The paid comparison is optional and its documented matrix matches the current
// fixture set. Repository and release metadata remain the automated gate.
{
  assert(
    /optional blinded comparison/i.test(RELEASE_CHECKLIST),
    "the release checklist must identify the blinded comparison as optional",
  );
  assert(
    /current 14 fixtures/i.test(RELEASE_CHECKLIST) &&
      /28 pairs and 56[\n ]+responses/i.test(RELEASE_CHECKLIST),
    "the release checklist must document the current comparison matrix",
  );
  assert(
    RELEASE_CHECKLIST.includes("node scripts/release-gate.mjs --repo . --tag vX.Y.Z"),
    "the release checklist must show the metadata-only gate command",
  );
  assert(!RELEASE_CHECKLIST.includes("--attestation"), "the release gate must not require an attestation");
  assert(/not a\s+release requirement/i.test(EVALUATION), "the evaluation policy must keep paid comparison optional");
}

// The README has to answer what this is and how to live with it.
{
  const requiredSections = [
    "## Current status",
    "## Installation",
    "## Activation",
    "## Disabling",
    "## Removal",
    "## Verified environment",
    "## Limitations",
  ];
  for (const heading of requiredSections) {
    assert(README.includes(heading), `README is missing the ${heading} section`);
  }

  const requiredCommands = [
    "claude plugin marketplace add https://github.com/byunghun-ben/claude-plain-english.git --scope user",
    `claude plugin install ${PLUGIN_ID} --scope user`,
    `claude plugin disable ${PLUGIN_ID} --scope user`,
    `claude plugin uninstall ${PLUGIN_ID} --scope user`,
    "claude plugin marketplace remove claude-plain-english --scope user",
  ];
  for (const command of requiredCommands) {
    assert(README.includes(command), `README is missing the command: ${command}`);
  }

  assert(README.includes("plain-english:Plain English"), "README must show the explicit outputStyle value");
  assert(
    README.includes(`Claude Code ${PINNED_CLAUDE_VERSION}`),
    "README must state the verified Claude Code version",
  );
  assert(
    /means clear and direct, not short/.test(README),
    "README must say that plain does not mean short",
  );
}

// No superiority claim may appear before a blinded comparison has been run.
{
  const forbidden = [
    /better than (?:Claude Code's )?Default/i,
    /outperforms/i,
    /superior to/i,
    /proven to (?:be|produce)/i,
  ];
  for (const path of ["README.md", "docs/EVALUATION.md", "CHANGELOG.md", "docs/PROVENANCE.md"]) {
    const text = read(path);
    for (const pattern of forbidden) {
      const match = text.match(pattern);
      // "makes no claim about being better than Default" is a disclaimer, not a
      // claim, so the sentence around a match has to be checked, not the file.
      if (!match) continue;
      const sentence = text.slice(Math.max(0, match.index - 120), match.index + 60);
      assert(
        /no claim|not evidence|has not been run|makes no/i.test(sentence),
        `${path} claims superiority over Default before the comparison has been run`,
      );
    }
  }
}

// The evaluation document has to describe every layer and the trust boundary.
{
  for (const marker of [
    "Deterministic tests",
    "Opt-in model execution",
    "Blinded review",
    "Aggregation and what may be published",
    "## The factual hard gate",
    "## Trust boundary",
    "## Scope of any claim",
  ]) {
    assert(EVALUATION.includes(marker), `docs/EVALUATION.md is missing: ${marker}`);
  }
  assert(
    /Attested by the operator, not proven by code/.test(EVALUATION),
    "docs/EVALUATION.md must separate what code enforces from what the operator attests",
  );
  assert(
    /observations|observational/.test(EVALUATION),
    "docs/EVALUATION.md must describe the mechanical measures as observations",
  );
}

// The changelog's top section is either the unreleased work or the shipped
// version, and it cannot drift from the manifest.
{
  const firstSection = CHANGELOG.match(/^##\s+(.+)$/m);
  assert(firstSection, "CHANGELOG.md needs at least one section");
  const heading = firstSection[1].trim();
  if (heading !== "Unreleased") {
    assert.equal(
      heading.replace(/^v/, ""),
      MANIFEST.version,
      "the changelog's top version must match the plugin manifest",
    );
  } else {
    assert.equal(MANIFEST.version, "0.0.0", "an unreleased changelog means the manifest is still at 0.0.0");
  }
}

// Release-facing files must not carry placeholders or deferred decisions.
assert.deepEqual(checkPlaceholders(REPOSITORY_ROOT), []);

// The contribution and security documents have to cover the boundaries a
// contributor can cross by accident.
{
  const contributing = read("CONTRIBUTING.md");
  assert(contributing.includes("EXPECTED_STYLE_SHA256"), "CONTRIBUTING must explain the style hash pin");
  assert(contributing.includes("docs/PUBLICATION-CONTRACT.md"), "CONTRIBUTING must point at the allowlist");
  assert(
    contributing.includes(`@anthropic-ai/claude-code@${PINNED_CLAUDE_VERSION}`),
    "CONTRIBUTING must pin the verification environment",
  );

  const security = read("SECURITY.md");
  assert(/security advisory/i.test(security), "SECURITY must say how to report privately");
  assert(/transcripts/i.test(security), "SECURITY must forbid raw transcripts in reports");
}

console.log("docs contract: ok");
