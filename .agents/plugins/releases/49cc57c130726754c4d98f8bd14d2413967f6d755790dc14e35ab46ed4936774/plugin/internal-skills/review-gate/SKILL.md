---
name: review-gate
description: "Codex-compatible Muster workflow. Adversarial review gate for a completed wave — dispatch all available reviewers in parallel, tally verdicts, and loop fixes until clean or escalate."
---

## Codex harness binding

Read `${PLUGIN_ROOT}/runtime/codex-skill-adapter.md` before following this workflow. Its Codex tool, subagent, input, mode-name, and plugin-root bindings override legacy harness names below; the workflow's domain rules and gates remain authoritative. Load any relative bundled asset named by this workflow through `node ${PLUGIN_ROOT}/runtime/resolve-skill-provider.mjs builtin review-gate <relative-asset>`; never read the internal tree directly.

# Review gate

You are muster's adversarial review gate — dispatch reviewers, tally verdicts, drive fix iterations, and escalate unresolved blockers.

Return with a pass or escalate verdict to the orchestrator; format the response as a one-line status with blocker notes listed when relevant.

Inputs: the wave's changes, and `AvailableCapabilities` (from `node ${PLUGIN_ROOT}/runtime/muster.mjs capabilities --codex`).

**QA memory:** before testing, read `docs/qa/RUNBOOK.md` if present
(check-before-test) — it carries repo-specific flows, expected signals, and
known gotchas that generic process doesn't know. When a gate run discovers a
divergence from the runbook or a new gotcha, the fix pass UPDATES the runbook
(update-after-divergence) — say so explicitly in the reviewer's finding so the
update isn't silently dropped.

1. Select reviewers: the chosen providers for roles `code-review` and `security-review`. If none are
   installed, use the built-in reviewer. Always at least one.
2. Dispatch reviewers **concurrently**, each adversarially prompted to REFUTE the work / find the worst
   real problem. Each returns findings: `[{ severity: "blocker"|"risk"|"nit", note }]`.
3. **Citation guard (research/content artifacts):** run `node ${PLUGIN_ROOT}/runtime/muster.mjs citation-check <file>`
   on each produced artifact. A dangling anchor (checker reports `ok:false`, exits 2) is an automatic
   FAIL finding — no reviewer judgment needed. `uncited` paragraphs are NOT auto-failed: hand each flagged
   paragraph to a reviewer for the judgment call (is this actually a claim needing evidence, or just
   connective prose?) and record a `pass`/`needs_review`/`fail` verdict per flagged paragraph. Flagged
   paragraphs fold into the reviewers' finding lists from step 2 — run the checker BEFORE dispatching
   those reviewers so the flags travel in their briefs; never a separate reviewer round. Artifact
   delivery is blocked while any `fail` — from the guard or a reviewer's verdict — stands. Artifacts from
   an ingestion-bearing phase (one whose desc carries the doc-ingestion contract — anchored facts,
   ledger-before-synthesis) are also checked for that discipline: a fact asserted in the artifact with no
   traceable anchor is itself a finding, same severity handling as a dangling citation.
4. **Intent vs implementation:** before verdicting, run `git notes --ref=muster show <wave commit>` when a
   note exists, and check the implementation against the RECORDED decisions (intent), not just the diff
   against the spec. A mismatch between recorded decisions and code is a finding even when tests pass.
5. Write verdicts to `.muster/verdicts.json`; run `node ${PLUGIN_ROOT}/runtime/muster.mjs tally .muster/verdicts.json`.
6. If `blocked`: re-dispatch the implementer with the blocker notes, then re-review. Cap at
   **3 fix iterations** (`REVIEW_GATE_MAX_ITERATIONS` = 3). If still blocked after the cap, ESCALATE to the human with the unresolved blockers.
7. Carry `risk`/`nit` findings to FOLLOWUPS (non-blocking).

Return pass (all clear) or escalate (cap hit with remaining blockers) to the orchestrator.

## Surface-type definition-of-done gates

These three gates are **additive** to every criterion above — they never replace, soften, or
substitute for the existing review-gate procedure. A gate FIRES the moment ANY of its listed
trigger classes hits. The reviewer records, per fired gate, which trigger fired and what evidence
resolved it. A fired gate with no recorded evidence is an automatic FAIL for the wave.

1. **Design/UX gate** — triggers: the plan task's `surface` field is `"ui"`; OR the task's `skills`
   binding includes `frontend-design` (or any skill tagged design/frontend); OR the wave diff touches
   UI file-globs (`components/**`, `app/**/page.*`, `app/**/layout.*`, `*.css`, `*.scss`). When fired:
   the wave cannot PASS without a design/UX review pass. Reviewer selection mirrors step 1's
   reviewer-selection fallback above: the chosen provider for role `frontend`
   (`AvailableCapabilities.roles.frontend.chosen`); if none installed, fall back to the built-in
   reviewer running an explicit design-review checklist — always at least one. Findings addressed —
   visual hierarchy, spacing, contrast, empty/error states, microcopy tone for the product's audience.
   Evidence must quote the specific element/state the reviewer looked at (e.g. the empty-state
   component, the mobile breakpoint) and the reviewer's verbatim note on it — a list of category
   names ("checked spacing, contrast, empty states") is not evidence.
2. **Humanizer gate** — triggers: `surface` is `"copy"`; OR the task's `skills` binding includes
   `muster-humanizer` (or any skill tagged humanizer/copy-review); OR the diff adds/edits
   customer-facing copy (user-visible strings, marketing/report/email text, chat prompts that produce
   end-user prose). When fired: the copy must pass the muster humanizer pipeline (`humanize` +
   `humanize-score`) before PASS. Evidence must quote the specific string/copy reviewed and the
   reviewer's verbatim note on it, the same bar as the Design/UX gate above — a list of category
   names is not evidence.
3. **Live-verification gate** — triggers: `surface` is `"integration"`; OR the task's `skills`
   binding includes `sp-verify` (or any skill tagged verification/integration-testing); OR the wave
   claims an integration works (external API, OAuth flow, DB migration, deploy). When fired: PASS
   requires live evidence — the actual command/request and its observed result recorded in the
   review, not inference from unit tests.

## Mutant-kill gate

Additive to every criterion above — it never replaces, softens, or substitutes for the
existing review-gate procedure. It fires the moment a wave introduces a new test or eval
guard: a new test file, a new assertion added to an existing test file, a new
`eval/*/dataset.json` case, or a new lint/doctor rule. When fired, the wave cannot PASS
without a demonstrated kill recorded in the review evidence — proof the new guard actually
catches the defect it claims to catch, not just proof it runs green against
already-correct code.

The required evidence shape, in order:

1. **The mutation** — the guarded artifact (the code, config, or prose the new guard
   checks) is edited to reintroduce the defect the guard exists to catch, in a scratch
   copy or a revert-before-commit change — never landed as part of the wave.
2. **The failing output** — the new guard is run against the mutated artifact and its
   actual failing output (the test/eval failure text, not a paraphrase or a claim that it
   "would fail") is pasted into the review evidence.
3. **The byte-identical restore** — the mutation is reverted and the artifact is confirmed
   restored byte-identical to its pre-mutation state (e.g. `git diff` reports no changes)
   before the wave proceeds to PASS.

A fired gate with no recorded evidence in this shape is an automatic FAIL for the wave —
"I tested it and it works" or "the guard looks correct" is not evidence; the pasted
mutation, the pasted failing output, and the confirmed restore are.
