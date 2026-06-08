# Slice 5 — deferred follow-ups

Final review VERDICT: PASS. Hardening applied before merge: `validatePipeline` now requires
`gate.pass_total`; design §3 corrected (the `test` keyword was dropped in implementation).

Deferred (nits, safe to address later):

- **`classifyDomain` substring matching is boundary-less.** `"function"` matches `"functional spec"`,
  `"dysfunctional"`, etc. → software false-positive. Add word-boundary matching (regex `\b`) before the
  keyword sets grow; the router's model fallback only fires on `unknown`, so confident misfires aren't
  caught. Noted in the design too.
- **`scoreArtifact` tie-break is insertion-order, undocumented.** When two criteria tie for weakest,
  the first key wins. Add a tie-break comment/test or sort for stability.
- **`muster domain` CLI outcome extraction edge case.** `--domain pm` as the first token with no
  trailing outcome can read the domain value as the outcome. Tighten the guard.
- **Role taxonomy for PM domains.** PRD phases use free-string roles (`author`/`research`/`score`)
  resolved by the ladder → builtin/inline on a bare machine. A future slice may add PM-specific
  built-ins (an author/research/scorer) and/or vendor knowledge-work PM plugins into the catalog.
- **More pipelines.** business-case/GTM, marketing lead-magnet, ops runbook — quick adds via
  `pipelines/*.yaml` + a pipeline skill, same pattern as PRD.
