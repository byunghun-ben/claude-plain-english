# Plain English for Claude Code

This repository holds the `Plain English` output-style plugin for Claude Code.

The project adapts the evidence-preserving principles from Korean Plain to
English. It is not a line-by-line translation. The English version addresses
English-specific failure modes such as padded openings, repeated conclusions,
unnecessary headings, telegraphic fragments, and claims that are stronger than
the available evidence.

## Current status

The output style and its contract test exist. Evaluation fixtures, the blinded
comparison against Default, install E2E coverage, CI, and the release gate are
not implemented yet, and no release has been validated or published.

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
tests/plugin-contract.test.mjs         # plugin surface and style contract
.ralph/plan.md                         # implementation stories
```

## Checks

```sh
claude plugin validate --strict .
claude plugin validate --strict plugins/plain-english
node tests/plugin-contract.test.mjs
```

## License

MIT
