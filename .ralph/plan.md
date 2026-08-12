---
project: claude-plain-english
source_issues: ["#1", "#2", "#3", "#4", "#5", "#6"]
created: 2026-08-12
status: amended
critic_rounds: 2
---

# Plan: Plain English Claude Code output-style plugin

## Requirements

- Ship `plain-english` as an English-only Claude Code output-style plugin in a repository separate from Korean Plain.
- Reuse only the shared principles: factual fidelity, calibrated uncertainty, verification boundaries, reader-first order, and restrained structure.
- Write native English guidance rather than translating Korean instructions.
- Do not define plain English as mandatory brevity, removal of technical terms, or a fixed reading grade.
- Keep the public plugin surface to one output style and the minimum manifests.
- Keep the anonymized, randomized blind comparison against Default as an optional
  evaluation, not a release requirement.
- Treat any comparison as a scoped study of a fixed evaluation, not proof of
  general statistical superiority.
- Keep deterministic CI free of model calls. Keep raw responses, transcripts, and variant mappings outside Git.
- Keep implementation and publication as separate decisions.

## Stories

### PE-001: Implement the native Plain English output-style plugin

- Description: Add the independent manifest and `Plain English` output style, then lock the plugin tree to an output-style-only allowlist.
- Acceptance criteria:
  - `claude plugin validate --strict .` and `claude plugin validate --strict plugins/plain-english` exit successfully.
  - The plugin contains only `.claude-plugin/plugin.json` and `output-styles/plain-english.md`.
  - Frontmatter sets `name: Plain English`, `keep-coding-instructions: true`, and `force-for-plugin: true`.
  - The style preserves facts, uncertainty, unperformed verification, and technical identifiers.
  - The style defines direct, idiomatic English and is not a translation of Korean Plain.
  - Contract tests fail closed on extra components, symlinks, executable files, invalid frontmatter, and unexpected style changes.
- Complexity: M
- Dependencies: none
- Wave: 1

### PE-002: Build synthetic English quality fixtures and deterministic evaluation

- Description: Implement synthetic fixtures, schema validation, and deterministic scoring that separate factual hard gates from style observations.
- Acceptance criteria:
  - At least 12 synthetic English cases cover status, missing information, decisions, recommendations, technical explanations, short and long answers, and necessary versus unnecessary lists.
  - Every case declares required facts, forbidden facts or patterns, uncertainty and verification conditions, and rubric dimensions.
  - The rubric separates `factual_fidelity`, `calibrated_certainty`, `reader_first_order`, `plain_idiomatic_english`, `terminology_clarity`, and `formatting_restraint`.
  - `node scripts/evaluate.mjs validate` performs no network or model calls.
  - Scoring rejects missing facts, invented claims, strengthened certainty, incomplete matrices, duplicate runs, and unknown cases.
  - Mechanical readability metrics remain observational and cannot offset a factual hard-gate failure.
  - Negative tests cover invalid schema, duplicate IDs, invalid regexes, incomplete runs, and forbidden claims.
- Complexity: M
- Dependencies: PE-001
- Wave: 2

### PE-003: Implement the blinded Default versus Plain English comparison harness

- Description: Build the opt-in execution, anonymization, rating, reveal, and aggregation pipeline. Do not run the paid experiment in this story.
- Acceptance criteria:
  - Model calls require `--allow-model-calls`.
  - Each pair uses the same fixture, Claude Code version, model, effort, and isolated settings; only the variant differs.
  - User settings, MCP, hooks, other plugins, and prior session state cannot enter the run.
  - Pair execution and each reviewer's left/right display order use reproducible independent randomization.
  - Rating packets expose only opaque IDs and response bodies.
  - Response and mapping commitments are created before ratings and cannot be overwritten after rating begins.
  - Private mappings and salts stay outside Git in mode `0600` files.
  - Tests reject metadata leakage, incomplete or duplicate ratings, unbalanced pairs, and hash mismatches.
- Complexity: L
- Dependencies: PE-001, PE-002
- Wave: 3

### PE-004: Add isolated install, disable, and uninstall E2E coverage

