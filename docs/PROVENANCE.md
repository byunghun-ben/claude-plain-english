# Provenance

## Output style

`plugins/plain-english/output-styles/plain-english.md` was written for English
readers. It shares its product principles with the Korean Plain output style —
factual fidelity, calibrated uncertainty, verification boundaries, reader-first
order, and restrained structure — but the prose is not a translation, and it
addresses English-specific failure modes such as padded openings, repeated
conclusions, unnecessary headings, and telegraphic fragments.

`tests/plugin-contract.test.mjs` pins the style by SHA-256 and fails if Korean
source text appears in it.

## Fixtures

Every case in `fixtures/claude-response-quality-cases.json` is invented. No case
comes from a real conversation, a customer record, an operational log, or any
other private source. Product names, identifiers, dates, and people in the
prompts are made up for the fixture.

## Evidence

Comparison evidence — raw responses, the variant mapping, the salt, and the
commitment hashes — is produced by `scripts/compare.mjs` into a directory that
must live outside this repository, written mode `0600`. None of it is tracked by
Git, and `docs/PUBLICATION-CONTRACT.md` forbids publishing it.

No comparison has been run, so no evidence directory exists yet. Comparison
evidence is optional and is not required by the release gate.
