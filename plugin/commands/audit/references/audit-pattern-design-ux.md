---
name: audit-pattern-design-ux
description: Hunt-list pattern skill for muster's UX/design audit dimension -- leads with the vendored impeccable critique and audit skills, then points into the uupm priority table and pre-delivery checklist, the supporting UX skills and muster's design-gate machinery rather than duplicating them. Loaded by the audit orchestrator as a REQUIRED SKILLS binding on the frontend (design-ux) dimension task; read on demand, never dispatched standalone.
upstream:
  - repo: pbakaus/impeccable
    ref: 035c8f319edd019936525a062fe99e83ca8d12c6
    path: null
    license: Apache-2.0
    relation: inspired-by
  - repo: nextlevelbuilder/ui-ux-pro-max-skill
    ref: 4f2dbb67e64969a9a30ab00742f2d55d66ddec2b
    path: null
    license: MIT
    relation: inspired-by
  - repo: ghaida/intent
    ref: 1806110106a472bc588d7a8a2b7e3d39aee4a4b8
    path: null
    license: CC0-1.0
    relation: inspired-by
  - kind: article
    title: 10 Usability Heuristics for User Interface Design
    author: Jakob Nielsen (Nielsen Norman Group)
    url: https://www.nngroup.com/articles/ten-usability-heuristics/
    relation: inspired-by
---

<!-- prompt-lint-disable ANTH-ROLE-001: reference hunt-list loaded ON DEMAND into an already
role-anchored frontend dispatch; a second "You are..." opener here would duplicate the persona. -->

# Audit pattern: UX/design

**Version:** 3

Hunt-list for the **design-ux** audit dimension (`buildAuditManifest`, `src/audit.js`, role
`frontend`, conditional on real UI/design evidence in the audited scope).

**Single-source rule**: this pillar's pattern source is RICH (impeccable's vendored skills plus a
searchable data layer) -- this file POINTS INTO them rather than duplicating them. Do not copy
their checklists here; read the cited files directly, they are the canonical source.

## Where to dig

- impeccable is muster's main UX skill (vendored, merge-tracked, upstream
  `github.com/pbakaus/impeccable` @ `035c8f319edd019936525a062fe99e83ca8d12c6`, Apache-2.0). The
  two READ-ONLY workflows this audit dimension maps to are `audit` and `critique`; their
  playbooks are `<plugin root>/builtins/impeccable-audit/SKILL.md` (technical quality:
  accessibility, performance, theming, responsive, anti-patterns) and
  `<plugin root>/builtins/impeccable-critique/SKILL.md` (UX review: hierarchy, information
  architecture, heuristic scoring, personas, cognitive load), both run under
  `<plugin root>/builtins/impeccable-core/SKILL.md`. Read them before dispatching; don't
  paraphrase from memory. `muster design workflows` lists all 24 workflows.
- Read `plugin/commands/design.md` end to end for the full workflow vocabulary, the `design gate`
  contract, and how a missing `DESIGN.md` is handled during a read-only audit (it is a FINDING,
  never a blocker -- see that file's own "Read-only audit is different" paragraph).
- `docs/design.md`, if present (a muster-authored doc, not shipped into every audited target),
  documents the design-context resolution and gate behavior in more depth than the command prose;
  read it for the init/status/resolve/detect/ignores/provider surface if the finding concerns
  context resolution rather than a workflow itself.
- Accessibility-specific depth: `<plugin root>/builtins/wsh-wcag-audit-patterns/SKILL.md` (vendored,
  WCAG 2.2, MIT, `wshobson/agents`) is the deeper accessibility-specific hunt-list if the audited
  scope's finding is squarely an a11y violation (POUR principles, conformance levels A/AA/AAA) --
  read it directly rather than re-deriving accessibility criteria here.

## UX review sources and precedence

The design-ux reviewer leads with impeccable, uses uupm as the data and checklist layer, then
adds the specialist depth below. `<plugin root>` is `${CLAUDE_PLUGIN_ROOT}`; every builtin is read
by path (none is in the slash menu).

1. **impeccable's critique dimensions** (the primary review, `impeccable-critique` and
   `impeccable-audit` above): hierarchy, information architecture, resonance and cognitive load,
   then accessibility, performance, theming, responsiveness and anti-patterns. Every finding
   starts from one of these dimensions.
