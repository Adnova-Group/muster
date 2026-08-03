# Codex Plan launcher: PR 185 supersession proof

Status: accepted

## Decision

PR 185 ("feat(codex): add native Plan launcher") is confirmed superseded-landed, not
reopened or merged. Its promised behavior lives on `main` as `src/codex-plan-launch.js` +
`test/codex-plan-launch.test.js`, reached through commits `aa91347..691e1ed` (the same
lineage the closed PR's own branch head, `df23d155`, was cut from). `df23d155` is not an
ancestor of `HEAD` — it is a dangling object reachable only because this worktree happened to
fetch it, not because it merged — so the comparison below is a content diff against that
fetched object, not an ancestry claim: `git diff df23d155 HEAD -- src/codex-plan-launch.js
test/codex-plan-launch.test.js` shows +620/-39 lines, all hardening (input-form ownership,
JSON-RPC frame limits, approval decline paths, secret-input cleanup) added after the PR was
authored, nothing removed. This matches
[open-pr-branch-reconciliation.md](open-pr-branch-reconciliation.md)'s row for PR 185 and
extends it with the specific behavior-level proof this item required.

## The four required behaviors, each proven by an existing test on `main`

| # | Required behavior | Proof (existing test, no new code needed) | Status |
|---|---|---|---|
| 1 | Native Plan activation | `test/codex-plan-launch.test.js`: *"native launch reports Plan only after the schema-shaped effective-mode confirmation"* — drives `launchCodexPlan()` through a fake App Server client and asserts `{ status: "started", native: true, effectiveMode: "plan", threadId, turnId }`. Complemented by *"native activation derives the schema-required mode from the discovered Plan preset and thread model"*, which proves `buildPlanCollaborationMode()` selects the `mode: "plan"` preset (not `default`) from `collaborationMode/list`. | **Proven** |
| 2 | Effective-mode observation | `test/codex-plan-launch.test.js`: *"effective-mode detection requires the app-server's thread settings receipt"* — `detectEffectivePlanMode()` returns `{ effectiveMode: "plan", active: true }` only on a genuine `thread/settings/updated` notification carrying `collaborationMode.mode === "plan"`, and `{ effectiveMode: "unknown", active: false }` for any other notification (e.g. `turn/started`). Complemented by *"native launch requires exact nonempty thread and turn receipt correlation"*, which proves `launchCodexPlan()` only accepts a settings notification that matches the exact `threadId` it started (wrong-thread and mode-absent notifications are rejected by the predicate before the plan-active one is). | **Proven** |
| 3 | Approval preservation | `test/codex-plan-launch.test.js`: *"turn/start invokes muster-plan without overriding any approval control"* — asserts `buildPlanTurnStart()`'s params omit `approvalPolicy`, `approvalsReviewer`, `permissions`, and `sandboxPolicy` entirely, so App Server inherits the user's existing controls rather than the launcher silently weakening them. Complemented by *"JSON-RPC transport declines approvals and rejects unknown requests"* (`item/commandExecution/requestApproval` and an unknown method) and, added in this fix loop, *"JSON-RPC transport declines or denies all four approval-request method names, never auto-approving any of them"*, which exercises all four RPC method names named in `src/codex-plan-launch.js:433-438` — `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` (`decision: "decline"`), plus the legacy `execCommandApproval` and `applyPatchApproval` (`decision: "denied"`) — and asserts each one over the wire, so the "all four methods are actively declined/denied, never auto-approved" claim is now backed by direct coverage rather than inference from two of the four. | **Proven** |
| 4 | Explicit manual guidance when App Server control is unavailable | `test/codex-plan-launch.test.js`: *"unavailable App Server control fails safely with explicit /plan guidance"* — a throwing `clientFactory` (spawn failure) produces `{ status: "fallback", native: false, effectiveMode: "unknown", guidance: .../\/plan \$muster-plan.../ }`. Complemented at the CLI boundary by *"non-interactive CLI falls back before starting a hidden approval-less session"*, which spawns `src/cli.js codex-plan` with no TTY and asserts exit code 2, `"status": "fallback"` on stdout, and the literal guidance string `/plan $muster-plan Design the import flow`. | **Proven** |

Three of the four rows were satisfied by tests already on the tree with no code change. Row 3
needed one additive test (below) to make its "all four approval methods" claim true instead of
inferred; no source change was needed, since the decline/deny behavior for all four methods
already existed in `src/codex-plan-launch.js`. Full local run: `node --test
test/codex-plan-launch.test.js test/plan-surface.test.js test/native-plan-mode-parity.test.js`
— 42/42 passing (22 + 9 + 11; see the dispatch receipt for this item for the verbatim tail).

## Scope note: `src/plan-surface.js` is a distinct, already-covered surface

The brief also pointed at `plan-surface <runtime>` and "App Server". That CLI verb and
`src/plan-surface.js` implement a *different* backlog item (`native-plan-mode-parity`): a
pure per-harness capability-selection table (`resolvePlanSurface(runtime)` picks between
Codex's native surface, Hermes's, Claude Code's `ExitPlanMode`, Kimi's plan-mode gate, or the
universal prose fallback) used to keep `plugin/commands/plan.md` honest about which harness
gets which gate. It does not launch or observe an actual App Server session and is not part of
PR 185's promised surface — `test/native-plan-mode-parity.test.js` already covers it
independently and is unaffected by this item.

## Gaps

None. Unlike PR 145 and PR 166 (flagged as genuine gaps in
[open-pr-branch-reconciliation.md](open-pr-branch-reconciliation.md)), PR 185's promised
functionality is fully present and over-delivered on `main`, and every one of the four
required behaviors named in this item's brief has direct, existing, deterministic test
coverage (fixture/contract level — no live Codex or App Server process is spawned by any of
these tests; `createCodexAppServerClient`'s tests substitute a fake child process).

## Verification

`node --test test/codex-plan-launch.test.js test/plan-surface.test.js
test/native-plan-mode-parity.test.js` — 42 pass, 0 fail (22 + 9 + 11), run against this
worktree's `HEAD`.
