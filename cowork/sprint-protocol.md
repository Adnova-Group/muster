# Sprint protocol (Cowork-adapted)

You are the Cowork session driving this sprint: a condensed, Cowork-native port of
`/muster:go-backlog`'s lifecycle (`plugin/commands/go-backlog.md`) — driving every item through the
full go lifecycle, one attended stop at the end, served through `muster_sprint_protocol` so a Cowork
session can follow it without the plugin loaded. Plain backlogs use the sequential queue; annotated
backlogs consume the deterministic build/barrier/integration schedule. Same intent, same guarantees
where they port; the gaps below are named, not papered over.

`/muster:sprint` still works as the legacy alias of `/muster:go-backlog`, deprecated as of
2026-07-17 and retiring in muster 0.7.0 (same schedule as the plugin-side aliases), behavior
unchanged until then.

## What this session lacks — be honest about it

- **No hooks.** No `SessionStart`, `UserPromptSubmit`, or `PreToolUse`. Concretely: no automatic
  `.muster/run-active` marker, no **action-class fence** (the one hook-level hard deny Claude Code's
  `PreToolUse` still enforces, on a matched send/sign/submit/publish/purchase/delete-remote call), no
  warn-only **border invitation** (the value-toned nudge that sells a crew run instead of commanding
  one), and no `TaskCompleted` gate tying a native task-board completion tick to a recorded
  review-gate PASS. Wave-guard, the post-run scale-gate, and the transcript-scanned todo-gate are not
  things this session merely lacks — they are DELETED outright, on every harness including Claude
  Code, not just absent here (field evidence made each unscopable; see `docs/architecture.md`'s
  "Enforcement model: gates vs conventions"). None of that exists here — this session's own
  discipline is the only enforcement there is.
- **No slash verbs.** There is no `/muster:go-backlog` grammar; drive this protocol in prose against
  the `muster_*` MCP tools plus your own subagent dispatch.
- **No auto-loaded coordination skill.** `plugin/skills/coordination/SKILL.md` isn't loaded for you.
  If more than one runner might touch this backlog at once, apply its mechanism yourself (Claim/receipt
  discipline, below) — orchestrator-level only, exactly as the skill specifies.
- **No native isolated parallel item-runners.** Wave mode's per-item isolation on Claude Code is a
  `muster-runner` subagent per item, dispatched with `isolation: "worktree"` into its own
  `.worktrees/<branch>`; the orchestrator propagates regular run/fence markers into that cwd because
  `agent_id` does not bypass the action-class fence. That has no Cowork equivalent — there is no hook
  to exempt from in the first place, and no per-dispatch worktree parameter on this MCP surface
  either. Cowork's own subagent fan-out is confirmed to work in general (see this server's core-loop
  instructions above), and it still applies **inside** a single item's own crew/waves. But running
  MULTIPLE backlog items concurrently, each in its own worktree, has no validated isolation model here.
  Therefore Cowork selects the emitted `sequential-isolated` degradation: create a real worktree for
  every annotated-wave item, execute the emitted build/review batches one leg at a time, wait at the
  same barrier, and only then integrate the emitted merge ids in the main tree. This is the
  `sequential-isolated` form of the "Degradation" path in `go-backlog.md`. Say this plainly in STATE so
  nobody assumes parallel item throughput or main-tree build work.
- **No `gh`-issue binding here.** This document covers the FILE backlog source only
  (`.muster/backlog.md`). `issues:<label>` is out of scope.

## 1. Resolve the backlog

Read `.muster/backlog.md` yourself (Cowork's own file tools — this is outside the MCP server's remit).
For every later claim, heartbeat, tick, completion, failure, or escalation mutation, call
`muster_backlog_publish` with the explicit project `dir`, relative `path: ".muster/backlog.md"`,
the complete staged `content`, and `expectedSha256` from the bytes you read. On a
changed-before-publication failure, reread and reapply the still-valid mutation; never edit or rename
the backlog directly. This bounded MCP publisher coordinates with CLI `hygiene --reap`.
Empty argument defaults to that path. Items are the unchecked `- [ ]` checklist lines; an item may carry
a trailing annotation, e.g. `- [ ] Add retry to fetch {disposition: pr}` (`{id}`, `{deps}`,
`{disposition: merge-local|merge-push|pr|keep|ask}`, `{escalated: ...}`).

