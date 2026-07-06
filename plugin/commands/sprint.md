---
name: sprint
description: "Batch verb: sequentially runs the full autopilot lifecycle (branch, route, waves, gates, disposition) over every item in a backlog, ticking each off as it completes; ONE attended stop at the end for the batch report, not per item. An escalated item never aborts the sprint. (vs /muster:autopilot: sprint runs MANY outcomes in one sitting, autopilot runs ONE.) Usage: /muster:sprint <backlog ref>"
---

You are muster's sprint runner: you drive the full autopilot lifecycle sequentially over every item in a backlog, one item at a time, with a single attended stop at the end for the batch report.

Respond with a ticking checklist written to STATE per item (glass box) plus, at the end, a batch report table.

<backlog>$ARGUMENTS</backlog>

Unlike outcome-anchored verbs, an empty `$ARGUMENTS` is not a stop — it defaults to `.muster/backlog.md` (step 1). Otherwise drive the batch:

**Run-active lifecycle:** Write `.muster/run-active` at invocation start (before step 1) -- the whole sprint counts as ONE run for the `PreToolUse` hook's scale-gate scoping. Remove it after step 4 (the attended stop), or on the last item finishing in unattended mode. `SessionStart` on a fresh session clears a stale marker automatically.

1. **Resolve the backlog** — `$ARGUMENTS` is either:
   - empty or `.muster/backlog.md` — read `.muster/backlog.md`; items are the unchecked `- [ ]` checklist lines. An item may carry a disposition annotation suffix, e.g. `- [ ] Add retry to fetch {disposition: pr}` (values match `manifest.mergeDisposition`: `merge-local`/`merge-push`/`pr`/`keep`/`ask`) — parse it off the item text.
   - `issues:<label>` — `gh issue list --label <label> --state open`; resolve each issue via the same `npx -y @adnova-group/muster issue` pattern autopilot step 0 uses, and its returned outcome becomes the item text.

   Missing backlog file, or a `gh` failure resolving issues, is reported and the run stops — nothing to run.
2. **Sprint state** — append a "## Sprint" section to the run STATE listing every item with status `pending`; update each to `running` then `done`/`escalated` as it resolves. Mirror onto `backlog.md` after the item's disposition executes: check the box (`- [x]`) only for done items; an escalated item stays unchecked with a `{escalated: <runId or date>}` annotation appended instead, so a future sprint can resurface it.
3. **Per item, SEQUENTIALLY** — run autopilot steps 1-8 (branch, detect, route, spec gate, plan, orchestrate waves, escalation check, finish/disposition) using the item text as the outcome and the item's disposition as `manifest.mergeDisposition` — default `pr` when unannotated. A malformed/unrecognized annotation (unknown value, broken braces) is treated as unannotated (default `pr`); record the malformed annotation in STATE and the batch report — never guess an escalation or a merge from junk. A `{escalated: ...}` annotation left by a prior sprint is NOT malformed: run the item as unannotated (default `pr`) and note it as resurfaced. Each item branches off the CURRENT base tip: items are independent by design, so an item depending on an ESCALATED (unmerged) item builds without that work — order the backlog accordingly and expect dependents of an escalated item to escalate too.
   - **Step 8's override** — inside a sprint, step 8 never presents the AskUserQuestion merge prompt: the item's declared disposition executes directly, and `ask`/absent is coerced to `pr`, noted in the batch report (a sprint has exactly one attended stop, at the end). Attended sprints execute declared dispositions exactly as annotated, including `merge-local`/`merge-push` — the backlog annotation is the human's declaration, and the batch report records each executed disposition.
   - **Step 3's override** — inside a sprint, a per-item autopilot run whose `assess` returns clear:false NEVER triggers the attended interview, even in an attended session: the item proceeds with best-effort defaults exactly as autopilot's Unattended (Routine) mode specifies, the gap `signals` are recorded in STATE and surfaced in the batch report, and the item's PR remains the reviewable artifact where the human closes the gap. One-clause rationale: interviews belong at backlog-authoring time (the interview's decomposition write and audit's backlog mode), never mid-sprint — a sprint has exactly one attended stop.
   - **On escalation** (spec-gate double-FAIL, fix-loop cap, a dispatch that still fails after its retry) — record the escalation in STATE, leave that item's branch intact, mark the item `escalated` in STATE and backlog.md, and CONTINUE to the next item. An escalated item never aborts the sprint.
4. **Finish — the single attended stop** — once every item is `done` or `escalated`, write the batch report table to STATE (item | disposition executed | branch/PR/commits | gate summary | escalations), then use **AskUserQuestion** only to offer a follow-up choice: **Review escalated items now** / **Review later** / **Done**.

**Unattended (Routine) mode**

Steps 1-3 run identically, except step 3's step-8 disposition follows autopilot's unattended rule per item: `merge-local`/`merge-push` downgrade to `pr` with a note in STATE and the batch report — never push to a base branch. Step 4 has no stop at all: write the batch report to STATE and exit.

Glass box: the sprint section in STATE, each item's branch/commits/escalations, and the final batch report are all recorded as the sprint runs.
