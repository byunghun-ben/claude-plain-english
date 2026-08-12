# Plain English for Claude Code

This repository holds the `Plain English` output-style plugin for Claude Code.

The project adapts the evidence-preserving principles from Korean Plain to
English. It is not a line-by-line translation. The English version addresses
English-specific failure modes such as padded openings, repeated conclusions,
unnecessary headings, telegraphic fragments, and claims that are stronger than
the available evidence.

## Current status

The output style, its contract test, the deterministic evaluator, and the
isolated install E2E exist. The blinded comparison against Default, CI, and the
release gate are not implemented yet, and no release has been validated or
published.

Implementation is tracked in GitHub issues and in [`.ralph/plan.md`](.ralph/plan.md).

## Product boundary

- Preserve facts, uncertainty, and verification boundaries.
- Lead with the result or current state.
- Prefer direct, complete English over filler or compressed fragments.
- Add structure only when it makes relationships easier to understand.
- Prove value against Claude Code's Default style with blinded comparison.

The plugin contains one output style and no hooks, skills, agents, MCP servers,
telemetry, or executable runtime code. `tests/plugin-contract.test.mjs` fails if
anything else appears in the plugin tree.

## Repository layout

```text
.claude-plugin/marketplace.json
plugins/plain-english/.claude-plugin/plugin.json
plugins/plain-english/output-styles/plain-english.md
fixtures/claude-response-quality-cases.json   # synthetic English quality cases
scripts/evaluate.mjs                          # deterministic scoring, no model calls
tests/plugin-contract.test.mjs                # plugin surface and style contract
tests/evaluate.test.mjs                       # fixture schema and scoring tests
tests/install-e2e.mjs                         # isolated plugin lifecycle
tests/fixtures/                               # settings and MCP files the E2E must preserve
.ralph/plan.md                                # implementation stories
```

## Checks

```sh
claude plugin validate --strict .
```

```sh
claude plugin validate --strict plugins/plain-english
```

```sh
node tests/plugin-contract.test.mjs
```

```sh
node scripts/evaluate.mjs validate
```

```sh
node tests/evaluate.test.mjs
```

The install E2E needs a real Claude Code executable. It builds a throwaway
`HOME`, config directory, plugin cache, and project, and it fails if the real
`~/.claude` changes.

```sh
node tests/install-e2e.mjs --scope user --claude "$(command -v claude)"
```

```sh
node tests/install-e2e.mjs --scope project --claude "$(command -v claude)"
```

Add `--expect-claude-version "2.1.228 (Claude Code)"` to pin the executable to
one version. Without it the run reports the version it observed.

## Evaluation model

The evaluator applies a factual hard gate: required facts must be present, and
forbidden claims, strengthened certainty, unreported verification gaps, and
non-English output all fail. Readability and the other mechanical measures are
reported as observations and never change that verdict. Style quality itself is
judged by blinded human review, which is a separate step.

Scoring reads recorded responses from disk. Producing those responses is an
opt-in harness that is not part of these checks.

## License

MIT
