## Mutant-kill gate

Additive to every criterion above — it never replaces, softens, or substitutes for the
existing review-gate procedure. It fires the moment a wave introduces a new test or eval
guard: a new test file, a new assertion added to an existing test file, a new
`eval/*/dataset.json` case, or a new lint/doctor rule. When fired, the wave cannot PASS
without a demonstrated kill recorded in the review evidence — proof the new guard actually
catches the defect it claims to catch, not just proof it runs green against
already-correct code.

The required evidence shape, in order:

1. **The mutation** — the guarded artifact (the code, config, or prose the new guard
   checks) is edited to reintroduce the defect the guard exists to catch, in a scratch
   copy or a revert-before-commit change — never landed as part of the wave.
2. **The failing output** — the new guard is run against the mutated artifact and its
   actual failing output (the test/eval failure text, not a paraphrase or a claim that it
   "would fail") is pasted into the review evidence.
