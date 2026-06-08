# Muster slice 6 — Diagnose (bug-fix) mode

- Status: draft for review
- Date: 2026-06-07
- Builds on: slices 1–5 (router, fan-out/review, native built-ins, autopilot/greenfield, domain pipelines)

## 1. What slice 6 adds

A failure-first run mode — Muster's answer to atomic's `subagent-diagnose`. Today the *method* is
bundled (vendored `sp-debug` = superpowers systematic-debugging; `wsh-debugging-strategies` = wshobson)
but there's no workflow that starts from a failure. Slice 6 wires it up:

- A **`debug` role** so `capabilities` resolves a debugger across the ladder — installed external
  (wshobson debugging agents / a debugger MCP) → bundled built-in (`sp-debug` or
  `wsh-debugging-strategies`) → inline. Not hardcoded to one provider.
- A **`diagnose` skill** + `muster diagnose` entry that takes a *failure*, runs systematic debugging
  (hypothesis → cheapest test → root cause), emits a **fix Crew Manifest**, and routes it through the
  existing **orchestrator + review-gate**, finishing with a regression test + present-merge.
- Two modes (mirror atomic): **`ci`** (a failing test / CI output is the seed) and **`bug`** (a
  freeform symptom).

## 2. Goals / non-goals

**Goals**
1. Add `debug` to the capabilities role set; map the vendored debugging built-ins to it, and recognize
   wshobson debugging agents as an external `debug` provider (recommend when absent).
2. `classifyFailure(input)` — deterministic mode pick: `ci` (looks like test/CI output: FAIL/✗/stack/
   "exit code"/assert) vs `bug` (prose symptom). `{mode, signal}`.
3. `buildDiagnoseManifest(failure, caps)` — deterministic fix-manifest scaffold: outcome = "resolve
   <signal>", success criteria includes "regression test added + suite green", plan =
   reproduce → root-cause(debug) → fix(implement) → regression-test(test-author) → verify, crew from caps.
4. CLI: `muster diagnose <symptom | --ci <file>>` → prints `{mode, manifest}` (validated).
5. `diagnose` skill + `/muster:diagnose` command driving the loop, reusing orchestrator + review-gate.
6. Glass box: hypothesis table + root cause recorded in STATE; outcome-anchored (fixed AND regression test).

**Non-goals (deferred)**
- New investigation *method* (we reuse vendored systematic-debugging / wshobson debugging).
- Auto-pulling CI logs from a provider API (the `--ci` seed is a local file / pasted output for now).
- Multi-hypothesis tournament for root cause (could reuse slice-2 tournament later; v1 single path).

## 3. The `debug` role (ladder across providers)

- `src/capabilities.js` ROLES += `"debug"`.
- Built-ins remapped to include `debug`: `sp-debug`, `wsh-debugging-strategies` (currently `implement`).
  Update `vendor/manifest.yaml` (source of truth) AND the generated `catalog/builtins.generated.yaml`
  entries so resolution works now without a full re-vendor.
- External: `catalog/software.yaml` `wshobson-agents` adds `debug` to its roles + `recommended: true`
  remains relevant (recommend installing wshobson when only the built-in is present, if it ranks higher).
- Resolution on a bare machine → a debug built-in (no inline gap). With wshobson/an external debugger
  installed → that wins; glass box records the choice + any recommendation.

## 4. `classifyFailure` (deterministic)

Input: a string (symptom or pasted test/CI output) + optional `--ci` flag.
- `--ci` or input matches failure-signal patterns (`/\bFAIL\b/`, `✗`, `/Error:/`, `/assert/i`,
  `/exit code [1-9]/`, stack-trace `at .*:\d+`) → `mode: "ci"`.
- else → `mode: "bug"`.
- `signal` = a one-line normalized summary (first failing line / first sentence). Output `{mode, signal}`.
Pure, unit-tested.

## 5. `buildDiagnoseManifest(failure, caps)` (deterministic)

