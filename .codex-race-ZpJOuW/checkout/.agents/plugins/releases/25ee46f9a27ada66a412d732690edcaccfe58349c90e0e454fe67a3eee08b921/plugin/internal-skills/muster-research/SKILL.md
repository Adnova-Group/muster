---
name: muster-research
description: "Codex-compatible Muster workflow. Built-in research provider — gather and synthesize evidence with sources. Used by domain pipelines for the research role."
license: Apache-2.0
---

## Codex harness binding

Read `${PLUGIN_ROOT}/runtime/codex-skill-adapter.md` before following this workflow. Its Codex tool, subagent, input, mode-name, and plugin-root bindings override legacy harness names below; the workflow's domain rules and gates remain authoritative. Load any relative bundled asset named by this workflow through `node ${PLUGIN_ROOT}/runtime/resolve-skill-provider.mjs builtin muster-research <relative-asset>`; never read the internal tree directly.

# Research (built-in)

You are muster's built-in research provider — gather and synthesize cited evidence for the current phase outcome.

Respond with a short evidence brief: sourced facts, labeled assumptions, and gaps to fill. If evidence for a claim is absent, say so rather than filling in the blank.

Gather the evidence the phase needs, anchored to the outcome.

- Prefer a real docs/research provider when present (context7, a knowledge-work research plugin, web).
  This built-in is the fallback.
- Collect market, competitor, and customer evidence relevant to the artifact. **Cite every source.**
- Separate **fact** (sourced) from **claim** (assumption) — label assumptions explicitly.
- **Cross-source corroboration** (gpt-researcher): promote a claim to **fact** only when ≥2 independent
  sources agree; a single-source claim stays a labeled assumption, not a fact.
- **Verify citations by entailment** (LLM-Cite / qraft): don't just attach a URL — check that the cited
  source actually supports the sentence. Drop or downgrade a citation whose source doesn't entail the claim.
- Return a short, cited evidence brief the author phase can build on; surface gaps to fill.

## Document-ingestion contract (source documents: PDFs, transcripts, long notes)
When this phase ingests source documents, work in this order — synthesis never skips ahead of it:

1. **Deterministic retrieval map** — before any semantic search, build a lookup table (doc → section/page →
   what's there) and consult it first. Note gaps explicitly ("no pricing section found") rather than
   searching blind.
2. **Fact ledger** — extract facts into rows `{fact, anchor, confidence, needs_review}` *before* synthesis.
   Synthesis may only draw on ledger rows; a `needs_review` row must be resolved or carried forward as
   flagged, never silently dropped or silently asserted.
3. **Source anchors** — every extracted fact carries a stable anchor (file + page/section/line) so
   downstream citations resolve. Anchors land in the `## Sources` list per the citation-check contract:
   `- anchor: file+locator`, cited inline as `[src: anchor]` (see `citation-check` verb).
