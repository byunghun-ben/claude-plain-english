# Fixtures

`claude-response-quality-cases.json` holds the synthetic English cases used by
`scripts/evaluate.mjs`. Every prompt is invented; see `docs/PROVENANCE.md`.

## Adding a case

1. Write a prompt that carries the facts the answer must keep. Invent the
   product names, identifiers, dates, and people.
2. Declare `requiredFacts`. Use `patterns` when every string must appear, and
   `patternGroups` when each group needs one of its alternatives. Patterns are
   matched case-insensitively as substrings, so keep them at least two
   characters long.
3. Declare `forbiddenFacts` as literal phrases a correct answer cannot contain.
   Phrase them so a hedged, correct sentence does not match: "the test suite
   passes" is safe, a bare "passes" is not.
4. Use `forbiddenPatterns` for regular expressions, such as invented percentages
   or durations, and `strengthenedCertaintyPatterns` for wording that claims more
   than the prompt supports.
5. Set `mustExpressUncertainty` and `mustReportUnperformedVerification` with the
   patterns that satisfy them.
6. List the `rubricDimensions` a human reviewer should score. Every case needs
   `factual_fidelity` and `plain_idiomatic_english`, and any case with a
   certainty condition also needs `calibrated_certainty`.

```sh
node scripts/evaluate.mjs validate
```

The schema check also requires the set as a whole to keep covering status,
missing information, decisions, recommendations, technical explanations, short
and long answers, and necessary versus unnecessary lists.
