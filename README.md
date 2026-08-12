# Plain English for Claude Code

Plain English is a Claude Code output style for people who need answers they can
act on. It asks for direct, complete English, it puts the result first, and it
holds the response to the facts it was given: unknowns stay unknown, checks that
were not run are named, and a claim never comes back stronger than its source.

Plain English here means clear and direct, not short. It does not strip
technical terms, target a reading grade, or cut an explanation that the reader
needs.

The project shares its principles with the Korean Plain output style, but the
English prose was written for English readers rather than translated. It targets
English-specific habits: padded openings, the same conclusion said three times,
headings on a three-sentence answer, telegraphic fragments, and confident
wording that outruns the evidence.

## Current status

The output style, its contract test, the deterministic evaluator, the isolated
install E2E, the blinded comparison harness, the public-boundary check, and the
release gate exist. The blinded comparison against Default has not been run, so
there is no benchmark result, no attestation, and no released version. The
release gate fails until those exist.

Implementation is tracked in GitHub issues and in [`.ralph/plan.md`](.ralph/plan.md).

## What the style asks for

- Lead with the result or the current state, and say the conclusion once.
- Write full sentences in ordinary words, without warm-up lines or inflated
  claims.
- Keep code identifiers, commands, file names, and API names exactly as they are.
- Add a heading, a list, or a table only when it shows a real relationship.
- Separate what was observed, what was inferred, and what is being proposed.
- Never bury an unknown, a failure, a check that was not run, or a remaining risk.
- Invent no numbers, durations, costs, roles, or decisions.
- Preserve claim strength: "not found" is not "does not exist", and "this is how
  it works now" is not "this is a temporary workaround".

The full text is
[`plugins/plain-english/output-styles/plain-english.md`](plugins/plain-english/output-styles/plain-english.md).

## Installation

The plugin is installed from this repository as a local marketplace. Use
`--scope user` for every project, or `--scope project` for one repository.

```sh
claude plugin marketplace add https://github.com/byunghun-ben/claude-plain-english.git --scope user
```

```sh
claude plugin install plain-english@claude-plain-english --scope user
```

Confirm what was installed:

```sh
claude plugin details plain-english@claude-plain-english
```

## Activation

The style declares `force-for-plugin: true`, so it applies while the plugin is
enabled; there is no separate step to turn it on. Settings changes take effect at
the next session, not in a session that is already running.

To select it explicitly, set `outputStyle` in your settings:

```json
{ "outputStyle": "plain-english:Plain English" }
```

## Disabling

```sh
claude plugin disable plain-english@claude-plain-english --scope user
```

Disabling leaves the plugin installed and records it as disabled. New sessions
stop applying the style; a session already running keeps the style it started
with.

## Removal

```sh
claude plugin uninstall plain-english@claude-plain-english --scope user
```

```sh
claude plugin marketplace remove claude-plain-english --scope user
```

The first command removes the plugin and its settings entry. The second removes
the marketplace declaration. An `outputStyle` you set yourself is your own
setting and is not removed for you.

## Verified environment

The install, disable, and removal steps above are exercised by
`tests/install-e2e.mjs` against **Claude Code 2.1.228** on macOS, at both user and
project scope, inside a throwaway environment. Other versions and other operating
systems are not verified.

## Limitations

- The plugin is one output style. It contains no hooks, skills, agents, commands,
  MCP servers, telemetry, or executable code, and the contract test fails if that
  changes.
- It shapes how an answer is written. It does not verify facts, run checks, or
  make a wrong answer right.
- It is English-only. Korean readers should use the separate Korean Plain plugin.
- No comparison against Claude Code's Default style has been run, so this project
  makes no claim about being better than Default.

## Repository layout

```text
.claude-plugin/marketplace.json
plugins/plain-english/.claude-plugin/plugin.json
plugins/plain-english/output-styles/plain-english.md
fixtures/claude-response-quality-cases.json   # synthetic English quality cases
scripts/evaluate.mjs                          # deterministic scoring, no model calls
scripts/compare.mjs                           # blinded Default vs Plain English harness
scripts/check-public-boundary.mjs             # what may be published
scripts/release-gate.mjs                      # fail-closed release check
tests/                                        # contract, evaluator, harness, install E2E
docs/                                         # evaluation, provenance, publication, release
```

## Checks

```sh
node tests/run-all.mjs
```

That runs the deterministic tests, then the install E2E if a Claude Code
executable is available. The pieces can also be run on their own:

```sh
claude plugin validate --strict .
```

```sh
claude plugin validate --strict plugins/plain-english
```

```sh
node scripts/evaluate.mjs validate
```

```sh
node scripts/check-public-boundary.mjs --repo . --working-tree
```

```sh
node tests/install-e2e.mjs --scope user --claude "$(command -v claude)"
```

## Evaluation model

The evaluator applies a factual hard gate: required facts must be present, and
forbidden claims, strengthened certainty, unreported verification gaps, and
non-English output all fail. Readability and the other mechanical measures are
reported as observations and never change that verdict. Style quality itself is
judged by blinded human review, which is a separate step.

Scoring reads recorded responses from disk. Producing those responses is an
opt-in harness that is not part of these checks. [`docs/EVALUATION.md`](docs/EVALUATION.md)
describes the four layers and the trust boundary between what code enforces and
what the operator attests.

## Blinded comparison

`scripts/compare.mjs` runs the same fixture prompt through Default and through
Plain English, keeping the Claude Code version, model, effort, and isolated
settings identical so that only the variant differs. Each call gets a fresh
`HOME`, config directory, plugin cache, and empty project, with MCP restricted to
an empty config, so nothing from the operator's own setup enters a run.

```sh
node scripts/compare.mjs run --evidence /absolute/path/outside/this/repo \
  --claude "$(command -v claude)" --model MODEL --effort EFFORT \
  --seed 0123456789abcdef --repetitions 2 --allow-model-calls
```

Model calls happen only with `--allow-model-calls`. The evidence directory must
live outside this repository; raw responses, the variant mapping, the salt, and
the commitment hashes are written there as mode `0600` files. Execution order and
each reviewer's left/right layout come from separate derivations of the run seed,
so both are reproducible and neither reveals the other.

Authentication has to come from the environment. The isolated config directory
that keeps your settings, hooks, and plugins out of a run also keeps your
credentials out of it, so a run started from a normal interactive login answers
`Not logged in`. Export a long-lived token, which the harness passes through,
before starting a run:

```sh
claude setup-token
```



```sh
node scripts/compare.mjs packet --evidence /absolute/path/outside/this/repo --reviewer reviewer-a
```

A packet carries opaque pair and response IDs with the response bodies and
nothing else. Issuing the first packet freezes the run: after that, `run` refuses
to write into the same evidence directory, and any later edit to the responses or
the mapping fails the commitment check.

```sh
node scripts/compare.mjs aggregate --evidence /absolute/path/outside/this/repo \
  --ratings ratings-reviewer-a.json --ratings ratings-reviewer-b.json
```

Aggregation reveals the variants, rejects incomplete or duplicated ratings, and
reports rating totals, pair outcomes, and the factual hard-gate pass rate per
variant. A pair counts as a win only when every reviewer picked the same variant.

## Contributing and release

[`CONTRIBUTING.md`](CONTRIBUTING.md) covers how a change starts from a fixture.
[`SECURITY.md`](SECURITY.md) covers reporting. [`docs/PUBLICATION-CONTRACT.md`](docs/PUBLICATION-CONTRACT.md)
lists the entire public surface, and [`docs/RELEASE-CHECKLIST.md`](docs/RELEASE-CHECKLIST.md)
describes the release gate.

## License

MIT