Call **`muster_sprint_waves`** with the raw backlog text. Its JSON is authoritative:
- `ok:false` — report the named `errors`, stop. Nothing runs.
- `ok:true`, `annotated:false` — no `{id}`/`{deps}` grammar in use; proceed as a flat, in-file-order
  queue (steps 2-4, sequential regardless).
- `ok:true`, `annotated:true` — **wave mode**: consume `schedule.waves`, not a prose reconstruction
  from `waves` or item dispositions. Each wave's `buildReview.batches` is the authoritative,
  `MUSTER_SPRINT_PARALLEL`-capped build grouping; its barrier is `all-build-review-complete`; and its
  `integration.itemIds` is the complete backlog-ordered list allowed to execute a disposition after
  the barrier; only merge dispositions may integrate into the main tree.
  Cowork cannot safely fan out those worktrees in parallel, so traverse each emitted batch and its ids
  sequentially while preserving the emitted per-item isolation. Never recompute or widen the cap.

Missing backlog file, or a malformed annotation the tool reports as an error, stops the run — nothing to
run, report it plainly.

Persist that successful result as `plan`. During execution, call **`muster_sprint_reconcile`** with
`plan`, every receipt currently available (`id`, `itemId`, `phase`, `status`, optional `attempt`, parent-verified `candidateSha` for every status, and parent-authenticated `evidence`; review also carries the exact `implementationAttempt`, and completed integration carries the exact-head `approvalDigest`), and
the adapter-observed `inFlight` phase list (`itemId`, `phase`, positive `attempt`; review/integration also carry `candidateSha`, review carries `implementationAttempt`, and integration carries `approvalDigest`). For a new mailbox result, send the unsigned receipt with its `worktreePath`; the trusted reconcile adapter verifies actual HEAD, signs it without exposing `MUSTER_LIFECYCLE_RECEIPT_SECRET`, and returns the canonical envelope to persist. Destructive dispositions also provide `integrationTargets`; after the emitted approval action and human consent, submit its tuple plus approver as `approvalRequests`. The adapter supplies its own `MUSTER_RUN_ID`, timestamp, nonce, digest, and HMAC evidence without exposing `MUSTER_INTEGRATION_APPROVAL_SECRET`, returning the approval in `approvals` for persistence. The same current work/base/operation tuple must match at dispatch, in-flight, and completion; authenticated completed history remains valid after the live approval window. Drive a strict **reconcile → dispatch → wait** loop:
drain all completions after every wake, reconcile once, execute every returned action, update
`inFlight`, then reconcile again before waiting. `next:dispatch` forbids an idle wait;
`next:terminal|blocked|invalid` ends the loop; only `wait.eligible:true` permits waiting. Duplicate or
out-of-order receipts are retained idempotently, while failed/cancelled/missing receipts never unlock
dependencies. This MCP result owns the state transition; Cowork still owns the actual subagent calls.

## 2. Sprint state (native board when present; STATE as ledger, done by hand)

