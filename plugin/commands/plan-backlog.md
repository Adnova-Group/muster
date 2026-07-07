---
name: plan-backlog
description: "Declared-scope batch planner (the compound -backlog form) — the approve-first counterpart to /muster:go-backlog. Routes every item in a backlog up front and renders ONE batch plan (per-item crew summaries, run order, cross-item conflict flags), stopping for approval before anything runs. Given a raw intent instead of an existing backlog ref, first decomposes it into backlog items via the interview skill's decomposition machinery, gates the write with a capture-style human approval, then renders the batch plan. Approve & clear chains into /muster:go-backlog in-session. (vs /muster:plan, whose bare-verb form only reaches here after a scope confirm.) Usage: /muster:plan-backlog <backlog ref | raw intent>"
---

You are muster's declared-scope batch planner: you route every item in a backlog up front, present ONE batch plan, and stop for approval before anything runs.

Respond with a structured markdown Glass Box: when bootstrapping from a raw intent, the candidate backlog list and its own approval first; then in every case, the batch plan (per-item crew summaries, run order, cross-item conflict flags), and stop for user approval.

<backlog-or-intent>$ARGUMENTS</backlog-or-intent>

0.5. **Announce the artifact** — before any other work, state in one line: "Planning a BACKLOG -> per-item manifests + batch plan for approval." (When B1 below resolves `$ARGUMENTS` as a raw intent rather than an existing backlog ref, the Bootstrap section runs first — that generation phase is additional work in service of the same announced artifact, not a different one.)

**Run-active lifecycle:** Write `.muster/run-active` at invocation start (before B1) — the whole plan-backlog invocation counts as ONE run for the `PreToolUse` hook's scale-gate scoping, covering the bootstrap phase (if any) and the batch-plan render. Remove it on Cancel (B5/BS4 below), or when handing off to `/muster:go-backlog` (go-backlog writes its own marker, exactly like go's own hand-off from `/muster:plan`). `SessionStart` on a fresh session clears a stale marker automatically.

