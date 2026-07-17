---
name: coordination
description: Source-agnostic multi-runner protocol -- CLAIM before work, structured RECEIPTS, BLOCKED/HUMAN-HOLD->RESUME, one heartbeat LEDGER per runner. Four bindings: GitHub issues (labels + gh CLI), backlog.md (annotations + STATE), Linear (statuses + MCP), Hermes kanban (native kanban.db). Wired in by /muster:sprint.
---

# Coordination

You are muster's cross-runner coordination protocol — keep independent runners (separate
`/muster:sprint` invocations, humans and agents alike) from doing the same item twice and from
silently going quiet when one gets stuck. Return per-item the state it left the shared backlog/label
in (claimed / done / blocked / failed) plus the receipt(s) written -- a cycle always ends with a
receipt, even on failure.

Load this when a backlog (file, `issues:<label>`, `linear:<team or project>`, or a Hermes kanban board)
may see more than one runner; a single-runner sprint may skip claim/scan but still leaves a receipt +
heartbeat. CLAIM/RECEIPTS/BLOCKED→RESUME/LEDGER is adapted, mechanism-only, from a well-known open
multi-agent coordination pattern (attribution: `website/about/credits.md`, out of scope here).

## Protocol states (canonical -- binds all four bindings)

State meaning, transition, and resume semantics live HERE once; each binding below states only its own
primitive + capability gap, never the semantics again.

