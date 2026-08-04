---
name: audit-pattern-architecture
description: Hunt-list pattern skill for muster's architecture audit dimension -- where to look for boundary, coupling, and receipt-grammar drift in muster's own repo. Loaded by the audit orchestrator as a REQUIRED SKILLS binding on the architecture-review dimension task; read on demand, never dispatched standalone.
---

<!-- prompt-lint-disable ANTH-ROLE-001: reference hunt-list loaded ON DEMAND into an already
role-anchored architecture-review dispatch (the persona's own brief assigns the role); a second
"You are..." opener here would be a duplicate persona, not a missing one. -->

# Audit pattern: architecture

**Version:** 1

This is muster's hunt-list for the **architecture** audit dimension (`buildAuditManifest`,
`src/audit.js`, role `architecture-review`). It composes WITH the dispatched persona -- it names
WHAT PATTERNS TO LOOK FOR, the persona still does the reading and judgment. Single-source: this
file does not duplicate docs/architecture.md or docs/binding-interface.md, it points at them.

## Where to dig

- When the audited repo is muster's own (these are muster-authored docs, not shipped into every
  audited target), read `docs/architecture.md` and `docs/binding-interface.md` if present first
  for the DECLARED boundary model (harness primitives: dispatch, ask, enforce, isolate, receipts,
  capability scan) before judging whether the code actually honors it.
- Role vocabulary drift: `src/roles.js`'s `ROLES` array is the single source of the role
  taxonomy (comment: "Keep this the only place the 26 roles are listed"). `grep -rn
  "architecture-review\|tech-debt\|security-review"` across `catalog/*.yaml` and flag any role
  string that is NOT a member of `ROLES` -- that is a hallucinated role a dispatch can never
  resolve.
- Receipt-grammar drift: a new backlog annotation key (`{id}`/`{deps}`/`{disposition}`/
  `{claimed}`/`{done}`/`{human-hold}`) must be reflected in BOTH the parsing code
  (`src/scope.js`, `src/batch-plan.js`, `src/sprint-waves.js`) and the prose that documents the
  grammar (`plugin/commands/go-backlog.md`, `plugin/skills/coordination/SKILL.md`). Grep one side
  for a key the other side doesn't mention; `test/corpus-contradiction.test.js` already guards
  several of these pairs -- check whether a NEW key you find is covered there.
- Circular/reach-around coupling: a "leaf" utility module (`src/fs-safe.js`, `src/roles.js`,
  `src/model.js`) importing back UP from a higher-level orchestration module (`src/audit.js`,
  `src/crew.js`, `src/cli.js`) is a boundary violation. `grep -n "^import" src/fs-safe.js
  src/roles.js src/model.js` and check every target is itself a leaf.
- Catalog role-resolution bypass: a module that hardcodes a provider choice instead of routing
  through `chosen(caps, role)`/`modelFor(caps, role)` (`src/crew.js`) silently forks the
  capability-resolution boundary. `grep -rn "modelForRole\|chosen(caps" src/*.js` and check every
  crew-building function goes through `makeStage`.

## Repo-specific conventions to enforce

- Single-sourced rule: when the same fact is asserted in two files (a count, a taxonomy, a
  grammar), one must be the citation source and the other a pointer -- never two independently
  maintained copies. If present, `docs/anti-patterns.md` entry #6 ("Stale-version walk") is the
  canonical failure mode this produces.
- If present, the harness-binding-interface doc (`docs/binding-interface.md`) is the authority on which
  primitive (dispatch/ask/enforce/isolate/receipts/capability-scan) a given Claude-only construct
  (AskUserQuestion, Agent tool, hooks, worktrees) maps to -- a new harness-specific mention
  outside that map is a documentation-boundary finding, not necessarily a code bug.

If the grep evidence for a candidate boundary violation is ambiguous (the coupling could be
intentional), say so in the finding instead of guessing intent -- an "unsure, needs a human call"
finding is more useful than a confidently wrong one.

## Known false positives to rule out

- `catalog/software.yaml`/`catalog/agents.generated.yaml`/`catalog/builtins.*.yaml` DELIBERATELY
  list multiple competing providers per role at different `rank` values (e.g. `tech-debt` has
  both `wshobson-agents` at rank 70 and `qodo-skills` at rank 35) -- that is the rank-resolution
  design (highest-rank installed wins), not duplication or dead weight.
- `plugin/builtins/wsh-*`, `sp-*`, `gsd-*` are vendored content with their own upstream license
  and provenance (`vendor/manifest.yaml`) -- generic architecture prose inside them that doesn't
  match muster's OWN conventions is expected, not a finding, unless it actively contradicts a
  muster-authored surface it composes with.

## Appended patterns

- (2026-08-04, source: scoped-audit-shakedown architecture ledger) Module-header charter as a testable contract: when a src file opens with a charter comment ("depends only on X", "no <domain> meaning"), verify both halves mechanically — `grep -n "^import"` against the declared dependency list, and every export name plus every error-message string against the excluded domains. In split families the header is often the ONLY written boundary spec. — false-positive note: a charter naming an explicit documented exception is not drift; check the exception before filing.
- (2026-08-04, source: scoped-audit-shakedown architecture ledger) Post-split delta sweep: against the pre-split commit, (a) compare `git show <split>^:<file> | grep -c "^export"` with the family's summed export count and count exports with zero external consumers — a split that multiplies the public surface renamed the problem; (b) check each donor-file comment block still names at least one identifier that remains in that file; (c) grep recipients for "see above"/"this section's header" and confirm each target is same-file. — false-positive note: a deliberate re-export facade keeps the OLD surface; compare against the pre-split count, not zero.

(none yet -- `muster-improver` may append dated, evidenced entries here from run receipts; see
`plugin/skills/improve/SKILL.md`.)

Report findings as a bullet list, one finding per line: severity (P0/P1/P2), location
(file:line), problem, suggested fix -- matching the audit dispatch's own return contract
(`plugin/commands/audit.md` step 3).