2. **uupm's priority table and pre-delivery checklist** (`uupm-ui-ux-pro-max`, the data and
   checklist layer under impeccable): the "Rule Categories by Priority" table in
   `<plugin root>/builtins/uupm-ui-ux-pro-max/SKILL.md` sets the ORDER of the sweep (priority 1
   first) and the default severity band; each category's full rules are in its
   `references/quick-reference.md`, and the canonical pre-delivery checklist is the
   "Pre-Delivery Checklist" section of its `references/pro-rules.md`. Use them to order a sweep
   and to confirm nothing on the checklist was missed. Read those files; do not restate them. Its `scripts/search.py "<one outcome>" --domain ux` confirms a specific guideline
   when a finding needs a citation.

**Deduplicate before reporting.** The two checklists overlap (accessibility, responsiveness,
hierarchy, performance appear in both). Report each defect ONCE, under the highest-precedence
source that covers it, and name the other sources that agree in the same line. Never file one
defect twice because two checklists name it.

**Precedence when sources disagree**, highest first:

1. the project's canonical `DESIGN.md` (via `muster design resolve`);
2. accessibility / WCAG 2.2 (`wsh-wcag-audit-patterns`, Nielsen's heuristics for usability);
3. impeccable (`/muster:design` workflows);
4. the supporting skills below, uupm style suggestions last.

A uupm or supporting-skill suggestion that contradicts `DESIGN.md` is not a finding; a
`DESIGN.md` rule that fails WCAG is (report it against `DESIGN.md`).

**Specialist depth** (read only when the scope calls for it; each is a builtin under
`<plugin root>/builtins/<id>/SKILL.md`):

- `intent-evaluate`: Nielsen heuristic evaluation and cognitive walkthrough with
  critical/major/minor/cosmetic severities; `intent-fortify` for edge, empty, error and loading
  states; `intent-include` for screen-reader, cognitive and motor depth beyond WCAG.
- `pfd`: a separately licensed (CC BY-SA 4.0) design method about how people first take in an
  interface; read that builtin itself when first-impression quality is in scope, and cite it by id.
- `jk-interface-review`: a second-pass interface review; `jk-better-accessibility` for
  component-level accessibility fixes; `jk-better-interface` and `jk-better-ui` for interface
  detail and polish findings.
- `emil-review-animations` for motion quality; `emil-animation-performance` and
  `gsap-performance` when animation cost is in scope.
- `emil-break-ui` and `jk-break` for stress-testing states and edge cases.
- `addy-browser-testing-with-devtools` when a finding needs runtime evidence (console, network,
  rendered layout) rather than a source read.

The taste-* and other build-direction skills (`taste-*`, `hallmark`, `anthropic-frontend-design`,
`elaya-*`) shape new work and are not audit sources. These best-of-breed ids are vendored by a
sibling track; they sit with the supporting skills in the precedence above.

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
- (2026-08-04, source: Nielsen heuristic #9 on error recovery, paraphrased: an error message names the problem in plain words, without codes, and proposes a way out — https://www.nngroup.com/articles/ten-usability-heuristics/ + in-repo precedent: installed-mode-cache-drift produced "Remediation produced: rerun `muster install codex`") CLI failure-surface remediation check: every user-facing doctor/install/CLI failure must name the offending value AND a next action; readability already hunts the no-interpolation half — this hunts the no-next-action half (grep user-facing throw/exit sites for messages lacking an actionable verb). If the conditional design-ux dimension doesn't fire for a CLI-only scope, route the finding to readability rather than dropping it. — false-positive note: internal invariant errors never surfaced to end users are exempt; check the call path reaches a user surface first.

(`muster-improver` may append further dated, evidenced entries here from run receipts, gated by
user approval; see `plugin/skills/improve/SKILL.md`.)

Report findings as a bullet list, one finding per line: severity (P0/P1/P2), location
(file:line), problem, suggested fix -- matching the audit dispatch's own return contract
(`plugin/commands/audit.md` step 3).