1. **CLAIM** — atomically mark an item claimed with runner identity (the existing `runId`) + timestamp
   before any work; a claimed item is skipped by others.
   - *A, C (comment/status-race)*: the assignee/status flip is not the lock -- GitHub/Linear let two
     runners both land as assignee before either sees the other. The CLAIM RECEIPT is the lock, scoped
     to the **current claim window**: every receipt since the last terminal one
     (`DONE`/`BLOCKED`/`HUMAN-HOLD`/`FAILED`, deliberately NOT `YIELD`, else a loser's yield before the
     winner re-reads would floor the winner's own claim -- a fresh reclaim would compare against a stale
     claim and always "lose"). Re-read the FULL history (paginated to exhaustion),
     rank the `CLAIMED` receipts inside the floor by server timestamp, identified by the `<runner>` BODY
     token, not the API-level author (shared account/token is otherwise indistinguishable); earliest
     wins. `src/coordination.js` is the source of truth here and for the HUMAN-HOLD resume gate.
   - *B (annotation)*: no true compare-and-swap in a plain file -- claim-then-verify (write, re-read;
     another runner's annotation means you lost) assumes cooperative runners, not adversarial
     concurrency (documented limit).
   - *D (native)*: a real compare-and-swap at the database layer -- no claim race to arbitrate.
2. **RECEIPTS** — every state change leaves one: `CLAIMED`/`DONE`/`BLOCKED(reason, question)`/
   `HUMAN-HOLD(reason, question, authorizer)`/`FAILED(reason)`/`YIELD(losing runner conceding a race)`/
   `IDLE` (nothing claimable -- folds into the LEDGER heartbeat, not a fresh line). A and C share one
   fixed-first-line syntax (B/D's own grammars are each the equivalent, same fields):
   ```
   MUSTER CLAIMED <runner> <ts>
   MUSTER DONE <runner> <ts>                (+ disposition and PR/commit link)
   MUSTER BLOCKED <runner> <ts>             (+ the question)
   MUSTER HUMAN-HOLD <runner> <ts> authorizer=<authorizer-field>  (+ the question)
   MUSTER FAILED <runner> <ts> attempt <n>  (+ the reason)
   MUSTER YIELD <runner> <ts>               (+ which claim comment won the race)
   ```
   `<authorizer-field>`: A's GitHub `<login>`, C's Linear `<displayName>` -- the only per-binding delta.
3. **BLOCKED vs HUMAN-HOLD → RESUME** — split by WHO can clear a stall. **BLOCKED** (default) is
   answerable by anyone; **HUMAN-HOLD** only by the authorizing human. Both record a question; BLOCKED
   resumes on ANY reply, HUMAN-HOLD ONLY on its named authorizer -- any other is inert; scan both in one
   unordered pass. **The gate is only as strong as what authenticates it**: a binding whose reply channel
   is independently authenticated (A: GitHub login; C: Linear author identity) resumes a HUMAN-HOLD
   unattended by matching identity to the recorded `authorizer=`. A binding whose channel is just text
   (B: a STATE line; D: a `kanban_comment`) cannot trust a bare match -- resume needs an **ATTENDED**
   session (present the question via **AskUserQuestion**; only after the human answers does the
   orchestrator itself, exclusively, write the resume state -- never the runner, never pre-written). An
   **UNATTENDED** runner (`/muster:runner`, Routine mode) has no session to ask, so such a HUMAN-HOLD is
   **permanently parked** for the cycle. A binding capable of identity validation (A, C) MUST confirm the
   named authorizer exists before WRITING a HUMAN-HOLD -- adversarial text must not name an arbitrary
   identity and have it accepted; fall back to a configured default (repo owner / admin) when unconfirmed.
4. **YIELD** — the losing claimant concedes: revert whatever it claimed, leave a `YIELD` receipt naming
   the winner, move on without touching a further-along state the winner already reached (its own
   cleanup, not another state change). No race in B/D means no YIELD case there.
5. **FAILED / retry cap** — revert to claimable, always a record. Count prior `FAILED` receipts across
   the WHOLE history (cumulative, not windowed); at 2, redirect straight to BLOCKED/needs-input instead
   of another attempt. `attempt <n>` = 1 + that count.
6. **LEDGER** — exactly ONE heartbeat entry per runner, edited in place, not appended; an idle cycle
   reuses it with `result: idle`.
7. **Escalation** (spec-gate/fix-loop cap -- a review-gate trigger, NOT bullet 5's coordination retry
   cap) is not a new receipt type: a `FAILED` receipt plus the item-level escalated-marker -- B's
   `{escalated: <runId or date>}`, A's move to `agent:needs-input`, C's move to its blocked status, D's
   `kanban.failure_limit` auto-block (or a repeated `kanban_block` escalating to `triage`) -- a later
   scan relies on that marker alone.
8. **One item per claim cycle** — claim, work, leave a receipt, then look for the next.
9. **STANDING-CONTEXT PREFLIGHT** — once per cycle, before anything else, check this protocol text for
   drift from the repo's tip against a fingerprint recorded at first read (below).
10. **HYGIENE PREFLIGHT** — once per cycle, before CLAIM, run `node src/cli.js hygiene --reap`: reaps a
    zombie provider CLI, auto-releases a claim past a 60-minute heartbeat, and offers a
    stale-worktree sweep past 10 live worktrees. `src/hygiene.js` is the source of truth; this bullet
    only renders it.

## Standing-context preflight

Compare each in-scope file/path's commit at first read against its CURRENT commit. The set is every
file a runner's behavior is bound by, not just this skill -- drift in the hook layer or go.md's own
forbidden-action list is the silent scope-widening this preflight exists to catch. Names LIVE behavior
files, not legacy-alias redirects (`plugin/commands/sprint.md`/`autopilot.md` are now stubs that only
read-and-execute `go-backlog.md`/`go.md`):
`plugin/skills/coordination/SKILL.md`, `plugin/commands/go-backlog.md`, `plugin/commands/go.md`,
`plugin/commands/runner.md`, `plugin/hooks/`. One `git log` call over the whole set:
```
git log -1 --format=%h -- plugin/skills/coordination/SKILL.md plugin/commands/go-backlog.md \
  plugin/commands/go.md plugin/commands/runner.md plugin/hooks/
```
Every binding below cross-references this same
fingerprint set (SKILL.md/go-backlog.md/go.md/runner.md/hooks/) instead of re-listing it.

No change: proceed. Changed: `git diff <recorded-hash> <current-hash> -- <same paths>`, then classify
deterministically:

- **EXPANDS** (HUMAN-HOLD it, citing the file(s) and old/new hash; authorizer is this repo's
  muster-config owner) iff the diff touches ANY of: a `forbiddenActions` entry, a `fences`
  block, `action-guard` matching logic, anything under `plugin/hooks/`, a new RECEIPTS-enum token
  (`CLAIMED`/`DONE`/`BLOCKED`/`HUMAN-HOLD`/`FAILED`/`YIELD`/`IDLE`/`LEDGER`), or a new resume rule.
- **CONFINED** (reload the changed file(s), proceed for the rest of this cycle) -- everything else: a
  clarification, a new example, a tightened description of a rule already binding.

Ambiguous? Say so in the HUMAN-HOLD question rather than guess -- a runner cannot authorize its own
scope expansion. A version mismatch is a property of the RUNNER's session, not the item's claim state.

## Binding A — GitHub issues (`issues:<label>`)

Labels: `agent:todo` → `agent:working` → `agent:review` (PR open) or `agent:done` (merged).
`agent:needs-input` is the BLOCKED/HUMAN-HOLD side-state (resumes to `agent:working`); `agent:todo` is
also the FAILED landing state.

**Bootstrap** (`--force` updates instead of erroring; runs unconditionally every sprint start):
```
gh label create agent:todo --color ededed --force
gh label create agent:working --color fbca04 --force
gh label create agent:review --color 0e8a16 --force
gh label create agent:done --color 5319e7 --force
gh label create agent:needs-input --color d93f0b --force
gh label create muster:ledger --color 1d76db --force
```

**Claim** (assign + label flip, then the CLAIM RECEIPT that is the actual lock, per canonical above):
```
gh issue edit <N> --add-assignee "@me" --remove-label agent:todo --add-label agent:working
gh issue comment <N> --body "MUSTER CLAIMED <runner> <ts>"
```
Window-floor query (paginated, never truncated):
```
gh api repos/{owner}/{repo}/issues/<N>/comments --paginate --slurp --jq '
  flatten
  | ([.[] | select(.body | test("^MUSTER (DONE|BLOCKED|HUMAN-HOLD|FAILED)")) | .created_at] | sort | last // "") as $windowStart
  | [.[] | select(.body | test("^MUSTER CLAIMED")) | select(.created_at > $windowStart)
     | {runner: (.body | capture("^MUSTER CLAIMED (?<r>[^ ]+)").r), created_at}]
  | sort_by(.created_at)'
```
Not the earliest -- lost the race:
```
gh issue edit <N> --remove-assignee "@me"
gh issue comment <N> --body "MUSTER YIELD <runner> <ts> — lost claim race to <winning runner>"
```
then move on (a later-state label already present -- `agent:review`/`agent:done`/`agent:needs-input`
-- also needs `--remove-label agent:working` so it isn't mislabeled twice).

Count prior `MUSTER FAILED` comments (same paginated shape, filtered to `^MUSTER FAILED`, `| length`);
at the retry cap:
```
gh issue comment <N> --body "MUSTER BLOCKED <runner> <ts>
retry cap reached (2 prior failures) — needs human input before another attempt"
gh issue edit <N> --remove-label agent:working --add-label agent:needs-input
```

**Receipts** — the canonical fixed-first-line template above, `<authorizer-field>` = GitHub `<login>`.

**Done:**
```
gh issue comment <N> --body "MUSTER DONE <runner> <ts>
<disposition> <PR link or commit sha>"
gh issue edit <N> --remove-label agent:working --add-label agent:review   # disposition pr/ask
# OR, when the disposition merges directly (merge-local/merge-push/keep):
gh issue edit <N> --remove-label agent:working --add-label agent:done
gh issue close <N> --comment "closed by muster sprint (<runner>)"
```

**Blocked/Human-hold:** `<question>` may carry unescaped quotes/backticks/`$(...)` -- write it to a
scratch file with your file-write tool (not shell `echo`/`printf`) and pass `--body-file`:
```
# write "MUSTER BLOCKED <runner> <ts>\n<question>" to <bodyfile>, then:
gh issue comment <N> --body-file <bodyfile>
gh issue edit <N> --remove-label agent:working --add-label agent:needs-input
```
Human-hold reuses the same label and hostile-quoting handling, adding `authorizer=<login>`:
```
# write "MUSTER HUMAN-HOLD <runner> <ts> authorizer=<login>\n<question>" to <bodyfile>, then:
gh issue comment <N> --body-file <bodyfile>
gh issue edit <N> --remove-label agent:working --add-label agent:needs-input
```
`<login>` must personally answer. **Validate** (canonical rule above):
```
gh api repos/{owner}/{repo}/collaborators/{login}
```
404: fall back to the repo owner (`gh repo view --json owner --jq .owner.login`).

**Resume scan** (one unordered pass):
```
gh issue list --label agent:needs-input --state open --json number,comments
```
Latest `MUSTER BLOCKED`/`MUSTER HUMAN-HOLD` comment decides; HUMAN-HOLD checks `.user.login` against
`authorizer=<login>` (inverse of the CLAIMED identity problem: BODY token authoritative there, AUTHOR's
login here, since a human replies under their own account). Once answered: re-claim (`--remove-label
agent:needs-input --add-label agent:working`, then `MUSTER CLAIMED ... — resumed`) -- that comment is
the new window floor.

**Failed:** revert to claimable, unless the retry cap already redirected:
```
# write "MUSTER FAILED <runner> <ts> attempt <n>\n<reason>" to <bodyfile>, then:
gh issue comment <N> --body-file <bodyfile>
gh issue edit <N> --remove-assignee "@me" --remove-label agent:working --add-label agent:todo
```

**Ledger** — one pinned issue, bootstrap once:
```
gh issue list --label muster:ledger --state open --json number --jq '.[0].number'
# if empty:
gh issue create --title "MUSTER Coordination Ledger" --label muster:ledger \
  --body "One comment per runner, edited in place: last-seen, last item, result."
gh issue pin <ledgerNum>
```
Each cycle, find-then-edit (or create), same quoting handling as above:
```
gh issue view <ledgerNum> --json comments \
  --jq '.comments[] | select(.body | startswith("MUSTER LEDGER <runner> ")) | .id'
# write "MUSTER LEDGER <runner> <ts>\nlast item: <N or item text>\nresult: <claimed|done|blocked|human-hold|failed|idle>" to <bodyfile>, then:
gh api -X PATCH repos/{owner}/{repo}/issues/comments/<commentId> -F body=@<bodyfile>   # found
gh issue comment <ledgerNum> --body-file <bodyfile>                                    # not found
```

## Binding B — backlog.md

Extends `{key: value}` (`src/sprint-waves.js`) -- unknown keys pass through harmlessly:
`{claimed:}`/`{blocked:}`/`{human-hold:}` parse and strip cleanly, wave computation unaffected.

**Coordination is orchestrator-level** — only the top-level `/muster:sprint` driver reads/writes the
`{claimed:}`/`{blocked:}`/`{human-hold:}`/`{attempts:}` annotations and STATE's `## Coordination`
section; per-item worktree runners touch neither. The driver writes `{claimed:}` before dispatching
that item's worktree runner (subagent type `muster-runner`, else the generic-subagent fallback), then
transcribes the runner's outcome into the DONE/BLOCKED/HUMAN-HOLD/FAILED receipt and ledger once the
wave completes.

- **Claim** — append `{claimed: <runner>@<ts>}`; claim-then-verify per the canonical cooperative-model
  rule above. Your own prior annotation is a no-op resume (e.g. after a restart).
- **Receipts + ledger** live in STATE's `## Coordination` section, one line per change:
  ```
  CLAIMED <item-id> <runner> <ts>
  DONE <item-id> <runner> <ts> <disposition>
  BLOCKED <item-id> <runner> <ts> <question>
  HUMAN-HOLD <item-id> <runner> <ts> authorizer=<human> <question>
  FAILED <item-id> <runner> <ts> <reason>
  IDLE <runner> <ts> — nothing claimable
  LEDGER <runner> last-seen=<ts> last-item=<item-id> result=<claimed|done|blocked|human-hold|failed|idle>
  ```
- **Blocked/Human-hold→resume** — append `{blocked: <slug>}` or `{human-hold: <slug>}` replacing
  `{claimed:}`, with the matching receipt. Resume scan (one unordered pass):
  - `{blocked: <slug>}`: an `ANSWER <slug>: <text>` STATE line newer than the matching receipt, any
    author -- replace with `{claimed: <runner>@<ts>}` and resume.
  - `{human-hold: <slug>}`: the canonical unauthenticated-channel case (a plain STATE line can't
    authenticate its author) -- ATTENDED-only; an UNATTENDED runner permanently parks it.
- **Done/Failed** — DONE: leave `{claimed:}` as a harmless audit trail. FAILED (crash/dispatch failure):
  strip `{claimed:}`, bump `{attempts: n}` (absent → `1`; else increment), write the receipt. At
  `{attempts: 2}` (the canonical retry cap): replace with `{blocked: max-retries-<item-id>}` and a
  matching `BLOCKED` receipt in place of `FAILED`. Below the cap, stays reclaimable.

## Binding C — Linear (`linear:<team key or project>`)

Live-inspected (Linear MCP), by STATUS NAME parameterized per team/project: claimable queue = an
unstarted status (default `Todo`); claim = a started status (default `In Progress`) + assignee; review
(pr/ask) = a started status (default `In Review`); done (merge-local/merge-push/keep) = the completed
status (default `Done`); BLOCKED/HUMAN-HOLD = ONE designated blocked status (default `Blocked` --
bootstrap must create it, no built-in "blocked" category exists), discriminated by the receipt's first
line, same single-status reuse as Binding A's `agent:needs-input`.

**Claim** (status flip + assignee, then the CLAIM RECEIPT -- same windowed race rule as A, via MCP):
```
save_issue({ id, state: "<working-status>", assignee: "<runner-identity>" })
save_comment({ issueId: id, body: "MUSTER CLAIMED <runner> <ts>" })
```
Window-floor query (canonical rule): `list_comments({ issueId: id, orderBy: "createdAt" })`, paginate
`cursor`/`hasNextPage` to exhaustion, MAX `createdAt` among `^MUSTER (DONE|BLOCKED|HUMAN-HOLD|FAILED)`
is the floor, keep only `^MUSTER CLAIMED` after it, identify by `<runner>` BODY token. Not yours:
```
save_issue({ id, assignee: null })
save_comment({ issueId: id, body: "MUSTER YIELD <runner> <ts> — lost claim race to <winning runner>" })
```
then move on -- `state` is single-valued (last write wins), so no "mislabeled with both states" cleanup
like Binding A. Same retry-cap check as Binding A (paginated `^MUSTER FAILED` count); at the cap:
```
save_comment({ issueId: id, body: "MUSTER BLOCKED <runner> <ts>\nretry cap reached (2 prior failures) — needs human input before another attempt" })
save_issue({ id, state: "<blocked-status>" })
```

**Receipts** — the canonical fixed-first-line template above, `<authorizer-field>` = Linear
`<displayName>` (the preflight's EXPANDS rule treats any new token here as scope-widening).

**Done:**
```
save_comment({ issueId: id, body: "MUSTER DONE <runner> <ts>\n<disposition> <PR link or commit sha>" })
save_issue({ id, state: "In Review" })   # disposition pr/ask
# OR, when the disposition merges directly (merge-local/merge-push/keep):
save_issue({ id, state: "Done" })
```

**Blocked/Human-hold:** `save_comment`'s `body` takes literal content directly (real newlines, no
escapes) -- no shell-quoting hazard Binding A has, write straight to `body`:
```
save_comment({ issueId: id, body: "MUSTER BLOCKED <runner> <ts>\n<question>" })
save_issue({ id, state: "<blocked-status>" })
# Human-hold adds authorizer, same status reuse:
save_comment({ issueId: id, body: "MUSTER HUMAN-HOLD <runner> <ts> authorizer=<displayName>\n<question>" })
save_issue({ id, state: "<blocked-status>" })
```
`<displayName>` must personally answer. **Validate** (canonical rule above; Linear has no "repo owner"
so fallback is a configured admin):
```
list_users({ query: "<name>" })
```
No match/inactive: fall back to the configured default (`isAdmin: true` member).

**Resume scan** (same rule as Binding A -- HUMAN-HOLD checks the actual MCP author against
`authorizer=<displayName>`):
```
list_issues({ team, state: "<blocked-status>" })
```
For each: `list_comments({ issueId: id, orderBy: "createdAt" })`, find the latest `MUSTER
BLOCKED`/`MUSTER HUMAN-HOLD` comment. Once answered: re-claim (`save_issue({ id, state:
"<working-status>" })` + a `MUSTER CLAIMED ... — resumed` comment) -- that comment is the new window
floor.

**Ledger** — one designated issue, per-runner comment edited in place; no MCP pin, so find-or-create
by a fixed title:
```
list_issues({ team, query: "MUSTER Coordination Ledger" })   # bootstrap: save_issue to create if absent
```
Each cycle: `list_comments({ issueId: ledgerIssue })`, filter body `startswith("MUSTER LEDGER <runner> ")`
→ found: `save_comment({ id: <foundCommentId>, body: "MUSTER LEDGER <runner> <ts>\nlast item: <id or item text>\nresult: <claimed|done|blocked|human-hold|failed|idle>" })`. Not found: the same call
omitting `id`.

**Bootstrap** (one-time, admin-only): confirm queue/working/review/done statuses exist
(`list_issue_statuses({ team })`); create ONE blocked-state status (default `Blocked`) if missing, via
Linear's UI (agents can't self-serve this); no label bootstrap; find-or-create the ledger issue by
title (above).

**Costs**: **two-queue drift** -- a THIRD backlog vs Binding B's `.muster/backlog.md`, pick one source
of truth. **MCP auth** -- confirm the connector's auth first, fail closed if unavailable (unlike
Binding A's `gh` token). **Rate limits** -- a full-thread scan every cycle is read-heavy like A; same
cadence as runner.md (15-30 min, widen if idle).

Standing-context preflight/retry cap/escalation inherit the canonical rule unchanged; same fingerprint
set as the preflight above.

## Binding D — Hermes kanban (native `kanban.db`)

Applies when the harness is Hermes Agent, not Claude Code: Hermes ships its own durable work queue in
`~/.hermes/kanban.db` (SQLite, WAL), one OS process per worker profile -- the canonical protocol is
already harness machinery, not simulated prose (docs/research/hermes.md §4, Kanban section).

**State map** (canonical state -> kanban primitive):

- **CLAIM** -> `BEGIN IMMEDIATE` inside the board's 60-second tick, promoting a `todo`/`ready` card to
  `running`, starting the profile's OS process -- the canonical native-claim compare-and-swap (no CLAIM
  COMMENT needed).
- **RECEIPTS** -> a `task_runs` row per attempt (`summary`, plus `metadata` JSON carrying
  `changed_files`/`verification`/`dependencies`/`blocked_reason`/`retry_notes`/`residual_risk`), plus
  the append-only `task_events` log (`claimed`, `heartbeat`, `reclaimed`, `crashed`,
  `protocol_violation`, `gave_up`); free-text detail rides `kanban_comment`.
- **BLOCKED** -> `kanban_block(reason, kind)` moves the card to `blocked`. `kind: needs_input` is the
  any-reply-resumes case (`kanban_comment` reply, then `kanban_unblock`); `kind: dependency`
  auto-resumes once every parent card reaches `done` (native equivalent of Binding B's `{deps:}`);
  `kind: capability`/`transient` have no analogue in A-C.
- **HUMAN-HOLD** -> same `blocked` column and `kind: needs_input`, discriminated by a `kanban_comment`
  naming the authorizer -- no per-comment authentication exists, so this is the canonical
  unauthenticated-channel case (same as B): ATTENDED-only until the board adds one.
- **DONE** -> `kanban_complete(summary, metadata, result, artifacts)`; the card lands on `done`.
- **FAILED** -> a `task_events` `gave_up` (self-reported) or `crashed` (dead-PID detection) entry
  reverts the card to `todo`; `kanban.failure_limit` is the native retry cap (consecutive spawn
  failures auto-block, no counting query needed).
- **YIELD** -> not applicable, per the canonical native-claim note (no losing claimant).
- **LEDGER** -> `kanban_heartbeat`, once per cycle per profile. `task_events` is append-only, so "one
  heartbeat" reads the most recent `heartbeat` event, not an edited row -- same semantic, different
  storage; its staleness monitor natively covers HYGIENE PREFLIGHT's 60-minute release.

**Fallback** -- applies only when `HERMES_KANBAN_TASK` is enabled; elsewhere A/B/C apply as written
above. No local Hermes install existed on the authoring machine (hermes.md's sourcing-gaps section),
so nothing below is behavior-verified live.

**Validate this binding** (described, not executed, same caveat) -- the same 3-item smoke trail as
go-backlog.md's "Validate a binding" section, in kanban primitives:
- **hello-world** -- `kanban_create` a card; confirm atomic claim to `running`, a `kanban_complete`
  call, and a `claimed`-to-`done` `task_runs`/`task_events` trail.
- **blocked→resume** -- `kanban_block(reason, kind: "needs_input")`; confirm `blocked` plus a matching
  event, then `kanban_comment` + `kanban_unblock`; confirm re-entry to `ready`/`running` ahead of a
  fresh `todo` card.
- **failed** -- kill the profile's OS process; confirm the dead-PID tick logs `crashed`, reverts to
  `todo`; repeat past `kanban.failure_limit` for auto-block.

Standing-context preflight/retry cap/escalation inherit the canonical rule unchanged (same fingerprint
set as above; escalation marker per bullet 7).
