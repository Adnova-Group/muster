---
name: coordination
description: Source-agnostic protocol for running one backlog with more than one independent runner at a time — CLAIM before work, structured RECEIPTS on every state change, BLOCKED items record a question and RESUME once answered (HUMAN-HOLD narrows resume to a named authorizer), one heartbeat LEDGER entry per runner. Two bindings: GitHub issues (labels + gh CLI) and backlog.md (annotations + STATE). Wired in by /muster:sprint.
---

# Coordination

You are muster's cross-runner coordination protocol — keep independent runners (separate `/muster:sprint`
invocations, or humans and agents both touching the same backlog) from doing the same item twice and
from silently going quiet when one gets stuck.

Return per-item the state it left the shared backlog/label in (claimed / done / blocked / failed) plus
the receipt(s) written — a work-cycle never ends silently, even on failure.

Load this when a backlog (file or `issues:<label>`) may be worked by more than one runner concurrently.
A single-runner sprint may skip the claim/scan steps (nothing to race against) but should still leave
receipts and a ledger heartbeat for auditability. The mechanism below (CLAIM/RECEIPTS/BLOCKED→RESUME/
LEDGER) is adapted, mechanism-only, from a well-known open multi-agent coordination pattern — the
attribution note belongs in `website/about/credits.md` (out of scope here; flagged for the release sweep).

## Core mechanism (source-agnostic)

1. **CLAIM** — before any work on an item, atomically mark it claimed with runner identity + timestamp;
   a claimed item is skipped by other runners. Runner identity reuses the invocation's existing `runId`
   (the slug already used to key run STATE/scratchpad, per the orchestrator skill) — an independent
   runner sharing a backlog/label IS a separate run, so its `runId` doubles as its coordination identity.
   No new identity infrastructure needed.
