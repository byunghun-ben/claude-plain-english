# Contributing

Plain English is a small output style whose value depends on staying honest about
facts. Changes start from a reproducible check, not from a rewrite.

## Changing response quality

1. Build a minimal synthetic input instead of pasting a real conversation.
   Remove secrets and personal data before you write anything down.
2. Add the case to `fixtures/claude-response-quality-cases.json` first, declaring
   the facts that must survive and the claims that must not appear. See
   `fixtures/README.md`.
3. Confirm the new case reproduces the problem against current behaviour.
4. Change the style or the evaluator by the smallest amount that fixes it.
5. Run the deterministic checks.

```sh
node scripts/evaluate.mjs validate
```

```sh
node tests/run-all.mjs
```

Editing the style changes its SHA-256, so update `EXPECTED_STYLE_SHA256` in
`tests/plugin-contract.test.mjs` in the same commit. That constant exists to make
an unreviewed edit fail, so treat updating it as part of the review, not as
noise. Do not delete a test or weaken an assertion to make a change pass.

## Verification environment

The deterministic tests in `node tests/run-all.mjs` run without Claude Code. The
install E2E that follows needs a real executable and is pinned in CI to Claude
Code `2.1.228`. If a different version answers, the deterministic tests still
run, and the E2E stops with an explanation instead of reporting a result it did
not verify.

```sh
npm install --global @anthropic-ai/claude-code@2.1.228
```

```sh
CLAUDE_BIN=/absolute/path/to/claude node tests/run-all.mjs
```

Raising the pinned version means the recorded benchmark no longer describes the
verified environment, so it needs a fresh comparison run and a fresh attestation.
Do that in its own issue.

## Documentation and release changes

- If a public command, a settings scope, or the supported surface changes, update
  `README.md` and `tests/docs-contract.test.mjs` together.
- The plugin may contain only the manifest and the output style. Proposing a new
  component or a runtime dependency starts as an issue about scope, not as a
  pull request.
- Adding or removing a tracked file means updating the allowlist in
  `docs/PUBLICATION-CONTRACT.md`, or the public-boundary check fails.
- Read `docs/RELEASE-CHECKLIST.md` before anything that touches a release.

Never put secrets, credentials, personal data, or raw conversation transcripts in
an issue or a pull request. Replace a real case with a synthetic one that carries
the same meaning.
