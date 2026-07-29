## Mutant-kill gate

Additive, never a softening. Fires when a wave adds a new test/eval guard (a test file, an assertion,
an `eval/*/dataset.json` case, a lint/doctor rule). PASS requires a demonstrated kill, in order:

1. **The mutation** — reintroduce the defect the guard catches, in a scratch copy or a
   revert-before-commit change, not landed.
2. **The failing output** — the guard's actual failing text against the mutated artifact, pasted
   verbatim.
3. **The byte-identical restore** — the mutation reverted and confirmed restored (`git diff` clean)
   before PASS.

A fired gate with no evidence in this shape is an automatic FAIL — "it works" is not evidence; the
pasted mutation, failing output, and confirmed restore are.

## Rubric-fed verifiers

When `.muster/rubric.md` exists, every reviewer brief includes its full content verbatim as a
`RUBRIC:` block, the user's own stated taste. A finding that maps to a rubric dimension cites
that dimension by name. Propose-not-invent: reviewers never fabricate rubric dimensions the file
does not carry. Absence of the file changes nothing — every step above stands as written.
<!-- muster-brief-template:end -->
