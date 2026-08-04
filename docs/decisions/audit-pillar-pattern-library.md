# audit-pillar-pattern-library — pillar audit + hunt-list pattern skills (2026-08-04)

Backlog item `audit-pillar-pattern-library`: every audit pillar must define WHAT PATTERNS TO LOOK
FOR, not just dispatch a persona. This closes the gap: nine pillars, nine versioned hunt-list
pattern skills, composed onto the existing `/muster:audit` dispatch via the audit protocol's
already-existing brief-binding mechanism (`plan[].skills: [{id, rationale}]`) -- no protocol
redesign.

## 1. Reconciling the pillar list

The item names 9 pillars: architecture, tech-debt, coverage, simplification, readability,
security, UX/design, prompt quality, dead-code/duplication. `buildAuditManifest`
(`src/audit.js`) dispatches at most 8 crew members: 6 unconditional core dimensions
(`AUDIT_DIMENSIONS`) plus 2 CONDITIONAL dimensions gated on real evidence in the audited scope
(`prompt-quality` on a prompting signal, `design-ux` on real UI/design evidence).
"dead-code/duplication" is **not** its own dispatched dimension today -- it was always split
across two existing `focus` strings: `tech-debt`'s "dead code" and `simplification`'s
"duplication" (`src/audit.js:5,7`).

Adding a 9th crew role to make the dimension list literally match the 9 pillar NAMES would be an
audit-protocol redesign (a new persona dispatch, a new wave member, a new review-gate surface) --
out of this item's scope ("do NOT redesign the audit protocol; compose with it"). The resolution
kept here: **9 pattern-skill FILES, 8 dispatched dimensions.** `audit-pattern-dead-code-duplication`
composes into BOTH `tech-debt` and `simplification`'s plan tasks (`src/audit.js`'s `PATTERN_SKILL`
map), so the pillar has a real, resolvable pattern skill and 0 pillars are persona-only, without
inventing a 9th crew member.

| Item's pillar name | `src/audit.js` dimension id | Dispatched? |
|---|---|---|
| architecture | `architecture` | always |
| tech-debt | `tech-debt` | always |
| coverage | `coverage` | always |
| simplification | `simplification` | always |
| readability | `readability` | always |
| security | `security` | always |
| UX/design | `design-ux` | conditional (real UI/design evidence) |
| prompt quality | `prompt-quality` | conditional (prompting signal) |
| dead-code/duplication | *(none -- composes into `tech-debt` + `simplification`)* | n/a |

## 2. Pillar × persona × pattern-source × gap table

Persona resolution is dynamic (`chosen(caps, role)` in `src/crew.js`, rank-resolved per
installed capability -- `catalog/agents.muster.yaml`, `catalog/agents.generated.yaml`,
`catalog/software.yaml`, `catalog/builtins.*.yaml`); the "typical persona" column names the
highest-rank muster-authored or vendored candidate, not a hardcoded pin.

| Pillar | Role | Typical persona (rank-resolved) | In-repo pattern source | Gap before this item | Pattern skill (this item) |
|---|---|---|---|---|---|
| architecture | `architecture-review` | `muster-strategist` (`catalog/agents.muster.yaml:29`, rank 55) | `docs/architecture.md`, `docs/binding-interface.md`, `src/roles.js` (role taxonomy), receipt-grammar prose (`plugin/commands/go-backlog.md`) | persona-only | `plugin/skills/audit-pattern-architecture/SKILL.md` |
| tech-debt | `tech-debt` | `wshobson-agents` (`catalog/software.yaml`, rank 70) | zero-reference export sweep (grep procedure), `test-tmpdir-convention` survey, `docs/anti-patterns.md` | persona-only | `plugin/skills/audit-pattern-tech-debt/SKILL.md` |
| coverage | `test-author` | `superpowers`/`sp-tdd` (`catalog/software.yaml`, rank 80) | mutant-kill convention, TDD-first review-gate rule, `test-support/helpers.js` | persona-only | `plugin/skills/audit-pattern-coverage/SKILL.md` |
| simplification | `refactor` | `code-simplifier` (`catalog/software.yaml`, rank 85) | `dedup-cluster` precedent, duplicated-crypto-helper survey | persona-only | `plugin/skills/audit-pattern-simplification/SKILL.md` |
| readability | `code-review` | `muster-reviewer`/`superpowers` (rank 55/80) | oversized-function/misleading-indentation survey (`split-codex-install`, `codex-install-lock-unification`) | persona-only | `plugin/skills/audit-pattern-readability/SKILL.md` |
| security | `security-review` | `pr-review-toolkit`/`security-guidance` (rank 70/80) | `src/fs-safe.js` conventions, `GUARD-SEP-003`, `docs/anti-patterns.md` symlink-guard class | persona-only | `plugin/skills/audit-pattern-security/SKILL.md` |
| UX/design | `frontend` | `wsh-frontend-developer` (`catalog/agents.generated.yaml`, rank 50) | `vendor/impeccable.json` (23 pinned workflows, `audit`/`critique`), `plugin/commands/design.md`, `docs/design.md`, `wsh-wcag-audit-patterns` | persona-only | `plugin/skills/audit-pattern-design-ux/SKILL.md` |
| prompt quality | `prompt-quality` | `muster-prompt-smith` (`catalog/builtins.muster.yaml`, rank 50) | `src/prompt-lint.js`'s `RULES` array, `muster prompt scan` | persona-only | `plugin/skills/audit-pattern-prompt-quality/SKILL.md` |
| dead-code/duplication | *(composes into `tech-debt` + `simplification` above)* | *(same as those two)* | `cleanup-dead-exports` + `dedupe-crypto-helpers` 2026-08-04 survey briefs | persona-only | `plugin/skills/audit-pattern-dead-code-duplication/SKILL.md` |

