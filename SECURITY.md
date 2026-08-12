# Security

## Scope

The published plugin is one manifest and one Markdown output style. It contains
no executable code, no hooks, no MCP servers, no network access, and no
telemetry. `tests/plugin-contract.test.mjs` fails if any of those appear.

The scripts in `scripts/` and the tests in `tests/` run only when you run them.
`scripts/evaluate.mjs` cannot reach a model or the network.
`scripts/compare.mjs run` can, and refuses to without `--allow-model-calls`.

## Reporting a problem

Open a private security advisory on the repository's GitHub Security tab. Please
do not open a public issue for a vulnerability, and do not include secrets,
credentials, personal data, or raw conversation transcripts in any report.

## What must never enter this repository

Secrets, credentials, personal data, raw model responses, conversation
transcripts, and comparison evidence. `scripts/check-public-boundary.mjs`
enforces that list against the working tree and the index, and CI runs it on
every push and pull request.
