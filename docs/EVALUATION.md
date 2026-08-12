# Evaluation

Quality here can be examined in two separate ways, and they are not
interchangeable. A factual hard gate is machine-checked and runs on every commit.
An optional blinded human comparison against Claude Code's Default style can
explore style preference, but it costs money and requires people, so it is not a
release requirement.

## The four layers

### 1. Deterministic tests — no model, no network

`node tests/run-all.mjs` runs the plugin contract, the fixture schema, the
scorer, the comparison harness logic, the documentation contract, and the public
boundary. `scripts/evaluate.mjs` imports only `node:fs`, `node:path`, and
`node:url`, so it cannot call a model or open a socket, and
`tests/evaluate.test.mjs` asserts that boundary from the source.

The install E2E runs after them and needs a real Claude Code executable, but it
only invokes version and plugin-management commands. It does not generate a
response.

### 2. Opt-in model execution

`scripts/compare.mjs run` is the only command that can reach a model, and only
with `--allow-model-calls`. Each pair sends the same fixture prompt through
Default and through Plain English with the same Claude Code version, model,
effort, and isolated execution environment. Each call gets a fresh `HOME`,
config directory, plugin cache, and empty project. Settings sources, built-in
tools, skills, MCP, and session persistence are disabled. An environment
allowlist passes only the executable path, locale, temporary-directory setting,
and supported Anthropic authentication, so unrelated shell state and credentials
cannot enter a run.

That isolation has a consequence worth stating: credentials live in the config
directory alongside the settings, so a run cannot borrow an interactive login.
Authentication has to arrive through the environment instead, from
`CLAUDE_CODE_OAUTH_TOKEN` created with `claude setup-token` or from
`ANTHROPIC_API_KEY`. The harness passes those two supported credentials through
and drops every other unknown environment variable.

### 3. Blinded review

`scripts/compare.mjs packet` issues one packet per reviewer. A packet contains
opaque 128-bit pair and response IDs and the response bodies, and nothing else.
Pair order and the left/right layout come from a reviewer-specific derivation of
the run seed, so two reviewers never share a layout and neither layout can be
derived from the other. Issuing the first packet freezes the run: the responses
and the mapping can no longer be rewritten, and any later edit fails the
commitment hash check.

### 4. Aggregation and what may be published

`scripts/compare.mjs aggregate` reveals the variants and reports rating totals,
pair outcomes, and the factual hard-gate pass rate per variant. A pair counts as
a variant win only when every reviewer picked that variant; disagreement is a
tie.

Only aggregates may be published. Raw responses, the variant mapping, and the
salt stay in the evidence directory outside this repository, as mode `0600`
files. `docs/PUBLICATION-CONTRACT.md` lists the full public surface.

## The factual hard gate

The gate reads only the facts block of a score:

- every required fact must be present;
- no forbidden claim and no forbidden pattern may appear;
- no pattern that strengthens a claim beyond the source may appear;
- stated uncertainty is required where the case demands it;
- an unperformed verification must be reported where the case demands it;
- the response must be in English.

Readability and the other mechanical measures — reading ease, sentence length,
padded openings, hedges, boosters, repeated sentences, heading and bullet counts
— are reported next to the gate as observations. They never change the verdict in
either direction, and `tests/evaluate.test.mjs` checks that in both directions:
easy-to-read prose with a missing fact fails, and dense prose with every fact
intact passes.

## Fixtures

`fixtures/claude-response-quality-cases.json` holds invented English cases. They
are not copied conversations, customer records, or operational logs. The schema
check requires the fixture set to cover status, missing information, decisions,
recommendations, technical explanations, short and long answers, and necessary
versus unnecessary lists, so a later edit cannot quietly drop a shape.

## Trust boundary

Some parts of this pipeline are enforced by code, and some rest on the operator.

Enforced by code: isolation of each run, identical execution identity inside a
pair, opaque identifiers in packets, reproducible and independent randomization,
commitment hashes over the responses and the mapping, refusal to overwrite
evidence after rating begins, and mode `0600` on private files.

Attested by the operator, not proven by code: that the reviewers are independent
of each other, that they did not see the variant mapping before rating, and that
ratings were recorded before the reveal. Aggregation checks the files it is
given; it cannot check how the reviews were conducted.

## Scope of any claim

A comparison result describes one fixed evaluation: this fixture set, this
Claude Code version, this model, this effort level, and these reviewers. It is
not evidence that Plain English is generally better than Default, and no
document in this repository may say that it is.

## Current state

The current fixture set has 14 cases. With two repetitions, the optional
comparison produces 28 pairs and 56 responses. It has not been run, and no
version has been released. This does not block deterministic validation or a
release.
