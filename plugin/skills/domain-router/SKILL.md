---
name: domain-router
description: Pick the work domain for an outcome and route to its pipeline (PM/PRD, etc.); for unrecognized domains, classify by judgment and pick the closest pipeline. Falls back to the software route for code workspaces. Glass-box: records the domain choice + why.
---

# Domain router

1. Route: `npx -y @adnova-group/muster route "<outcome>"` -> `{domain, pipeline}`. This picks the specific pipeline by
   matching the outcome (e.g. "epic" -> epic, "release notes" -> release-notes, "write a book" -> book),
   falling back to the domain's default pipeline (pm -> prd, business -> business-case).
2. If `pipeline` is non-null, run it (the `prd-pipeline` skill is the reference shape: intake ->
   research -> draft -> review -> score, reusing the review-gate + floor-scored gate). The pipeline's
   `phases` name the roles; each resolves via the capability ladder (installed -> built-in -> inline).
3. If `pipeline` is null:
   - `domain` software (or a code workspace) -> the normal software route -> Crew Manifest -> orchestrator.
   - else classify the work yourself (model judgment) and pick the closest pipeline, recording why.
4. Record the chosen domain + pipeline (or software fallback) in the run STATE (glass box).
