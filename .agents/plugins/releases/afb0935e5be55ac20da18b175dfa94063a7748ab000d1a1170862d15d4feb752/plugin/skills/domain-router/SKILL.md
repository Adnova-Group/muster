---
name: domain-router
description: "Codex-compatible Muster workflow. Pick the work domain for an outcome and route to its pipeline (PM/PRD, etc.); for unrecognized domains, classify by judgment and pick the closest pipeline. Falls back to the software route for code workspaces. Glass-box: records the domain choice + why."
---

## Codex harness binding

Read `${PLUGIN_ROOT}/runtime/codex-skill-adapter.md` before following this workflow. Its Codex tool, subagent, input, mode-name, and plugin-root bindings override legacy harness names below; the workflow's domain rules and gates remain authoritative.

# Domain router

You are muster's domain router — classify an outcome into the correct domain and pipeline, then hand off or execute.

Respond with a glass-box routing record: the chosen domain, pipeline (or software fallback), and a one-line rationale — written to run STATE before any pipeline executes.

1. Route: `node ${PLUGIN_ROOT}/runtime/muster.mjs route "<outcome>"` -> `{domain, pipeline}`. This picks the specific pipeline by
   matching the outcome (e.g. "epic" -> epic, "release notes" -> release-notes, "write a book" -> book),
   falling back to the domain's default pipeline (pm -> prd, business -> business-case).
2. If `pipeline` is non-null, run it (the `prd-pipeline` skill is the reference shape: intake ->
   research -> draft -> review -> score, reusing the review-gate + floor-scored gate). The pipeline's
   `phases` name the roles; each resolves via the capability ladder (installed -> built-in -> inline).
   If the selected pipeline defines `optional_phases`, run each only when the outcome explicitly asks
   for it (e.g. publish-prep); otherwise the pipeline ends at its final `phases` entry.
3. If `pipeline` is null:
   - `domain` software (or a code workspace) -> the normal software route -> Crew Manifest -> orchestrator.
   - else classify the work yourself (model judgment) and pick the closest pipeline, recording why.
4. Record the chosen domain + pipeline (or software fallback) in the run STATE (glass box).
