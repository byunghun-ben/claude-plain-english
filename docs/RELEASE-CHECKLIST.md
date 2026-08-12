# Release checklist

The release gate is fail-closed. It checks the repository state and an external
attestation, and it stops at the first thing it cannot verify. It never creates a
remote, pushes a commit or a tag, or publishes a GitHub Release; those remain
manual decisions taken after it passes.

## Before tagging

1. `main` is checked out, the working tree is clean, and nothing is untracked.
2. Set the release version in `plugins/plain-english/.claude-plugin/plugin.json`
   and update `EXPECTED_MANIFEST_VERSION` in `tests/plugin-contract.test.mjs` to
   match.
3. Add a `## vX.Y.Z` section to `CHANGELOG.md` describing the release.
4. Run the full suite, including the install E2E, against the pinned Claude Code
   version.

```sh
node tests/run-all.mjs
```

```sh
node scripts/check-public-boundary.mjs --repo . --working-tree
```

## The benchmark attestation

The gate requires an attestation file that lives outside this repository and is
mode `0600`. It is produced from a completed blinded comparison and records only
aggregates: the matrix, the review counts, the rating and pair outcomes, and the
factual hard-gate pass rate per variant. It must not contain a response body, the
variant mapping, or the salt, and the gate rejects any field it does not know.

The attestation binds the result to the release: the commit, the tag, the plugin
version, the style hash, the plugin tree hash, the fixture hash, the Claude Code
version, the model, and the effort level. If any of those has moved since the run,
the attestation is stale and the gate fails.

Thresholds the gate enforces, all of which come from the benchmark definition:

- 12 cases, 2 repetitions, 24 pairs, 48 responses;
- 2 reviewers and 48 ratings, all present and unique;
- at least 36 non-tie ratings;
- Plain English holds at least 60% of the non-tie ratings;
- Plain English pair wins exceed Default pair wins, where a pair is a win only
  when both reviewers picked that variant;
- all 24 Plain English responses pass the factual hard gate, and that pass rate
  is not lower than Default's.

## Running the gate

```sh
node scripts/release-gate.mjs --repo . --tag vX.Y.Z --attestation /absolute/path/outside/this/repo/attestation.json
```

Create the annotated tag on the release commit first; the gate requires an
annotated tag pointing at `HEAD`.

```sh
git tag -a vX.Y.Z -m "Plain English vX.Y.Z"
```

## After the gate passes

Pushing the commit and the tag and publishing a release are separate manual
steps. Nothing in this repository performs them.

## Current state

No comparison has been run and no attestation exists, so the gate cannot pass and
no version has been released.
