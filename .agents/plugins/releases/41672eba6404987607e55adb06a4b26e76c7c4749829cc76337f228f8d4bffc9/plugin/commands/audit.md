---
name: audit
description: "Autopilot-style whole-codebase review-and-fix. Sweeps architecture, tech-debt, test-coverage, simplification/reuse/duplication, readability/maintainability, and security in capacity-bounded batches via the best available provider per dimension, consolidates a ranked findings ledger, then fixes everything (TDD) and verifies. Usage: $muster-audit [path or empty = whole repo]; $muster-audit backlog [path] to sweep read-only into a ranked backlog instead of fixing."
---

## Codex harness binding

Read `${PLUGIN_ROOT}/runtime/codex-skill-adapter.md` before following this command. Its Codex tool, named-profile dispatch, bounded-context-fork, input, mode-name, and plugin-root bindings override legacy harness names below; this command's domain rules and gates remain authoritative.


You are muster's whole-codebase audit orchestrator, running capacity-batched dimension sweeps and consolidating a ranked findings ledger. Produce a ranked findings ledger per finding in STATE, then present the merge-decision prompt to the user.

**Mode**: iff the first whitespace-token of `$ARGUMENTS` is exactly `backlog`, this is a **backlog run** — everything after that token is the (optional) scope path (so a directory literally named `backlog` is `backlog backlog`); a path form like `./backlog` does not match the bare token, so default mode scoped to such a directory is expressed as `./backlog`. No `backlog` token = default mode, unchanged. The scope for either mode: <scope>`$ARGUMENTS`</scope> (empty = whole repo; or a path/subsystem to scope the audit).

Drive the audit loop:

**Run-active lifecycle:** Write `.muster/run-active` at invocation start (before step 1) -- the mode/run-in-progress marker Muster's Codex lifecycle hooks use for state diagnostics. Remove it after the merge decision (step 7), after the backlog is written (backlog mode), or on escalation exit. Codex hooks never delete state markers automatically; on startup, verify and clear only a marker proven stale and owned by the interrupted workflow.

1. **Seed** — `node ${PLUGIN_ROOT}/runtime/muster.mjs audit --codex` prints the Crew Manifest JSON to stdout; capture that exact JSON and write it to `.muster/manifest.json`; validate (`node ${PLUGIN_ROOT}/runtime/muster.mjs manifest validate .muster/manifest.json --codex`).
2. **Branch** — create a work branch off the base (never run on the base branch). Skip in backlog mode: the sweep is read-only and nothing gets committed, so there's nothing to branch for.
3. **Quota-bounded dimension sweep (Codex)** — Cover all six dimensions with three nonredundant read-only briefs instead of six overlapping repository scans:
   - **system quality:** architecture, tech debt, simplification, and readability, returned as four separately labeled finding lists;
   - **coverage:** test gaps and untested failure paths;
   - **security:** injection, secrets, unsafe IO, trust boundaries, installers, and lifecycle hooks.
   Dispatch these three briefs concurrently when the configured Codex capacity permits, otherwise in dependency-free batches. Respect `agents.max_threads`; neither lower nor raise it. Every worker uses `fork_turns: "none"`, a 25-step ceiling, focused commands only, and one concise receipt. Add prompt-quality as a fourth read-only brief only when the scoped diff changes prompts or agent instructions. Consolidation is forbidden until each required dimension has a receipt.
Maintain a board task per dimension here and per fix slice in step 5 (the orchestrator skill's task-board discipline).
4. **Consolidate** — dedupe + rank all findings into a single ledger (by severity, then blast radius). Record the ledger in STATE (glass box). Identical in both modes.
5. **Fix all** — via the orchestrator + Ralph loop: remediate every finding, TDD (failing test first where behavior changes). Defer an item only with an explicit written reason in the ledger. Keep the suite green per fix.
   **Backlog mode replaces this step** — no fixing, no commits. Instead, **write the backlog** to `.muster/backlog.md` (gitignored, run-local): one item per finding-cluster from the step-4 ledger, in the ledger's severity order (highest first). Format, exactly, per item — this is `sprint.md`'s parser contract:
   - Create-or-append: if `backlog.md` already exists, read it and append below the existing content; never clobber it.
   - Exactly one line per item: `- [ ] <fix description with acceptance criteria folded inline>`, followed by `{id: ...}` and (when applicable) `{deps: ...}` annotations — no `{disposition}` annotation (sprint defaults unannotated items to `pr`). Fold the finding's suggested fix and its "done" condition into one sentence; a multi-line item is a format violation.
   - Wave grammar (id/deps): every item gets `{id: <cluster-slug>}` (a label only, never affecting ordering). Independent finding-clusters get `{deps: none}` **explicitly** — this is what makes audit backlogs wave-parallel; an item written without a `{deps}` annotation implicitly depends on everything already above it, so omitting it would serialize the whole backlog. Clusters that touch the SAME file(s) get explicit `{deps}` on each other instead, serializing just that pair/group — note the shared-file reason in the final report.
   - Every item embeds at least one digit or measurable-criteria keyword (`metric`, `target`, `reduce`, `latency`, etc. — see `src/interview.js`) alongside enough concrete detail that `node ${PLUGIN_ROOT}/runtime/muster.mjs assess --codex "<item text>"` — run with every `{key: value}` annotation stripped generically — returns `clear: true` — vague one-liners aren't acceptable items.
   - Skip exact-duplicate items: compare candidate text against every existing line's text with every `{key: value}` annotation stripped generically; an exact match is skipped, not appended. Track skips for the final report.
6. **Verify** — run the **review-gate** + the full suite; must be green. Confirm no regressions. Skip in backlog mode: nothing was changed.
7. **Escalate** if the fix-loop cap is hit on an item (record it in the ledger, continue the others). Then present the merge decision via the **AskUserQuestion** selection UI with options **Merge locally** / **Open PR** / **Keep branch** / **Discard**. Backlog mode skips this too — instead, **finish** by reporting the written backlog (items added + items skipped as duplicates) and suggesting `$muster-go-backlog` to run it.

Reuses the orchestrator + review-gate; glass box records the per-dimension providers + the findings ledger. (vs `$muster-diagnose`, which is failure-first single-bug; audit is breadth-first whole-codebase.)

<!-- prompt-lint-disable ANTH-POS-001: Codex compatibility transformation preserves the source workflow's safety directives and treats its deterministic STATE receipts as the evidence contract. -->
