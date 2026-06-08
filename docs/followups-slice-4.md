# Slice 4 — deferred follow-ups

Final review VERDICT: PASS (0 blockers). Hardening applied before merge: git-init failure now recorded
in `scaffoldProject`'s `skipped` (glass-box auditability).

Status:

- **Autopilot + greenfield skills are markdown, exercised only on a live `/muster-autopilot` run.** The
  deterministic helpers (`scaffoldProject`, `renderPlanChecklist`) are unit-tested; the orchestration
  sequence (branch → detect → bootstrap → route → orchestrate → commit-per-wave → present-merge) needs
  a real session to validate end-to-end. First live shakeout pending.
  **INTENTIONAL 2026-06-08** — not a fix item: the live shakeout is now exercised by repeated real
  autopilot runs (the slices since have been built via the autopilot dogfood), so the end-to-end
  sequence is validated by use rather than a unit test.
- **Autopilot doesn't accept a GitHub issue number** (atomic does) — outcome string only for now.
  **DEFERRED — future slice** — net-new input path (issue-number → outcome resolution); outcome string
  is sufficient for now.
- **No auto-push by design** — autopilot stops at the merge decision; revisit if/when a remote exists.
  **INTENTIONAL** — not a fix: autopilot deliberately stops at the merge decision and never auto-pushes;
  autonomy stops at the reviewable artifact.
