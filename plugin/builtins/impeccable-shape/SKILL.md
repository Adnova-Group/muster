---
name: impeccable-shape
description: "Impeccable's shape reference (vendored): Plan UX and UI before code: discovery interview and a confirmed design brief."
muster_builtin: true
license: Apache-2.0
upstream:
  - repo: pbakaus/impeccable
    ref: b856e5010f2dd86bd97f9b2d5e38e33f3d5bd992
    path: plugin/skills/impeccable/reference/shape.md
    license: Apache-2.0
    relation: adapted
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001, ANTH-POS-001, GUARD-IDK-001, GUARD-CITE-002: pinned upstream Impeccable playbook, loaded by a muster design-workflow packet that supplies the role, output format and evidence rules; the upstream text stays unedited so `muster vendor update` can 3-way merge it. -->

> **Muster adaptation.** Vendored from [pbakaus/impeccable](https://github.com/pbakaus/impeccable) `plugin/skills/impeccable/reference/shape.md` at `b856e5010f2dd86bd97f9b2d5e38e33f3d5bd992` (skill-v4.8.2), Apache-2.0, Copyright 2025 Paul Bakaus. The upstream text below is unchanged except that links to references muster vendors point at their `impeccable-*` builtins. In muster, run it through the design workflow (`muster design run <workflow>`; read `/impeccable <command>` as that). The DESIGN.md that `design run` resolves is the canonical context, and DESIGN.md is written only through muster's confirmed `design init --content-file` flow. Muster does not ship Impeccable's launcher binary, live browser or hooks: skip any step that runs them (`context`, `detect`, `critique-storage`, `live-server`, `concept-seed`, `surface-brief`, `build-phase`, `pin`, `hooks`, `doctor`) and continue as upstream's "launcher unavailable" path describes. Links to references muster does not vendor (init, new-work, live, generate, the native-platform references for iOS and Android, and the other engine references) name upstream files for context only.

# Shape

Discover what should be made and how it should work, then return a confirmed design brief without code.

## Phase 1: Discovery interview

Do not write code or choose visual direction yet.

### Cadence

- Use the structured question tool when available; otherwise ask and stop.
- Ask two or three related questions per round, then wait. One round is the default; add a second only when the answers expose a material gap.
- Do not dump a questionnaire, repeat settled facts, or turn obvious facts into menus. Assert the likely reading and invite correction.
- A sparse prompt requires at least one answer round. A precise prompt may need only a compact confirmation.

### Round 1: purpose, people, and outcome

Choose the two or three questions that most change the result:

- What is this surface or feature for, and what problem must it solve?
- Who specifically reaches it, in what situation and state of mind?
- What is the primary thing they must understand or do? What would success look like?
- What is uniquely true here that a neighboring product or generic template could not claim?

### Round 2: material, behavior, and boundaries

Run only for material unresolved decisions:

- What real content, evidence, data, and assets must the experience carry? What are realistic minimum, typical, and maximum ranges?
- Which states and transitions matter: first-run, empty, loading, error, success, permissions, overflow, or expert use?
- What is the intended fidelity, breadth, and interactivity: exploration, production-ready screen, full flow, or broader surface?
- What must remain untouched? What would make the result feel wrong even if it looked polished?
- Which platform, framework, performance, accessibility, localization, or delivery constraints are binding?

Never ask for CSS values or canned aesthetic lanes. New-work owns visual-world and concept choices.

## Phase 2: Resolve the design direction

For new surfaces, brand expansion, or replacement, follow [new-work.md](new-work.md) through visual authority, any world workshop, and concept choice. Reuse discovery, then return before its contract, persistence, or implementation. Inside an established world, use its concept process only when composition or interaction remains materially open.

## Phase 3: Write the brief

Write the smallest useful brief:

1. **Job and audience:** who arrives, their context, need, and visitor mode.
2. **Outcome and proof:** primary task/action, success, real evidence, and product-specific truth.
3. **Selected direction:** visual authority, structural/interaction thesis, sequence, focal moment, and implementation consequence.
4. **Scope and boundaries:** fidelity, breadth, interactivity, named target, what remains untouched, and explicit anti-goals.
5. **States and ranges:** realistic content/data ranges and material states.
6. **Interaction and layout:** hierarchy, topology, responsiveness, affordances, feedback, and transitions; intent, not CSS.
7. **Constraints and open decisions:** platform, delivery, accessibility, localization, reusable components, and choices a builder must not invent.

Use three to five bullets when the task is settled; use the full structure only for ambiguous, multi-screen, or standalone planning. Do not restate the conversation.

## Confirm and stop

Present the brief for explicit confirmation or one correction round, then stop: shape never writes code or a direction contract.

When no human or structured answer mechanism exists, mark assumptions plainly, return the brief, and stop.