- Description: Verify the user- and project-scope plugin lifecycle without modifying the real Claude Code configuration.
- Acceptance criteria:
  - Local marketplace add, install, disable, uninstall, and marketplace removal succeed at user and project scope in temporary environments.
  - Installed contents contain only the manifest and output style.
  - Existing `outputStyle`, permissions, hooks, and MCP settings are preserved.
  - Disabling removes forced-style behavior at a new-session boundary, and removal leaves no plugin or marketplace entry.
  - Success, failure, and timeout paths leave protected metadata under the real `~/.claude` unchanged.
  - Subprocesses have process-tree timeouts and output-size limits.
- Complexity: M
- Dependencies: PE-001
- Wave: 2

### PE-005: Optionally run the frozen blind benchmark

- Description: If the model-call cost and reviewer time are justified, execute
  the comparison and collect two independent blinded reviews. This story does
  not block a release.
- Acceptance criteria:
  - The current matrix is 14 cases by 2 repetitions: 28 pairs and 56 total responses.
  - Two reviewers rate all 28 pairs: 56 total ratings.
  - All ratings are present and unique.
  - A pair counts as a variant win only when both reviewers select that variant;
    otherwise it is a tie.
  - Aggregates identify the relevant hashes, Claude Code version, model, and
    effort without containing raw responses or the variant mapping.
  - Documentation states the operator trust boundary and limits claims to the frozen benchmark conditions.
- Complexity: M
- Dependencies: PE-003
- Wave: optional after Wave 3

### PE-006: Complete documentation, deterministic CI, and the release check

- Description: Add user, contribution, security, provenance, evaluation, and
  publication documentation; deterministic CI; public-boundary checks; a small
  manual response smoke test; and the repository release gate.
- Acceptance criteria:
  - README documents purpose, installation, activation, disabling, removal, limitations, and the verified Claude Code version.
  - Evaluation docs distinguish deterministic tests, opt-in model execution, blinded review, private evidence, and publishable aggregates.
  - Public-boundary checks reject unlisted files, symlinks, executables, secrets, personal data, raw responses, and transcripts.
  - CI runs strict validation, deterministic tests, public-boundary checks, and isolated install E2E without model calls.
  - The release gate requires clean `main`, aligned version documents, an
    annotated tag at the release commit, and a clean public boundary.
  - The release checklist requires a small representative runtime smoke test;
    the full paid comparison remains optional.
  - Passing the gate does not create a remote, push commits or tags, or publish a GitHub Release.
  - Release-facing files contain no TODO, TBD, or deferred-decision placeholders.
- Complexity: L
- Dependencies: PE-004
- Wave: 4

## Execution order

- Wave 1: PE-001
- Wave 2: PE-002, PE-004
- Wave 3: PE-003
- Optional after Wave 3: PE-005
- Wave 4: PE-006

PE-002 owns fixtures and the evaluator. PE-004 owns install E2E, avoiding file ownership conflicts in Wave 2.

## Risks

- Literal translation can produce unnatural English. Mitigation: native English fixtures and a dedicated idiomatic-English rubric.
- The project can overfit fixtures or mechanical style metrics. Mitigation: separate factual hard gates from blinded human preference and scope claims to the frozen benchmark.
- Response order or metadata can reveal variants. Mitigation: opaque IDs, reviewer-specific randomization, private mappings, and hash checks.
- Default and model behavior can drift by version. Mitigation: bind any reported
  comparison to its exact execution identity and relevant hashes.
- Reviewer independence and reveal order cannot be fully proven by code. Mitigation: document the automated and operator-attested trust boundaries.
- Paid model execution or authentication can block CI. Mitigation: keep real execution opt-in and CI deterministic.

## Decisions

- The repository and `plain-english` plugin remain separate from Korean Plain.
- Only shared quality principles transfer; English prose is designed independently.
- The public plugin contains one output style and minimum manifests.
- Blind A/B is an optional study, not a release requirement.
- Any A/B result is scoped evidence, not a general superiority claim.
- Raw responses, transcripts, and mappings never enter Git or public release artifacts.
- Implementation and publication remain separate work.

## Technical review

- Planning architect and independent critic completed two rounds; the final plan was approved.
- Plugin, evaluation, blind harness, installation, real experiment, and release integration have separate ownership.
- The current experiment arithmetic is fixed at 28 pairs, 56 responses, and 56 ratings.
- The harness implementation and paid experiment are separate stories.
- Dependencies are acyclic; only PE-002 and PE-004 run in parallel.