**Verdict**: before this item, all 9 pillars were persona-only (a dispatched role, no versioned
hunt list naming what to look for beyond the one-line `focus` string in `AUDIT_DIMENSIONS`).
After this item, 0 pillars remain persona-only.

## 3. Composition wiring: the existing brief-binding mechanism, not a new one

`src/manifest.js` already defines a `plan[].skills: [{id, rationale}]` field
(`validateSkillsArray`, `src/manifest.js:57-76`), and `plugin/skills/orchestrator/SKILL.md`'s
"Required skills (brief binding)" section (`plugin/skills/orchestrator/SKILL.md:305-326`)
already turns a task's `skills` binding into a `REQUIRED SKILLS -- load before working:` block in
every dispatched brief (builder AND reviewer), with report-back proof (`skillsUsed`/
`skillsSkipped`, one quoted line actually read from the skill). This is the exact "brief
references/loads the skill file" composition the item asks for, already built and tested.

`src/audit.js`'s `PATTERN_SKILL` map (new) binds each dimension id to its pattern-skill id(s) +
rationale; `buildAuditManifest`'s `auditTasks` now sets `skills: PATTERN_SKILL[d.id] || []` on
every `audit-<dimension>` plan task (`src/audit.js`, the `auditTasks` builder). No change to
`crew[]`, no change to any task's `task` text (existing scope/regex-matching tests in
`test/audit.test.js` stay green unmodified), no new dispatch mechanism -- composition rides the
same path the orchestrator already uses for every other skill binding.

## 4. Pattern-skill format and location

Each pattern skill is `plugin/skills/audit-pattern-<pillar>/SKILL.md` -- the SAME one-dir-per-skill
convention as every other process skill (`review-gate`, `orchestrator`, `coordination`, ...),
discovered by `src/plugin-inventory.js`'s `skillsFromPluginRoot` and packaged by
`scripts/build-codex.mjs`'s `rmAndCopy(plugin/skills -> internal-skills)` exactly like every
existing `plugin/skills/*` entry -- no separate packaging path, no build-script change needed.
Each carries: **Version** header, **Where to dig** (concrete grep shapes/procedures),
**Repo-specific conventions to enforce**, **Known false positives to rule out**, and an
**Appended patterns** section the `muster-improver`/`improve` skill may extend (see
`plugin/skills/improve/SKILL.md` step 4, added by this item) -- proposal-only, user-gated, same
as every other improver edit.

For the two RICH pattern sources the item names explicitly (Impeccable design workflows,
prompt-lint rules), the skill **points into** the canonical source instead of duplicating it
(single-source rule): `audit-pattern-design-ux` cites `vendor/impeccable.json`,
`src/design.js`'s `WORKFLOW_METADATA`, and `plugin/commands/design.md` directly;
`audit-pattern-prompt-quality` cites `src/prompt-lint.js`'s `RULES` array and `muster prompt
scan` directly, never re-listing rule ids/regexes that could drift from the source.

## 5. The 2 proven 2026-08-04 survey briefs, seeded verbatim

The item's cleanup train (`.muster/backlog.md`, "cleanup train (2026-08-04 survey +
audit-pattern directive)" section) recorded two concrete surveys as sibling backlog items,
dispatched the same day as this item, still open at the time of this writing:

- **Dead-code/duplication survey** -> seeded into `audit-pattern-dead-code-duplication.md`,
  quoted verbatim from backlog items `cleanup-dead-exports` (5 named zero-reference exports,
  `src/brief-lint.js`, the kimi-dispatch cluster, codex-fix-loop's orphaned bindings) and
  `dedupe-crypto-helpers` (8 sha256 helpers, 12+ hex-64 regex declarations).
- **Structure/readability survey** -> seeded into `audit-pattern-readability.md`, quoted
  verbatim from backlog items `split-codex-install` (`runCodexInstall`, 503 lines, misleading
  try/catch indentation) and `codex-install-lock-unification` (a hand-rolled ~250+-line lock
  reimplementation of `codex-lock.js`'s shared primitive).

**Honesty note**: no separate "survey brief" document existed on disk under `docs/decisions/` at
dispatch time -- the survey findings live only as the two clusters of backlog items above (their
own text IS the brief). Both surveyed items were still OPEN (not yet merged) when this item's
hunt lists were seeded, so each pattern skill states explicitly that its cited findings are
"verified as of 2026-08-04, still open as of this writing -- re-verify before citing as current"
rather than asserting them as permanently-true examples.

## 6. Gaps, honestly

- Persona resolution is dynamic; the "typical persona" column above is the current highest-rank
  candidate in this dev environment's installed capability set, not a permanent pin. A future
  catalog change can shift which persona actually dispatches for a role without touching this
  doc or the pattern skills (by design -- the pattern skill composes with WHICHEVER persona wins
  role resolution, not a specific one).
- `PATTERN_SKILL`'s bindings are not currently cross-checked against a live
  `resolveCapabilities().skills` inventory by an automated test (that check exists generically as
  `src/manifest.js`'s `manifestWarnings`, opt-in, not wired into `validateManifest`/CI by
  default) -- `test/audit-pattern-skills.test.js` instead proves resolvability directly (the
  SKILL.md file exists on disk with matching frontmatter), which is the stronger, more direct
  guarantee for this repo's own dev/CI environment.
- The `## Appended patterns` sections are seeded empty (version 1) except for the two
  verbatim-seeded surveys already folded into `## Where to dig`; no run has yet exercised the
  `improve` skill's new step 4 to append a run-mined pattern.
