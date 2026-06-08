# Slice 5 — deferred follow-ups

Final review VERDICT: PASS. Hardening applied before merge: `validatePipeline` now requires
`gate.pass_total`; design §3 corrected (the `test` keyword was dropped in implementation).

Deferred (nits, safe to address later):

- ~~**`classifyDomain` substring matching is boundary-less.**~~ **RESOLVED 2026-06-07** (via `muster
  diagnose` dogfood, commit on master): switched to `\b`-anchored regex matching. "epic" no longer
  matches "epicenter", "function" no longer matches "functional". Note: a literal multi-word phrase
  that is genuinely present (e.g. "business case" inside a meta-outcome) still classifies to that
  domain — that's intent ambiguity, not a substring bug; the router's model path handles it. The
  business-case pipeline now exists anyway, so such outcomes route correctly.
- ~~**business-case / more pipelines.**~~ business-case pipeline **shipped** (built via the autopilot
  dogfood). marketing/ops/GTM still quick adds via `pipelines/*.yaml`.
- **`scoreArtifact` tie-break is insertion-order, undocumented.** When two criteria tie for weakest,
  the first key wins. Add a tie-break comment/test or sort for stability.
- **`muster domain` CLI outcome extraction edge case.** `--domain pm` as the first token with no
  trailing outcome can read the domain value as the outcome. Tighten the guard.
- **Role taxonomy for PM domains.** PRD phases use free-string roles (`author`/`research`/`score`)
  resolved by the ladder → builtin/inline on a bare machine. A future slice may add PM-specific
  built-ins (an author/research/scorer) and/or vendor knowledge-work PM plugins into the catalog.