2. **RECEIPTS** — every state change leaves a structured receipt: `CLAIMED` / `DONE` / `BLOCKED(reason,
   question)` / `HUMAN-HOLD(reason, question, authorizer)` / `FAILED(reason)` / `YIELD(losing runner
   conceding a claim race)` / `IDLE` (a cycle that finds nothing claimable — no item exists to annotate,
   so it folds into the runner's own LEDGER heartbeat rather than a fresh per-item line).
3. **BLOCKED/HUMAN-HOLD→RESUME** — a stalled item is split by WHO can clear it. **BLOCKED** (the
   default, unchanged from before) is answerable by anyone — any runner's or human's reply resumes it.
   **HUMAN-HOLD** is the narrower case where only the authorizing human specifically can answer:
   external-effect approvals (publish/deploy/notify/spend) and scope changes (widening an item's
   fences/deps beyond what was claimed) — anything where a different human's or another runner's answer
   would not actually be authoritative. Both record a question and both resume once answered, but the
   resume gate differs: a BLOCKED item resumes on ANY reply; a HUMAN-HOLD item resumes ONLY on a reply
   from the specific authorizer named in its own HUMAN-HOLD receipt — any other reply is inert. Runners
   scan for BOTH before claiming new work, HUMAN-HOLD first (its identity gate is the stricter of the
   two, so a resumable HUMAN-HOLD item should not sit behind newer plain-BLOCKED items in scan order).
4. **LEDGER** — each runner maintains exactly ONE heartbeat entry (last seen, last item, result), edited
   in place — never a growing pile of heartbeats.
5. **One item per claim cycle** — claim, work, leave a receipt, THEN look for the next item. Never batch
   claims ahead of work.
6. **STANDING-CONTEXT PREFLIGHT** — once per cycle, before doing anything else this cycle (before CLAIM,
   before the resume scan), a runner checks whether the protocol text it is actually running on has
   drifted from the repo's current tip. Compare the commit each in-scope file was at when this session
   first read it (recorded once, at that first read) against its CURRENT commit:
   ```
   git log -1 --format=%h -- plugin/skills/coordination/SKILL.md
   git log -1 --format=%h -- plugin/commands/sprint.md
   git log -1 --format=%h -- plugin/commands/runner.md
   ```
   No change in hash: proceed. A changed hash whose diff is confined to these files and does not widen
   what the runner is bound by (a clarification, a new example, a tightened rule) — reload that file
   (re-read its current text) and proceed under it for the rest of this cycle, no approval needed; it
   still governs the same scope the runner already operates under. A changed hash whose diff EXPANDS
   scope — a new forbidden action, a new fence, a new binding, anything the runner was NOT already bound
   by — is never silently adopted: it is a HUMAN-HOLD (the authorizing human is whoever owns this repo's
   muster configuration), citing the file(s) and old/new hash(es) as the question, because a runner
   cannot authorize its own scope expansion by reading it off disk. This composes with an item's own
   resume/claim-window mechanics unchanged — a version mismatch is a property of the RUNNER's session,
   never of an item's claim state.

An **escalation** (sprint.md's own terminal disposition — spec-gate cap, fix-loop cap) is not a new
receipt type: it is a `FAILED` receipt (attempt-counted, per each binding's existing format) plus the
item-level escalated-marker — Binding B's `{escalated: <runId or date>}` annotation, Binding A's move to
`agent:needs-input` with a question comment — so a later claim scan skips it by that marker alone,
never re-deriving it from the retry-cap math.

## Binding A — GitHub issues (`issues:<label>`)

States are labels on the issue: `agent:todo` → `agent:working` → `agent:review` (PR open, awaiting
merge) or `agent:done` (merged / disposition executed). `agent:needs-input` is the BLOCKED (and
HUMAN-HOLD) side-state (resumes back to `agent:working`); `agent:todo` is also the FAILED landing
state — retry-eligible, unassigned.

**Bootstrap** (one-time per repo, before first use — idempotent, safe to re-run every sprint start):
```
gh label create agent:todo --color ededed --force
gh label create agent:working --color fbca04 --force
gh label create agent:review --color 0e8a16 --force
gh label create agent:done --color 5319e7 --force
gh label create agent:needs-input --color d93f0b --force
gh label create muster:ledger --color 1d76db --force
```
`--force` updates color/description instead of erroring when the label already exists, so this runs
unconditionally rather than gating on a per-label existence check.

**Claim** (assign + label flip, both before work starts — assignment alone is not the lock, see below):
```
gh issue edit <N> --add-assignee "@me" --remove-label agent:todo --add-label agent:working
gh issue comment <N> --body "MUSTER CLAIMED <runner> <ts>"
```
GitHub issues allow multiple assignees, so two runners racing the same issue can BOTH land as
assignee — assignee-based detection fails open. The CLAIM COMMENT is the actual lock, but the tiebreak
must be scoped to the **current claim window** — the comments posted since the issue's last terminal
receipt (`MUSTER DONE` / `MUSTER BLOCKED` / `MUSTER HUMAN-HOLD` / `MUSTER FAILED` — deliberately NOT
`YIELD`: a loser's yield landing before the winner's re-read would otherwise floor the winner's own
claim out of its window, making the win undecidable). Without that floor, a fresh claim after a
`FAILED` retry or a blocked/human-hold resume gets compared against a stale claim from a PRIOR cycle,
which is always earlier — every legitimate reclaimer "loses" and the item strands in `agent:working`,
unowned. Re-read every comment on the issue
(paginated — a race scan that silently truncates at 30 comments is a false read), find that window's
floor, then rank only the `CLAIMED` comments inside it by their server-assigned `created_at`,
identifying each claim by the `<runner>` token in the comment BODY rather than the comment author's
`login` — runners sharing one GitHub token are otherwise indistinguishable:
```
gh api repos/{owner}/{repo}/issues/<N>/comments --paginate --slurp --jq '
  flatten
  | ([.[] | select(.body | test("^MUSTER (DONE|BLOCKED|HUMAN-HOLD|FAILED)")) | .created_at] | sort | last // "") as $windowStart
  | [.[] | select(.body | test("^MUSTER CLAIMED")) | select(.created_at > $windowStart)
     | {runner: (.body | capture("^MUSTER CLAIMED (?<r>[^ ]+)").r), created_at}]
  | sort_by(.created_at)'
```
The entry with the EARLIEST `created_at` in that list wins — comment timestamps are server-ordered, so
this is a real tiebreak even for near-simultaneous claims. If the earliest `runner` is not yours, you
lost the race:
```
gh issue edit <N> --remove-assignee "@me"
gh issue comment <N> --body "MUSTER YIELD <runner> <ts> — lost claim race to <winning runner>"
```
then move on to the next `agent:todo` issue — leave the label alone, the winner owns the flip. Exception:
if the issue already carries a later-state label (`agent:review`, `agent:done`, or `agent:needs-input`)
— meaning your own claim-time `--add-label agent:working` landed after the winner had already moved the
issue past that state — also run `gh issue edit <N> --remove-label agent:working` as part of yielding, so
the issue is not left mislabeled with both `agent:working` and its true later state.

If the earliest `runner` is yours, before starting work count prior `MUSTER FAILED` receipts on this
issue — across its WHOLE history, not just the current window, since the retry cap is cumulative —
paginated, same reason as above:
```
gh api repos/{owner}/{repo}/issues/<N>/comments --paginate --slurp --jq \
  'flatten | [.[] | select(.body | test("^MUSTER FAILED"))] | length'
```
At 2 prior failures, do not recycle into another attempt — redirect to needs-input instead:
```
gh issue comment <N> --body "MUSTER BLOCKED <runner> <ts>
retry cap reached (2 prior failures) — needs human input before another attempt"
gh issue edit <N> --remove-label agent:working --add-label agent:needs-input
```
Fewer than 2 prior failures: proceed with work as normal.

**Receipts** are issue comments whose FIRST LINE is fixed, followed by free-text detail:
```
MUSTER CLAIMED <runner> <ts>
MUSTER DONE <runner> <ts>                (+ disposition and PR/commit link)
MUSTER BLOCKED <runner> <ts>             (+ the question)
MUSTER HUMAN-HOLD <runner> <ts> authorizer=<login>  (+ the question)
MUSTER FAILED <runner> <ts> attempt <n>  (+ the reason)
MUSTER YIELD <runner> <ts>               (+ which claim comment won the race)
```

**Done:**
```
gh issue comment <N> --body "MUSTER DONE <runner> <ts>
<disposition> <PR link or commit sha>"
gh issue edit <N> --remove-label agent:working --add-label agent:review   # disposition pr/ask
# OR, when the disposition merges directly (merge-local/merge-push/keep):
gh issue edit <N> --remove-label agent:working --add-label agent:done
gh issue close <N> --comment "closed by muster sprint (<runner>)"
```

**Blocked:** `<question>` is free text the runner composes — it can quote backlog/issue content
verbatim, so it can carry unescaped quotes, backticks, or `$(...)`. Write the body text to a scratch
file with your file-write tool (never shell `echo`/`printf`, which re-exposes the exact same quoting
hazard) and pass `--body-file`, never inline it into `--body "..."`, so hostile question text can't
break the shell's quoting or get evaluated as a command substitution:
```
# write "MUSTER BLOCKED <runner> <ts>\n<question>" to <bodyfile> with your file-write tool, then:
gh issue comment <N> --body-file <bodyfile>
gh issue edit <N> --remove-label agent:working --add-label agent:needs-input
```
**Human-hold:** the narrower BLOCKED variant — raise it instead of BLOCKED when the question can only be
authoritatively answered by one specific human (external-effect approval, scope change, spend), never by
"any" replier. Reuses the SAME `agent:needs-input` label as BLOCKED rather than adding a new one: the
bootstrap block above is a one-time idempotent cost either way, but a runner's resume scan already opens
every `agent:needs-input` issue's full comment thread to find its latest receipt — this label already
carries more than one underlying state (BLOCKED, and an escalation per the note above), told apart by
the comment body alone; HUMAN-HOLD costs nothing extra to add to that same read. A second label would
still need the comment read (to get the authorizer's login), plus its own bootstrap line and its own
add/remove pair on every transition, for a distinction the receipt already carries for free — so
receipt-discriminated single-label is the cleaner fit here, consistent with the escalated-item
precedent. `<question>` carries the same hostile-quoting risk as BLOCKED's above — write the body to a
scratch file and use `--body-file`, never inline it:
```
# write "MUSTER HUMAN-HOLD <runner> <ts> authorizer=<login>\n<question>" to <bodyfile>, then:
gh issue comment <N> --body-file <bodyfile>
gh issue edit <N> --remove-label agent:working --add-label agent:needs-input
```
`<login>` is the GitHub login of the human who must personally answer — the repo owner unless the
question names someone else who actually holds the authority in play.

**Resume scan** (run before claiming anything new — HUMAN-HOLD items first, then BLOCKED, per the
core-mechanism ordering above):
```
gh issue list --label agent:needs-input --state open --json number,comments
```
For each: find the latest `MUSTER BLOCKED` or `MUSTER HUMAN-HOLD` comment (whichever is later decides
which resume rule applies to this issue right now).
- **BLOCKED**: if any LATER comment on the issue does not start with `MUSTER ` (a human reply, any
  human), it is answered.
- **HUMAN-HOLD**: a later non-`MUSTER `-prefixed comment only counts if its author's `.user.login`
  equals the `authorizer=<login>` recorded in the `MUSTER HUMAN-HOLD` comment — read from the SAME
  paginated comment listing, no extra API call. Any other human's reply is inert and leaves the item
  held. (Inverse of the CLAIMED-comment identity problem above: there, the comment BODY token was
  authoritative because runners can share one GitHub token; here the comment AUTHOR's login is
  authoritative because a human replies under their own account.)

Either way, once answered/authorized: re-claim ahead of any fresh `agent:todo` item (`--remove-label
agent:needs-input --add-label agent:working`, then a `MUSTER CLAIMED` receipt noting the resume). Two
runners can independently notice the same answered item in the same cycle, so this resume-claim is
subject to the same windowed race check as any other claim above — that `MUSTER BLOCKED` / `MUSTER
HUMAN-HOLD` comment is itself the window floor, so the re-claim's `CLAIMED` naturally lands inside a
fresh window.

**Failed** (revert to claimable, never silently drop the item — unless the retry-cap check during
claim already redirected this issue to `agent:needs-input` instead):
`<reason>` is free text (often a quoted error/log excerpt) — the same hostile-quoting risk as
`<question>` above, so write the body to a scratch file with your file-write tool and use
`--body-file`, never `--body "..."`:
```
# write "MUSTER FAILED <runner> <ts> attempt <n>\n<reason>" to <bodyfile> with your file-write tool, then:
gh issue comment <N> --body-file <bodyfile>
gh issue edit <N> --remove-assignee "@me" --remove-label agent:working --add-label agent:todo
```
`<n>` is this attempt's number: 1 + the prior-`MUSTER FAILED` count already read during claim.

**Ledger** — one pinned issue; bootstrap once:
```
gh issue list --label muster:ledger --state open --json number --jq '.[0].number'
# if empty:
gh issue create --title "MUSTER Coordination Ledger" --label muster:ledger \
  --body "One comment per runner, edited in place: last-seen, last item, result."
gh issue pin <ledgerNum>
```
Each cycle, find-then-edit (or first-create) your own comment. `<N or item text>` can be raw backlog/
issue text verbatim — the same hostile-quoting risk as `<question>`/`<reason>` above — so write the
body to a scratch file with your file-write tool first, then reference it via `@<bodyfile>` (`gh api`'s
`-F` reads a field's raw value from a file when given `@path`) or `--body-file <bodyfile>`, never
inline the body into `-f body="..."` / `--body "..."`:
```
gh issue view <ledgerNum> --json comments \
  --jq '.comments[] | select(.body | startswith("MUSTER LEDGER <runner> ")) | .id'
# write "MUSTER LEDGER <runner> <ts>\nlast item: <N or item text>\nresult: <claimed|done|blocked|human-hold|failed|idle>" to <bodyfile>, then:
# found -> edit in place:
gh api -X PATCH repos/{owner}/{repo}/issues/comments/<commentId> -F body=@<bodyfile>
# not found -> first heartbeat:
gh issue comment <ledgerNum> --body-file <bodyfile>
```
On an idle cycle (nothing claimable), there is no item to reference: write `last item: none —
nothing claimable` and `result: idle` into this SAME comment (found via the `MUSTER LEDGER <runner> `
prefix above, unchanged, so the next cycle's find still matches) — the runner's one ledger comment
carries the same `IDLE <runner> <ts> — nothing claimable` heartbeat that Binding B writes below, just
wrapped in this binding's existing template rather than posted as a fresh comment (there is no issue
to comment on).

## Binding B — backlog.md

Extends the existing `{key: value}` grammar (`src/sprint-waves.js`) — its annotation strip is generic,
so unknown keys pass through harmlessly: `{claimed:}`/`{blocked:}`/`{human-hold:}` parse, strip cleanly
from item text, and never affect wave computation or the audit backlog-mode dedupe/assess rule (which
already strips every `{key: value}` generically before comparing text). `{human-hold:}` is a distinct
key from `{blocked:}` rather than a reused one discriminated by receipt (contrast Binding A's
`agent:needs-input` label decision above): this binding's annotations cost nothing extra to add — the
generic strip already passes any unknown key through harmlessly, so there is no bootstrap/label-flip
overhead to weigh against reuse, unlike Binding A's labels which need an explicit `gh label create` and
an add/remove pair per transition. Verified live:
`node src/cli.js sprint-waves` on a line carrying `{id}`/`{deps}` alongside `{claimed: x@y}` returns
`ok:true` with the correct wave and the annotation absent from `items[...].text`.

**Coordination is orchestrator-level** — only the top-level `/muster:sprint` driver reads/writes
`{claimed:}`/`{blocked:}`/`{human-hold:}`/`{attempts:}` annotations on backlog.md and the run STATE's
`## Coordination` section below. Wave mode's per-item worktree runners (sprint.md's Isolation rule:
runners never write the main STATE) never claim, never write these annotations, and never touch the
Coordination section directly — the driver writes each item's `{claimed:}` annotation/receipt itself,
before dispatching that item's worktree runner (the lock precedes any work, never deferred to
wave-end), then transcribes each runner's returned outcome, via the existing per-item return contract,
into its DONE/BLOCKED/HUMAN-HOLD/FAILED receipt and the ledger once the wave completes.

- **Claim** — append `{claimed: <runner>@<ts>}` to the item's line before starting work. Scan unchecked
  items top to bottom; skip any already carrying a `{claimed:}` from a DIFFERENT runner (your own prior
  annotation is a no-op resume, e.g. after a restart). Claim-then-verify: re-read the file right after
  writing; if another runner's `{claimed:}` shows instead of/alongside yours, you lost the race — move
  to the next unclaimed item. Plain-file coordination has no true compare-and-swap; this binding assumes
  a small number of cooperative runners, not adversarial high concurrency — a known, documented limit.
- **Receipts + ledger** live in the run STATE under a `## Coordination` section, one line per change:
  ```
  CLAIMED <item-id> <runner> <ts>
  DONE <item-id> <runner> <ts> <disposition>
  BLOCKED <item-id> <runner> <ts> <question>
  HUMAN-HOLD <item-id> <runner> <ts> authorizer=<human> <question>
  FAILED <item-id> <runner> <ts> <reason>
  IDLE <runner> <ts> — nothing claimable
  LEDGER <runner> last-seen=<ts> last-item=<item-id> result=<claimed|done|blocked|human-hold|failed|idle>
  ```
  The `LEDGER` line is edited in place (find-and-replace your own prior `LEDGER <runner> ...` OR
  `IDLE <runner> ...` line) — never appended twice; that is the one-heartbeat-per-runner rule. **IDLE**
  is that same edited-in-place slot, not a fresh line: a cycle that finds nothing claimable has no item
  to annotate (no `{claimed:}`/`{blocked:}`/`{human-hold:}`/`{escalated:}` touches anywhere), so the
  runner's one heartbeat entry reads `IDLE <runner> <ts> — nothing claimable` for that cycle instead of
  the usual `last-seen=.../last-item=.../result=...` fields.
- **Blocked/Human-hold→resume** — append `{blocked: <slug>}` (answerable by anyone) or `{human-hold:
  <slug>}` (answerable only by the named authorizer — external-effect approvals, scope changes, spend)
  to the item's line (replacing `{claimed:}`), and write the matching `BLOCKED`/`HUMAN-HOLD` receipt
  with the question (`HUMAN-HOLD` also records `authorizer=<human>`). Resume scan (before claiming
  anything new, HUMAN-HOLD items first, per the core-mechanism ordering above):
  - For a `{blocked: <slug>}` item: search STATE's `## Coordination` section for an `ANSWER <slug>:
    <text>` line newer than the matching `BLOCKED ... <slug>` receipt — any author counts.
  - For a `{human-hold: <slug>}` item: the same search only resumes it if the line is written as
    `ANSWER <slug> by <authorizer>: <text>`, naming the exact authorizer recorded in that item's
    `HUMAN-HOLD ... <slug>` receipt (`ANSWER <slug>: <text>` with no `by <authorizer>`, or one naming
    someone else, does not resume it).

  Either way, when found: replace `{blocked: <slug>}` / `{human-hold: <slug>}` with `{claimed:
  <runner>@<ts>}` and resume that item ahead of any fresh one.
- **Done/Failed** — on DONE, sprint's own step 2 already checks the box or leaves it unchecked with
  `{escalated: ...}`; leave `{claimed:}` in place as a harmless (generic-stripped) audit trail of who
  did it. On FAILED — a crash/dispatch failure, distinct from an escalation — strip `{claimed:}` back
  off the line, then bump `{attempts: n}` (absent → `{attempts: 1}`; present → increment) so retries
  are counted across runners/restarts, and write the `FAILED` receipt below. At `{attempts: 2}` (2
  prior failures), do not leave the item freshly claimable: replace `{attempts: 2}` with
  `{blocked: max-retries-<item-id>}` instead — the item-id makes the slug unique per item; a bare
  `{blocked: max-retries}` would collide across every capped item in the backlog, and a single
  `ANSWER max-retries: ...` would resume all of them at once — and write a `BLOCKED <item-id> <runner>
  <ts> retry cap reached (2 prior failures) — needs human input` receipt in place of the `FAILED` one —
  it re-enters the claim pool only via the normal resume scan (an `ANSWER max-retries-<item-id>: <text>`
  line), exactly like any other blocked item. Below the cap, the item is left reclaimable as before,
  `{attempts:}` intact for the next runner to see.
