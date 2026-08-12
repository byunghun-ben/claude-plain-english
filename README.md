# Plain English for Claude Code

This repository is the implementation scaffold for a planned `Plain English`
output-style plugin for Claude Code.

The project will adapt the evidence-preserving principles from Korean Plain to
English. It is not a line-by-line translation. The English version must address
English-specific failure modes such as padded openings, repeated conclusions,
unnecessary headings, telegraphic fragments, and claims that are stronger than
the available evidence.

## Current status

Scaffolding and implementation planning only. There is no installable output
style yet, and no release has been validated or published.

Implementation is tracked in GitHub issues and in [`.ralph/plan.md`](.ralph/plan.md).

## Product boundary

- Preserve facts, uncertainty, and verification boundaries.
- Lead with the result or current state.
- Prefer direct, complete English over filler or compressed fragments.
- Add structure only when it makes relationships easier to understand.
- Prove value against Claude Code's Default style with blinded comparison.

The initial plugin will contain one output style and no hooks, skills, agents,
MCP servers, telemetry, or executable runtime code.

## Repository layout

```text
.claude-plugin/marketplace.json
plugins/plain-english/.claude-plugin/plugin.json
plugins/plain-english/output-styles/   # implementation pending
.ralph/plan.md                         # implementation stories
```

## License

MIT
