# Sprint protocol (Cowork-adapted)

You are the Cowork session driving this sprint: a condensed, Cowork-native port of `/muster:go-backlog`'s
lifecycle (`plugin/commands/go-backlog.md`) — driving the full go lifecycle sequentially over every
item in a backlog, one attended stop at the end, served through `muster_sprint_protocol` so a Cowork
session can follow it without the plugin loaded. Same intent, same guarantees where they port; the gaps
below are named, not papered over.

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
- **No isolated parallel item-runners.** Wave mode's per-item isolation on Claude Code is a
  `muster-runner` subagent per item, dispatched with `isolation: "worktree"` into its own
  `.worktrees/<branch>`; its tool calls there rely on the `PreToolUse` hook's `agent_id` subagent
  exemption (decision order step 1, ahead of the action-class fence), not a wave-guard exemption —
  that hook has no wave-guard left to exempt from. That has no Cowork equivalent — there is no hook
  to exempt from in the first place, and no per-dispatch worktree parameter on this MCP surface
  either. Cowork's own subagent fan-out is confirmed to work in general (see this server's core-loop
  instructions above), and it still applies
  **inside** a single item's own crew/waves. But running MULTIPLE backlog items concurrently, each in its
  own worktree, has no validated isolation model here. So: **the "Degradation" path in `go-backlog.md`
  — every wave executed sequentially, one item at a time, in the main tree — IS the path for Cowork
  sprints, not a fallback.** Say this plainly in STATE so nobody assumes parallel item throughput.
- **No `gh`-issue binding here.** This document covers the FILE backlog source only
  (`.muster/backlog.md`). `issues:<label>` is out of scope.

## 1. Resolve the backlog

Read `.muster/backlog.md` yourself (Cowork's own file tools — this is outside the MCP server's remit).
Empty argument defaults to that path. Items are the unchecked `- [ ]` checklist lines; an item may carry
a trailing annotation, e.g. `- [ ] Add retry to fetch {disposition: pr}` (`{id}`, `{deps}`,
`{disposition: merge-local|merge-push|pr|keep|ask}`, `{escalated: ...}`).

Call **`muster_sprint_waves`** with the raw backlog text. Its JSON is authoritative:
- `ok:false` — report the named `errors`, stop. Nothing runs.
- `ok:true`, `annotated:false` — no `{id}`/`{deps}` grammar in use; proceed as a flat, in-file-order
  queue (steps 2-4, sequential regardless).
- `ok:true`, `annotated:true` — **wave mode**: `waves` gives the dependency-ordered groups. Under this
  session's degradation rule (above), still walk every wave's items ONE AT A TIME — cross-wave order is
  fixed, intra-wave order is free, but nothing here dispatches two items concurrently.

Missing backlog file, or a malformed annotation the tool reports as an error, stops the run — nothing to
run, report it plainly.

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

## 3. Per item, sequentially

For each item, in wave/queue order, run the same per-item lifecycle as a single go pass — ported
through this server's core loop (`muster_detect`/`muster_capabilities`, `muster_route`/`muster_domain`,
`muster_assess` as the spec gate, a crew manifest validated with `muster_manifest_validate`, waves from
`muster_wave` dispatched — that item's OWN crew may still fan out in parallel, this constraint is only
about not running two BACKLOG items at once — then the escalation check, then finish/disposition), using
the item text as the outcome and its parsed disposition as `mergeDisposition` (default `pr` when
unannotated).

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
  dependent of an escalated item builds without that work (items branch off the current base tip) — order
  the backlog accordingly.
- **Step 8's override, here too** — inside this sprint no AskUserQuestion merge prompt fires per item;
  the declared disposition executes directly, `ask`/absent coerces to `pr`, noted in the batch report.
- **Backlog drain** — after each item's disposition lands and its tick/annotation is written, re-resolve
  the backlog file (re-run `muster_sprint_waves`). New unchecked items not in the original snapshot are
  admitted into the remainder; escalated/claimed items stay excluded from re-admission this sprint —
  concretely, admitted items are exactly those whose `items[id].claimed` is `null` in the re-resolve's
  JSON output; the tool's JSON is the authority, always deferred to rather than re-parsing the raw
  `{claimed: ...}` annotation text yourself. An item removed mid-sprint: drop it if not started (note in
  STATE), finish normally if already running.

## 4. Finish — the single attended stop

Once every item is `done` or `escalated`, write the batch report table to STATE (item | disposition
executed | branch/PR/commits | gate summary | escalations), then offer one follow-up choice: **review
escalated items now / review later / done.**

## Claim/receipt discipline — orchestrator level, when it matters

If more than one runner (parallel sessions, human + agent) might touch this backlog, apply the
coordination mechanism (Binding B, `plugin/skills/coordination/SKILL.md`) yourself, at the orchestrator
level only — this session is the only "runner" of record here since there is no per-item worktree runner
to keep out of it:
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
