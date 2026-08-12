# Release checklist

The release gate is fail-closed for repository and release metadata. It never
creates a remote, pushes a commit or a tag, publishes a GitHub Release, or calls
a model. Those remain separate manual decisions.

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

5. In a disposable environment, inspect at least three representative responses:
   one short answer, one answer that must preserve uncertainty or an unperformed
   check, and one longer technical explanation. Confirm that the style is
   rendered, the source facts are preserved, and disabling the plugin stops the
   style in a new session. Keep raw responses outside Git and record only the
   result and execution identity in the release note.

This small response smoke test verifies the runtime behavior that the install E2E
cannot render. It is not a blinded comparison and does not support a superiority
claim over Default.

## Optional blinded comparison

The Default-versus-Plain-English comparison is available when a broader style
study is worth the model-call cost and reviewer time. It is not required for a
release. The current 14 fixtures with two repetitions produce 28 pairs and 56
responses. Any published result must stay scoped to its exact Claude Code
version, model, effort, fixture set, and reviewers.

Raw responses, rating packets, the variant mapping, and the salt stay outside
the repository as mode `0600` files. Only aggregate conclusions may be
published. See `docs/EVALUATION.md` for the trust boundary.

## Running the gate

Create the annotated tag on the release commit first; the gate requires an
annotated tag pointing at `HEAD`.

```sh
git tag -a vX.Y.Z -m "Plain English vX.Y.Z"
```

```sh
node scripts/release-gate.mjs --repo . --tag vX.Y.Z
```

## After the gate passes

Pushing the commit and the tag and publishing a release are separate manual
steps. Nothing in this repository performs them.

## Current state

No version has been released. The optional blinded comparison has not been run.
