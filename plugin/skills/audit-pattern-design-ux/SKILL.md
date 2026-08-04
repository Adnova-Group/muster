---
name: audit-pattern-design-ux
description: Hunt-list pattern skill for muster's UX/design audit dimension -- points into the pinned Impeccable design-workflow vocabulary and muster's design-gate machinery rather than duplicating it. Loaded by the audit orchestrator as a REQUIRED SKILLS binding on the frontend (design-ux) dimension task; read on demand, never dispatched standalone.
---

<!-- prompt-lint-disable ANTH-ROLE-001: reference hunt-list loaded ON DEMAND into an already
role-anchored frontend dispatch; a second "You are..." opener here would duplicate the persona. -->

# Audit pattern: UX/design

**Version:** 1

Hunt-list for the **design-ux** audit dimension (`buildAuditManifest`, `src/audit.js`, role
`frontend`, conditional on real UI/design evidence in the audited scope).

**Single-source rule**: this pillar's pattern source is RICH (a full pinned vendored vocabulary)
-- this file POINTS INTO it rather than duplicating it. Do not copy workflow descriptions here;
read the cited files directly, they are the canonical source.

## Where to dig

- Run `muster design workflows` (or read `src/design.js`'s `WORKFLOW_METADATA`) for the complete
  list of 23 pinned Impeccable-inspired workflows (`vendor/impeccable.json`, upstream
  `github.com/pbakaus/impeccable` @ `32930818a109fafa87199babe92fa8e530cff5d3`, Apache-2.0). The
  two READ-ONLY workflows this audit dimension actually maps to are `audit` ("Audit
  accessibility, performance, responsiveness, and design quality") and `critique` ("Evaluate
  hierarchy, information architecture, resonance, and cognitive load") -- read their full
  descriptions in `src/design.js` before dispatching, don't paraphrase from memory.
- Read `plugin/commands/design.md` end to end for the full workflow vocabulary, the `design gate`
  contract, and how a missing `DESIGN.md` is handled during a read-only audit (it is a FINDING,
  never a blocker -- see that file's own "Read-only audit is different" paragraph).
- `docs/design.md`, if present (a muster-authored doc, not shipped into every audited target),
  documents the design-context resolution and gate behavior in more depth than the command prose;
  read it for the init/status/resolve/detect/ignores/provider surface if the finding concerns
  context resolution rather than a workflow itself.
- Accessibility-specific depth: `plugin/builtins/wsh-wcag-audit-patterns/SKILL.md` (vendored,
  WCAG 2.2, MIT, `wshobson/agents`) is the deeper accessibility-specific hunt-list if the audited
  scope's finding is squarely an a11y violation (POUR principles, conformance levels A/AA/AAA) --
  read it directly rather than re-deriving accessibility criteria here.

## Repo-specific conventions to enforce

- A missing canonical `DESIGN.md` (checked via `design status`/`design resolve`) is reported as a
  finding in the ledger, never used as a reason to skip or degrade the audit dimension itself.
- Any REMEDIATION (as opposed to the read-only audit finding) requires a current `muster design
  gate` receipt before it proceeds -- `plugin/commands/audit.md` step 5 already encodes this;
  don't propose a fix that skips the gate.
- `design run <workflow>` writes; `design run audit`/`design run critique` (or the audit
  dimension's own read-only sweep) does not -- keep that read/write boundary in mind when
  describing a finding's remediation path.

## Known false positives to rule out

- The design dimension is CONDITIONAL (`opts.designEvidence`) -- a plain non-UI codebase
  correctly has NO design-ux crew member at all; its absence from the crew is not itself a gap.
- `designEvidence === "unknown"` (truncated detection) must NOT be treated as definitive absence
  -- `src/audit.js` already keeps the dimension included and records a degradation note in that
  case; don't file a finding claiming "no UI evidence" when detection was merely incomplete.

## Appended patterns

- (2026-08-04, source: scoped-audit-shakedown design-ux ledger) Gradient-on-text (`background-clip:text` / `-webkit-text-fill-color`, incl. framework classes like VitePress `.clip`) must be contrast-checked per gradient stop against the actual rendered background — verify via the rendered class list or build output, since a token's "decorative" documentation label does not clear essential copy. — false-positive note: genuinely decorative gradient text (non-essential, with an accessible sibling) passes.
- (2026-08-04, source: scoped-audit-shakedown design-ux ledger) When DESIGN.md's prose declares a narrower jurisdiction than the repo root (e.g. "governs website/**"), RUN `design status` / `design gate` and diff the resolved scopeRoot against the declared scope — a gate passing repo-wide under a file disclaiming repo-wide authority is its own finding class, distinct from a missing-DESIGN.md finding. — false-positive note: a deliberately repo-wide DESIGN.md with matching prose is compliant.
- (2026-08-04, source: Nielsen heuristic #9, quoted verbatim: "Error messages should be expressed in plain language (no error codes), precisely indicate the problem, and constructively suggest a solution" — https://www.nngroup.com/articles/ten-usability-heuristics/ + in-repo precedent: installed-mode-cache-drift produced "Remediation produced: rerun `muster install codex`") CLI failure-surface remediation check: every user-facing doctor/install/CLI failure must name the offending value AND a next action; readability already hunts the no-interpolation half — this hunts the no-next-action half (grep user-facing throw/exit sites for messages lacking an actionable verb). If the conditional design-ux dimension doesn't fire for a CLI-only scope, route the finding to readability rather than dropping it. — false-positive note: internal invariant errors never surfaced to end users are exempt; check the call path reaches a user surface first.

(`muster-improver` may append further dated, evidenced entries here from run receipts, gated by
user approval; see `plugin/skills/improve/SKILL.md`.)

Report findings as a bullet list, one finding per line: severity (P0/P1/P2), location
(file:line), problem, suggested fix -- matching the audit dispatch's own return contract
(`plugin/commands/audit.md` step 3).