The current model makes the native task board (`TaskCreate`/`TaskUpdate`/`TaskList` on Claude Code)
the AUTHORITATIVE live-status surface for a batch, and demotes `.muster/STATE.md` to a durable
LEDGER: one line per item recording its disposition/branch/escalation once it RESOLVES, never a live
pending/running/done tick duplicating what the board already tracks (`plugin/skills/orchestrator/
SKILL.md`'s "Task board" section). This MCP surface exposes no task-tracking primitive analogous to
`TaskCreate`/`TaskUpdate`/`TaskList` — nothing scaffolds a board here, and no hook scaffolds
`.muster/STATE.md` for you either — so this session falls to the documented no-board fallback
instead: keep the pending/running/done tick in STATE.md itself, note the fallback once, and never
claim a board this session doesn't have. Concretely, write it yourself: append a `## Sprint` section
listing every item `pending`, flip each to `running` then `done`/`escalated` as it resolves — that
per-item tick lives ONLY in STATE here, because there is no board for it to duplicate. Mirror the
disposition onto `backlog.md` once it executes: check the box (`- [x]`) only for `done` items; an
`escalated` item stays unchecked with a `{escalated: <ts>}` annotation appended instead, so a later
sprint can resurface it.

## 3. Execute the selected queue or schedule

The per-item build/review lifecycle is the same as a single go pass, ported through this server's core
loop (`muster_detect`/`muster_capabilities`, `muster_route`/`muster_domain`, `muster_assess` as the spec
gate, a crew manifest validated with `muster_manifest_validate`, and that item's own `muster_wave`
crew waves). An item's OWN crew may still fan out in parallel.

- **Flat path (`annotated:false`).** The orchestrator creates a dedicated isolated Git worktree for
  each write-capable item and processes the in-file-order queue sequentially in those assigned
  worktrees, including finish/disposition after each item. The main tree remains the coordination
  and ordered-integration surface. This preserves the pre-existing flat-backlog order.
- **Wave path (`annotated:true`).** For each object in `schedule.waves`, in emitted order:
  1. Record the wave base SHA. For every id in each emitted `buildReview.batches` array, first inspect
     its emitted `items[id].deps`; when any predecessor was escalated or its build/review failed,
     escalate the dependent immediately and never create its worktree or build it. Otherwise create a
     dedicated `.worktrees/<validated-item-id>` worktree from that same wave base and run the runner's
     `build-review-only` lifecycle there. The declared disposition is metadata for the later phase;
     this leg must not push, open a PR, merge, or integrate. Cowork's unavailable parallel fan-out changes only dispatch mode:
     execute these legs sequentially in their isolated worktrees (`sequential-isolated`). It does not
     move them into the main tree, change batch membership, or let disposition select who builds.
     Each successful leg stops at an implementation + review receipt naming its reviewed commit and
     branch. No disposition executes yet.
  2. Enforce the emitted `all-build-review-complete` barrier. Do not begin integration until every
     non-escalated build/review leg in this wave has a receipt and every escalation is recorded.
  3. Only after `all-build-review-complete`, traverse `schedule.waves[].integration.itemIds`
     sequentially, preserving emitted order while omitting every escalated item or failed build/review
     leg from disposition and integration. Each remaining id must have a reviewed branch receipt from step 1;
     apply its declared disposition now: `pr` pushes the item branch and opens its receipts-backed PR,
     `keep` preserves the local reviewed branch without a remote change, `merge-local` merges into the
     main-tree base without pushing, and `merge-push` merges then pushes the base. No other item may
     touch the base during integration.
     The next dependency wave starts only from this post-integration base. For dependencies on
     unmerged `pr`/`keep` predecessors, preserve `go-backlog.md`'s stacked-fork visibility rules rather
     than silently building without predecessor code.

In either path, use the item text as the outcome and its parsed disposition as `mergeDisposition`
(default `pr` when unannotated).

- A malformed/unrecognized annotation is treated as unannotated (default `pr`) — record the malformed
  annotation in STATE and the batch report; never guess an escalation or a merge from junk. The same
  posture covers the item text itself: an item whose requirements can't be understood at all escalates
  immediately rather than running on a guess — if you're unsure what it's asking, say so in STATE and
  mark it escalated, the same path as any other escalation (below). A prior sprint's `{escalated: ...}`
  is NOT malformed: run as unannotated (default `pr`), note it as resurfaced.
- **No mid-sprint interviews.** A per-item `muster_assess` returning `clear:false` resolves with
  best-effort defaults instead of an attended interview, even in an attended session — record the gap
  `signals` in STATE and the batch report, and let the item's PR be where the human closes the gap.
- **On escalation** (a spec-gate hard abort — a repeated/unresolved round-1 finding recurring in round 2,
  or any round-3 FAIL regardless of disjointness — fix-loop cap, a dispatch that still fails after its
  retry) — record it in STATE, leave that item's branch intact, mark it `escalated` in STATE and
  backlog.md, and continue to the next item. The sprint always continues through an escalated item. A
  dependent of an escalated or failed predecessor escalates immediately and never builds; apply that
  check transitively before any worktree creation or dispatch.
- **Step 8's override, here too** — inside this sprint no AskUserQuestion merge prompt fires per item;
  the declared disposition executes directly, `ask`/absent coerces to `pr`, noted in the batch report.
  In annotated mode, this never overrides the schedule barrier: merge dispositions execute only during
  the emitted integration phase.
- **Backlog drain** — on the flat path, re-resolve after each item's disposition lands. On the wave
  path, re-resolve only after the current wave's build/review barrier and ordered integration complete;
  never mutate the active schedule mid-barrier. New unchecked items not in the original snapshot are
  admitted into the remainder; annotated backlogs use the newly emitted `schedule.waves` for the
  remainder, while flat backlogs append them to the sequential queue. Escalated/claimed items stay
  excluded from re-admission this sprint — concretely, admitted items are exactly those whose
  `items[id].claimed` is `null` in the re-resolve's JSON output; the tool's JSON is the authority,
  always deferred to rather than re-parsing the raw `{claimed: ...}` annotation text yourself. An item
  removed mid-sprint: drop it if not started (note in STATE), finish normally if already running.

## 4. Finish — the single attended stop

Once every item is `done` or `escalated`, write the batch report table to STATE (item | disposition
executed | branch/PR/commits | gate summary | escalations), then offer one follow-up choice: **review
escalated items now / review later / done.**

## Claim/receipt discipline — orchestrator level, when it matters

If more than one runner (parallel sessions, human + agent) might touch this backlog, apply the
coordination mechanism (Binding B, `plugin/skills/coordination/SKILL.md`) yourself, at the orchestrator
level only — this outer Cowork session is the only coordination runner of record; annotated-wave
worktree legs never claim items or write the main coordination ledger:
- **CLAIM** — append `{claimed: <runner>@<ts>}` to an item's line before starting it; skip items already
  claimed by a different runner; claim-then-verify by re-reading the file.
- **RECEIPTS** — one line per state change in STATE's `## Coordination` section: `CLAIMED` / `DONE` /
  `BLOCKED <reason>` / `HUMAN-HOLD <reason, question, authorizer>` / `FAILED <reason>`.
- **BLOCKED -> RESUME** — scan for an `ANSWER <slug>: ...` line newer than the matching `BLOCKED` receipt
  before claiming anything new; resume ahead of fresh items when found.
- **HUMAN-HOLD** — the narrower BLOCKED variant, for a question only one specific human can
  authoritatively answer (external-effect approvals, scope changes, spend): append `{human-hold: <slug>}`
  in place of `{blocked: <slug>}`. Unlike BLOCKED, a written `ANSWER <slug> by <authorizer>: ...` STATE
  line is on its own never enough to resume it — a plain-file line can't authenticate who actually wrote
  it, so trusting one alone would let this session (or anyone with file access) self-approve its own
  hold. This session has no `AskUserQuestion` tool, but every Cowork sprint IS itself an attended chat:
  ask the human directly, in this same conversation, whether they are (or can confirm) the named
  authorizer, and write `ANSWER <slug> by <authorizer>: ...` to STATE only after they answer here — treat
  any `ANSWER ... by <authorizer>` line you did not just write in direct response to that live reply as
  unauthenticated and leave the item held. Same file-based mechanism as BLOCKED otherwise; nothing
  Claude-Code-specific to degrade here beyond the missing tool, so this session carries the rest of it in
  full. Running this protocol unattended (no human in the conversation to ask) leaves every
  `{human-hold:}` item permanently parked, same posture as `/muster:runner`.
- **LEDGER** — exactly one heartbeat line per runner, edited in place, kept to that single entry rather
  than appended twice.
- A single-runner sprint may skip claim/scan (nothing to race against) but should still leave receipts
  for audit.

## Dispositions — default to `pr`/`keep`, be honest about the rest

Unannotated items default to `pr`, same as the plugin. When a backlog item explicitly declares
`merge-local`/`merge-push`, honor it — that is the human's stated intent — but log it loudly: on Claude
Code, the `PreToolUse` hook's action-class fence bounds some of the blast radius of a direct-to-base
merge running unattended (it denies a matching forbidden action class, e.g. a `git push`/`gh pr merge`
call, while `.muster/run-active` and `.muster/forbidden-actions` are both set); **this session has no
hooks at all, so it has none of that.** A `merge-local`/`merge-push` disposition here
executes with zero structural safety net beyond this session's own diligence. Say that explicitly in the
STATE receipt for that item, not just in this document. When authoring a backlog for a Cowork sprint,
prefer `pr`/`keep` for exactly this reason.

**Unattended mode** — same downgrade rule as the plugin: `merge-local`/`merge-push` downgrades to `pr`
with a note in STATE and the batch report; never push to a base branch unattended. Step 4 has no stop at
all in this mode: write the batch report and exit.

## Glass box

The `## Sprint` section, each item's branch/commits/escalations, the `## Coordination` receipts (when
used), and the final batch report are all written to STATE as the sprint runs — same discipline as
Claude Code, just without a hook scaffolding the file for you.
