---
name: tournament
description: Run a competing-solutions tournament for one high-uncertainty task — N approach agents, a judge scoring each against the run's success criteria, then deterministic winner selection.
---

# Tournament

Inputs: the task, the Crew Manifest (for `successCriteria`), and N (default 3).

1. Dispatch N implementer agents **concurrently**, each instructed to take a DISTINCT approach to the
   task (vary the angle: e.g. minimal, robust, performance-first).
2. Dispatch a judge agent: score EACH candidate against every item in `successCriteria`, evidence-cited
   (no bare ratings). Produce a candidates array: `[{ id, scores: {criterion: n}, total, passing }]`
   where `passing` means no criterion critically fails (the floor principle).
3. Write the candidates to `.muster/candidates.json` and run `npx muster pick .muster/candidates.json`.
4. If `escalate` is true (none passing), report to the orchestrator (do not ship a loser).
   Otherwise adopt the `winner`'s changes and discard the others.
5. Append the per-candidate scores + winner to the run STATE (glass box).