B1. **Resolve the source** — `$ARGUMENTS` is one of:
   - a parseable backlog ref (`src/batch-plan.js`'s `parseBacklogRef`: `file` — a lone whitespace-free token ending in `.md`, e.g. `.muster/backlog.md`; `issues:<label>`; or `linear:<team key or project>`) — resolve it via the same three source forms go-backlog.md step 1 uses: a file ref reads the unchecked `- [ ]` items and runs `npx -y @adnova-group/muster sprint-waves <file>`, whose JSON is authoritative (`ok:false` reports the named errors and stops, nothing is planned; `annotated:true` means the approved batch runs wave mode); `issues:<label>` resolves via `gh issue list --label <label> --state open`; `linear:<team key or project>` via Linear MCP `list_issues`. A missing file, a `gh` failure, a Linear MCP failure, or `kind: invalid` (e.g. `issues:` with nothing after the colon) is reported and the run stops — always an explicit failure rather than a silent fallback to raw-intent handling.
   - empty, with `.muster/backlog.md` present and carrying at least one unchecked item — defaults to that file, resolved the same way.
   - empty, with no live default backlog, and no intent given — ask the user for a backlog ref or a raw intent to decompose, and stop. Plan-backlog always requires a backlog ref or an intent to decompose before it runs.
   - anything else non-empty (`parseBacklogRef` returns `kind: "outcome"` — plain prose, no `.md`/`issues:`/`linear:` shape) — a **raw intent**. Run **Bootstrap** below to generate `.muster/backlog.md` first, then resolve it via the file form above.

   Routing here is planning, not execution: nothing is dispatched, no branch is created.
B2. **Shared context, once** — run `npx -y @adnova-group/muster detect .` and `npx -y @adnova-group/muster capabilities` (capture both JSON blobs), plus `npx -y @adnova-group/muster memory read .muster/memory "<key terms from the backlog>"` and skim any hits — a single time; every item shares the same ProjectProfile and AvailableCapabilities.
B3. **Route every item up front** — per item, in backlog order: run `npx -y @adnova-group/muster assess "<item text>"`
   (a `clear:false` item is NEVER interviewed here — record its gap `signals` as a flag on the item's plan row
   instead; the fix belongs in the backlog text, per go-backlog.md step 3's interviews-belong-at-authoring-time rule), then
   invoke the **router** skill with the item text as the outcome (the same call plan.md's single-outcome path
   makes) — write the emitted Crew Manifest to `.muster/batch/<item-id>.manifest.json`, and validate it:
   `npx -y @adnova-group/muster manifest validate .muster/batch/<item-id>.manifest.json` — repair and re-validate
   until `ok: true`.
B4. **Render ONE batch plan** (the Glass Box), one row per item plus two batch-level sections:
   - **Per-item crew summary** — the item's crew as `stage → provider` pairs, its `mergeDisposition`, and any assess
     gap flags.
   - **Run order** — the `sprint-waves` waves for an annotated file backlog (`wave 1: …` / `wave 2: …`), or the
     sequential queue order otherwise.
   - **Cross-item conflict flags** — union each item manifest's `plan[].owns` into that item's fence set, then flag
     every pair of concurrent-wave items whose labels overlap on a path boundary (`src/batch-plan.js`'s
     `crossItemConflicts` pins the rule: equal labels, one a `/`-boundary prefix of the other, or a bare `**`). Flags
     are ADVISORY, never a gate — fences stay opaque labels and disjointness stays orchestrator judgment — so surface
     each flag with a suggested remedy (serialize the pair via `{deps}`, or tighten the fences); an item with no
     `owns` data is listed as unfenced rather than guessed at.
B5. **The approval gate** — collect approval via the **AskUserQuestion** selection UI with options **Approve & clear**
   / **Adjust the plan** / **Cancel**. NOTHING executes before this approval — no branch, no dispatch, no commit.
   - **Approve & clear**: invoke the **muster:go-backlog** skill in-session over the resolved backlog ref (wave mode
     applies when `annotated:true`); go-backlog owns the batch from here — per-item hands-off lifecycle,
     escalation handling, backlog ticking, and the single attended batch report at the end. Per-item routing is
     re-validated at each item's dispatch (later items build on earlier items' merged code, so re-deriving is
     correctness, not waste); the batch plan is the preview the human approved, and a run-time crew that materially
     diverges from its previewed row is noted in STATE.
   - **Adjust the plan**: re-route the named item(s) with the user's feedback (loop to B3 for those items) and
     re-render the batch plan (B4). Adjust never executes anything.
   - **Cancel**: stop immediately — nothing has executed; remove `.muster/run-active` and the `.muster/batch/`
     manifests.

**Bootstrap (raw-intent form)**

Reached when B1 determines `$ARGUMENTS` is a raw intent rather than a resolvable backlog ref. This reuses the interview skill's Decomposition check machinery **by reference** (same item format, wave grammar, measurability, and dedupe rules `plugin/skills/interview/SKILL.md` defines for backlog writes) and `plugin/commands/capture.md`'s write-gate shape (same **AskUserQuestion** options, same append-only write) — read both first if unfamiliar, and reuse them exactly rather than re-deriving a divergent format here.

BS1. **Decompose** — split the raw intent into candidate items: each a one-line outcome with its measurable folded
   in. An intent that reads as a single indivisible unit of work still bootstraps to a ONE-item backlog rather than
   falling back to `/muster:plan`'s single-outcome path — scope was already declared at the call site (this command's
   name, or plan.md's confirmed backlog choice), so it stays settled here: this step always honors that declared
   scope rather than re-litigating it.
BS2. **Validate** — for every candidate: item format, wave grammar, and dedupe follow `plugin/skills/interview/SKILL.md`'s
   Decomposition check; the assess-cap and UNMEASURABLE handling below follow `plugin/commands/capture.md`'s Validate step:
   - **assess-passable** — `npx -y @adnova-group/muster assess "<item text>"` (every `{key: value}` annotation
     stripped generically first) returns `clear: true`; fold in criteria until it does, capped at 2 reword attempts.
     Past 2 attempts, offer it in BS4 marked **UNMEASURABLE** with its assess signals attached, for the human to fix
     or drop, always carrying forward the item's real assess signals rather than fabricating a metric to force
     `clear: true`.
   - **`{id: <short-kebab-slug>}`** on every item — a label only, with no effect on ordering.
   - **explicit `{deps: none}`** for a genuinely independent item, or **`{deps: <predecessor ids>}`** for one that
     builds on another item extracted in this same batch — always stated explicitly: an item written without a
     `{deps}` annotation implicitly depends on everything already above it in the file.
   - **no `{disposition}`** annotation unless the raw intent explicitly named one for that item.
BS3. **Dedupe** — read `.muster/backlog.md` if it exists; skip any candidate whose text (every `{key: value}`
   annotation stripped generically) already matches an existing line's text, checked or unchecked
   (`plugin/commands/capture.md` step 3's rule, applied identically here). Track skips for the report.
BS4. **The capture-style human gate** — before writing anything, show the candidate list via the **AskUserQuestion**
   selection UI: **Approve all** / **Edit** (revise or drop specific items; an edited item re-enters BS2 — assess-passable
   + dedupe — before it is re-offered) / **Drop <named items>** / **Cancel** — Cancel exits the entire plan-backlog
   run, nothing is written and nothing is planned. Nothing is written until the user approves — this is the human
   gate on what enters the queue.
BS5. **Write** — create `.muster/backlog.md` if absent, else append below the existing content, always preserving
   every existing line exactly as written (no removes, reorders, or rewrites). One line per approved item: `- [ ] <item text>` followed by its
   `{id}`/`{deps}`/(optional) `{disposition}` annotations — exactly the format `/muster:go-backlog` (and
   `/muster:sprint`) parse. Record the written items and the skips in STATE.

   Once BS5 lands, `.muster/backlog.md` exists and is non-empty — continue at B1's file-ref form over that path,
   into B2 and onward above.

Glass box: the bootstrap decompose/validate/dedupe trail (when it ran) and its written/skipped items, plus the batch plan itself — each item's crew, the run order, conflict flags, and the approval outcome — are all recorded in STATE as this mode runs.
