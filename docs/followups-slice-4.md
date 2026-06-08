# Slice 4 — deferred follow-ups

Final review VERDICT: PASS (0 blockers). Hardening applied before merge: git-init failure now recorded
in `scaffoldProject`'s `skipped` (glass-box auditability).

Deferred / notes:

- **Autopilot + greenfield skills are markdown, exercised only on a live `/muster-autopilot` run.** The
  deterministic helpers (`scaffoldProject`, `renderPlanChecklist`) are unit-tested; the orchestration
  sequence (branch → detect → bootstrap → route → orchestrate → commit-per-wave → present-merge) needs
  a real session to validate end-to-end. First live shakeout pending.
- **Autopilot doesn't accept a GitHub issue number** (atomic does) — outcome string only for now.
- **No auto-push by design** — autopilot stops at the merge decision; revisit if/when a remote exists.
