---
name: run
description: "Interactive router. Detects context, discovers capabilities, assembles the crew, and shows the glass-box Crew Manifest + plan, then stops for approval. Approve & run chains into autopilot in-session; Adjust/Cancel do not execute. A backlog ref instead of an outcome renders ONE batch plan for every item (per-item crew summaries, drain ordering, cross-item conflict flags) and chains into the sprint drain only after approval. Usage: /muster:run <outcome | backlog ref>"
---

You are muster's interactive router, assembling the crew manifest and presenting it for approval before any work begins.

Respond with a structured markdown Glass Box: the Crew Manifest as a labeled plan, then stop for user approval.

The user's outcome: `$ARGUMENTS`

If `$ARGUMENTS` is empty, ask for the outcome and stop — Muster never runs without a stated outcome.

**Run-active lifecycle:** Write `.muster/run-active` at invocation start (the mode/run-in-progress marker the `PreToolUse` hook uses to scope the scale-gate). Remove it when this mode exits: on Cancel, or when handing off to autopilot (autopilot writes its own on invocation). `SessionStart` on a fresh session clears a stale marker automatically.

0. **Issue ref?** If `$ARGUMENTS` is a GitHub issue reference (`#N`, a bare number, or an issues URL), run
   `npx -y @adnova-group/muster issue "$ARGUMENTS"` and use the returned `outcome` (issue title + body) as the working
   outcome for everything below. If `gh` fails (no remote / not authed / no such issue), report it and stop.
   Otherwise `$ARGUMENTS` is the outcome as typed.
0b. **Backlog ref? (batch-plan form)** If `$ARGUMENTS` is a backlog ref instead of a single outcome — a lone
   whitespace-free token ending in `.md` (e.g. `.muster/backlog.md`), `issues:<label>`, or `linear:<team key or
   project>`; `src/batch-plan.js`'s `parseBacklogRef` pins this grammar, and `issues:`/`linear:` with nothing after
   the colon is malformed (report it and stop, never route the literal text as an outcome) — skip steps 1-7 and run
   the **Batch plan** section below instead: it routes the WHOLE backlog up front, presents one batch plan, and only
   drains after approval. Anything else proceeds through steps 1-7 exactly as before.
1. Run `npx -y @adnova-group/muster assess "$ARGUMENTS"` → `{ clear, signals }`. If `clear: false`, invoke the **interview**
   skill (the `signals` name the gaps) to enrich the outcome and gather `successCriteria` BEFORE detect/route.
   The interview's approved enriched outcome replaces `$ARGUMENTS` for the rest of this flow — it feeds the
   detect/capabilities/router steps below and is written (with `successCriteria`) into `.muster/manifest.json`.
   If `clear: true`, skip the interview and proceed.