Produces a valid Crew Manifest (slice-1 schema) seeded from the failure:
- `outcome`: `Resolve: <failure.signal>`
- `successCriteria`: ["root cause identified", "fix applied", "regression test added", "suite green"]
- `plan` (ids + deps):
  - `repro` (single) — reproduce the failure
  - `root-cause` (single, deps repro) — role `debug`
  - `fix` (single, deps root-cause) — role `implement`
  - `regression` (single, deps fix) — role `test-author`
  - `verify` (single, deps regression) — role `code-review` (gate + run suite)
- `crew`: per stage, the chosen provider from `caps.roles[role].chosen` (+ source/rationale/evidence/fallback).
- `recommendations`/`degradations`: carried from caps (e.g. "install wshobson debugging agents for a
  stronger root-cause step").
Pure, unit-tested (validates via `validateManifest`).

## 6. CLI + skill

- `muster diagnose <symptom>` or `muster diagnose --ci <file>` → run `classifyFailure` (+ read file for
  `--ci`), then `buildDiagnoseManifest` against live `capabilities`, print `{mode, manifest}` (validated).
- `/muster:diagnose` command → invokes the **diagnose** skill.
- **diagnose skill**: take the failure → `muster diagnose …` to seed the manifest → run the **debug**
  provider for the root-cause step (systematic debugging: hypothesis table → cheapest test → root
  cause, recorded in STATE) → run the **orchestrator** over the fix manifest (fix + regression waves) →
  **review-gate** → verify suite green → present merge. Escalate (don't patch blindly) if root cause
  isn't found or the gate can't pass within the cap.

## 7. Glass-box / DNA fidelity
Outcome-anchored (success = root cause + fix + regression test + green suite, not just "symptom gone").
Glass box: the hypothesis table, the chosen debug provider, root cause, and each wave recorded in STATE.
No symptom-patching — the debug step must produce a root cause before the fix step runs.

## 8. Graceful degradation & error handling
- No external debugger installed → built-in `sp-debug`/`wsh-debugging-strategies`; recommend wshobson.
- Root cause not found → escalate (report hypotheses tried), do not proceed to a blind fix.
- `classifyFailure` on empty input → error (need a symptom or --ci file).
- Reuses the review-gate cap + escalation (slice 2).

## 9. Testing strategy
- `classifyFailure` (TDD): ci-looking inputs (FAIL/stack/exit code) → ci; prose → bug; --ci forces ci;
  empty → throws.
- `buildDiagnoseManifest` (TDD): produces a manifest that passes `validateManifest`; plan has the 5
  ordered stages with correct deps; crew pulled from a fixture caps; debug stage present.
- `debug` role resolution (capabilities test): bare machine → a debug built-in (not inline); with a
  fixture-installed external → that wins.
- CLI smoke: `muster diagnose "X is null"` (bug), `muster diagnose --ci <fixture>` (ci).
- diagnose skill: scenario-shape (seed → debug → orchestrate fix → gate → verify → escalate path).

## 10. Open questions
1. Should root-cause be a tournament (N hypotheses judged) reusing slice-2? Proposed: single path v1.
2. `--ci` seed source — local file/pasted output now; a CI-provider fetch later (S5 remote overlaps).
3. Ranking: when both a built-in and an installed wshobson debug agent exist, confirm the external wins.

## Change log

### 2026-06-07 — Initial slice-6 draft
- **What changed:** First design for diagnose mode: a `debug` role resolving across superpowers +
  wshobson + installed external debuggers; deterministic `classifyFailure` (ci/bug) +
  `buildDiagnoseManifest` (failure → fix manifest: repro→root-cause→fix→regression→verify); a diagnose
  skill + `muster diagnose` reusing the orchestrator + review-gate; outcome-anchored, no symptom-patching.
- **Why:** close the failure-first gap (atomic `subagent-diagnose` parity) by wiring the already-vendored
  debugging methods into a real workflow, provider-agnostic via the role ladder.
