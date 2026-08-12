# Publication contract

This file defines the complete public surface of the repository. The check in
`scripts/check-public-boundary.mjs` is fail-closed: anything not listed here is a
violation, whether it sits in the working tree or in the Git index.

## Path allowlist

Only these repository-relative files may be published:

- `.gitignore`
- `CLAUDE.md`
- `LICENSE`
- `README.md`
- `CHANGELOG.md`
- `CONTRIBUTING.md`
- `SECURITY.md`
- `.claude-plugin/marketplace.json`
- `.github/workflows/ci.yml`
- `.ralph/plan.md`
- `plugins/plain-english/.claude-plugin/plugin.json`
- `plugins/plain-english/output-styles/plain-english.md`
- `fixtures/README.md`
- `fixtures/claude-response-quality-cases.json`
- `scripts/evaluate.mjs`
- `scripts/compare.mjs`
- `scripts/check-public-boundary.mjs`
- `scripts/release-gate.mjs`
- `tests/plugin-contract.test.mjs`
- `tests/evaluate.test.mjs`
- `tests/compare.test.mjs`
- `tests/install-e2e.mjs`
- `tests/docs-contract.test.mjs`
- `tests/public-boundary.test.mjs`
- `tests/release-gate.test.mjs`
- `tests/run-all.mjs`
- `tests/fixtures/user-settings.json`
- `tests/fixtures/project-settings.json`
- `tests/fixtures/project-mcp.json`
- `docs/PUBLICATION-CONTRACT.md`
- `docs/EVALUATION.md`
- `docs/PROVENANCE.md`
- `docs/RELEASE-CHECKLIST.md`

Directories exist only to hold the files above. Placeholder files, generated
archives, binaries, and release assets are not part of the public surface.

The check covers everything Git would publish: files in the index, and untracked
files that are not ignored, because the next `git add -A` would sweep those in.
Ignored files are out of scope; they never reach a clone. Every path listed above
must exist, which `tests/docs-contract.test.mjs` verifies.

## Allowed plugin components

The published plugin contains one manifest and one output style. Skills, agents,
commands, hooks, MCP servers, settings files, package manifests, and executable
files are not allowed inside `plugins/plain-english`, and
`tests/plugin-contract.test.mjs` fails if one appears.

## Never published

- Raw model responses, conversation transcripts, and session logs.
- The variant mapping, the salt, and any other file from a comparison evidence
  directory. Evidence lives outside this repository and is written mode `0600`.
- Secrets and credentials of any kind, including API keys, OAuth tokens, cloud
  access keys, and private key blocks.
- Personal data, including absolute home-directory paths, host names, and email
  addresses.
- Executable files and symbolic links.
- Binary files.

## How the check reports failures

The checker prints how many violations it found and of which kind. It does not
print the offending path or the matched value, because a failure report that
quotes the secret publishes the secret. Reproduce locally to see the file.

```sh
node scripts/check-public-boundary.mjs --repo . --working-tree
```
