---
name: domain-router
description: Pick the work domain for an outcome and route to its pipeline (PM/PRD, etc.), else fall back to the software route. Glass-box: records the domain choice + why.
---

# Domain router

1. Classify: `npx muster domain "<outcome>" [--domain <override>]` -> `{domain, source, confidence}`.
2. If `domain` is `unknown`, classify it yourself (model judgment) from the outcome + workspace and
   record that you did so and why (glass box).
3. Look up a pipeline: `npx muster pipeline <domain>`.
   - If a pipeline exists (e.g. `pm` -> PRD), invoke that pipeline skill (e.g. **prd-pipeline**).
   - Else proceed with the existing software route -> Crew Manifest -> orchestrator flow.
4. Record the chosen domain + pipeline (or software fallback) in the run STATE.