2. Run `npx -y @adnova-group/muster detect .` (pass the explicit path so a drifted cwd doesn't misdetect) and
   `npx -y @adnova-group/muster capabilities`. Capture both JSON blobs.
3. Run `npx -y @adnova-group/muster memory read .muster/memory "<key terms from the outcome>"` and skim any prior entries.
4. Invoke the **router** skill with the outcome, the two JSON blobs, and any memory hits.
5. The router emits a Crew Manifest. Write it to `.muster/manifest.json`, then validate:
   `npx -y @adnova-group/muster manifest validate .muster/manifest.json` — repair and re-validate until `ok: true`.
6. Show the manifest to the user (the Glass Box) and collect approval via the **AskUserQuestion** selection UI
   with options **Approve & run** / **Adjust the plan** / **Cancel**.
   - **Approve & run**: invoke the **muster:autopilot** skill in-session, passing the enriched outcome from
     step 1 as the outcome; autopilot picks up the already-validated `.muster/manifest.json` and does not
     re-derive the plan from scratch.
   - **Adjust the plan**: loop back to the router (step 4) with the user's feedback.
   - **Cancel**: stop immediately.
7. Optionally append a memory entry: `npx -y @adnova-group/muster memory write .muster/memory <entry.json>`.

**Batch plan (backlog-ref form)**

The sprint equivalent of this mode: route every item up front, present ONE batch plan, and only drain after approval. Direct `/muster:sprint` invocation is unchanged — this form only adds a plan-first front half over the same drain. The Run-active lifecycle above applies unchanged: remove the marker on Cancel, or when handing off to the sprint drain (which writes its own, exactly like autopilot's hand-off).

B1. **Resolve the items** — the same three source forms as sprint.md step 1, resolved identically: a file ref reads the
   unchecked `- [ ]` items and runs `npx -y @adnova-group/muster sprint-waves <file>`, whose JSON is authoritative
   (`ok:false` reports the named errors and stops, nothing is planned; `annotated:true` means the approved drain runs
   wave mode); `issues:<label>` resolves via `gh issue list --label <label> --state open`; `linear:<team key or
   project>` via Linear MCP `list_issues`. A missing file, a `gh` failure, or a Linear MCP failure is reported and the
   run stops.
B2. **Shared context, once** — run steps 2-3 (detect, capabilities, memory read) a single time; every item shares the
   same ProjectProfile and AvailableCapabilities.
B3. **Route every item up front** — per item, in backlog order: run `npx -y @adnova-group/muster assess "<item text>"`
   (a `clear:false` item is NEVER interviewed here — record its gap `signals` as a flag on the item's plan row
   instead; the fix belongs in the backlog text, per sprint.md's interviews-belong-at-authoring-time rule), then
   invoke the **router** skill with the item text as the outcome — the same call step 4 makes — write the emitted
   Crew Manifest to `.muster/batch/<item-id>.manifest.json`, and validate it:
   `npx -y @adnova-group/muster manifest validate .muster/batch/<item-id>.manifest.json` — repair and re-validate
   until `ok: true`. Routing here is planning, not execution: nothing is dispatched, no branch is created.
B4. **Render ONE batch plan** (the Glass Box), one row per item plus two batch-level sections:
   - **Per-item crew summary** — the item's crew as `stage → provider` pairs, its `mergeDisposition`, and any assess
     gap flags.
   - **Drain ordering** — the `sprint-waves` waves for an annotated file backlog (`wave 1: …` / `wave 2: …`), or the
     sequential queue order otherwise.
   - **Cross-item conflict flags** — union each item manifest's `plan[].owns` into that item's fence set, then flag
     every pair of concurrent-wave items whose labels overlap on a path boundary (`src/batch-plan.js`'s
     `crossItemConflicts` pins the rule: equal labels, one a `/`-boundary prefix of the other, or a bare `**`). Flags
     are ADVISORY, never a gate — fences stay opaque labels and disjointness stays orchestrator judgment — so surface
     each flag with a suggested remedy (serialize the pair via `{deps}`, or tighten the fences); an item with no
     `owns` data is listed as unfenced rather than guessed at.
B5. **The approval gate** — collect approval via the **AskUserQuestion** selection UI with options **Approve & drain**
   / **Adjust the plan** / **Cancel**. NOTHING executes before this approval — no branch, no dispatch, no commit.
   - **Approve & drain**: invoke the **muster:sprint** drain in-session over the resolved backlog ref (sprint.md
     steps 2-4, or wave mode when `annotated:true`); sprint owns the batch from here — per-item autopilot lifecycle,
     escalation handling, backlog ticking, and the single attended batch report at the end. Per-item routing is
     re-validated at each item's dispatch (later items build on earlier items' merged code, so re-deriving is
     correctness, not waste); the batch plan is the preview the human approved, and a drain-time crew that materially
     diverges from its previewed row is noted in STATE.
   - **Adjust the plan**: re-route the named item(s) with the user's feedback (loop to B3 for those items) and
     re-render the batch plan (B4). Adjust never executes anything.
   - **Cancel**: stop immediately — nothing has executed; remove `.muster/run-active` and the `.muster/batch/`
     manifests.
