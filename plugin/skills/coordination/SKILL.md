---
name: coordination
description: Source-agnostic multi-runner protocol -- CLAIM before work, structured RECEIPTS per state change, BLOCKED/HUMAN-HOLD->RESUME, one heartbeat LEDGER per runner. Three bindings: GitHub issues (labels + gh CLI), backlog.md (annotations + STATE), Linear (statuses + MCP). Wired in by /muster:sprint.
---

# Coordination

You are muster's cross-runner coordination protocol — keep independent runners (separate
`/muster:sprint` invocations, humans and agents alike) from doing the same item twice and from
silently going quiet when one gets stuck.

Return per-item the state it left the shared backlog/label in (claimed / done / blocked / failed) plus
the receipt(s) written — a work-cycle always ends with a receipt, even on failure.

Load this when a backlog (file, `issues:<label>`, or `linear:<team or project>`) may be worked by more
than one runner concurrently. A single-runner sprint may skip the claim/scan steps but should still
leave receipts and a ledger heartbeat for auditability. CLAIM/RECEIPTS/BLOCKED→RESUME/LEDGER is
adapted, mechanism-only, from a well-known open multi-agent coordination pattern (attribution:
`website/about/credits.md`, out of scope here).

## Core mechanism (source-agnostic)

1. **CLAIM** — before any work, atomically mark an item claimed with runner identity + timestamp; a
   claimed item is skipped by other runners. Identity reuses the invocation's existing `runId` (the
   slug already keying run STATE/scratchpad) -- no new identity infrastructure needed.
2. **RECEIPTS** — every state change leaves a structured receipt: `CLAIMED`/`DONE`/`BLOCKED(reason,
   question)`/`HUMAN-HOLD(reason, question, authorizer)`/`FAILED(reason)`/`YIELD(losing runner
   conceding a race)`/`IDLE` (nothing claimable -- folds into the LEDGER heartbeat, not a fresh line).
3. **BLOCKED/HUMAN-HOLD→RESUME** — split by WHO can clear a stalled item. **BLOCKED** (default) is
   answerable by anyone; **HUMAN-HOLD** is narrower -- only the authorizing human (external-effect
   approvals, scope changes) can answer. Both record a question; BLOCKED resumes on ANY reply,
   HUMAN-HOLD ONLY on a reply from its named authorizer -- any other is inert. Runners scan for both in
   one unordered pass; the gate is only as strong as what authenticates it -- Binding A's authorizer is
   a real GitHub login GitHub itself authenticates; Binding B has no such backing (a STATE line is just
   text) and narrows further (see its section): a HUMAN-HOLD item there cannot resume from STATE alone.
4. **LEDGER** — each runner maintains exactly ONE heartbeat entry (last seen, last item, result), edited
   in place, not a growing pile.
5. **One item per claim cycle** — claim, work, leave a receipt, THEN look for the next item.
6. **STANDING-CONTEXT PREFLIGHT** — once per cycle, before anything else, a runner checks whether the
   protocol text it is running on has drifted from the repo's current tip, against a fingerprint recorded
   at first read. See "Standing-context preflight" below for the fingerprint set, commands, and the
   deterministic confined-vs-expands rule.
7. **HYGIENE PREFLIGHT** — once per cycle, alongside the preflight above and before CLAIM, run `node
   src/cli.js hygiene --reap`: reaps a zombie provider CLI process (parent dead/1), auto-releases a
   claim whose heartbeat exceeds 60 minutes (a dead runner's stranded `{claimed:}`), and offers a
   stale-worktree sweep past 10 live worktrees, as a report for a human. `src/hygiene.js` is the source
   of truth; this bullet only renders it.

An **escalation** (spec-gate/fix-loop cap) is not a new receipt type: a `FAILED` receipt plus the
item-level escalated-marker -- Binding B's `{escalated: <runId or date>}`, Binding A's move to
`agent:needs-input` with a question comment, Binding C's move to its blocked status -- so a later scan
relies on that marker alone.

## Standing-context preflight

Compare the commit each in-scope file/path was at when this session first read it (recorded once, at
first read) against its CURRENT commit. The fingerprint set is every file a runner's behavior is
actually bound by, not just this skill and its callers -- drift in the hook layer or go.md's own
forbidden-action list is exactly the silent scope-widening this preflight exists to catch. The set
names LIVE behavior files, not legacy-alias redirects: `plugin/commands/sprint.md`/`autopilot.md` are
now minimal stubs that only read-and-execute `go-backlog.md`/`go.md` and no longer carry the behavior
they're named for, so this preflight watches their live targets instead:
`plugin/skills/coordination/SKILL.md`, `plugin/commands/go-backlog.md`, `plugin/commands/go.md`,
`plugin/commands/runner.md`, `plugin/hooks/`. One `git log` call over the whole set (a single
fingerprint hash -- the latest commit touching ANY of these paths):
```
git log -1 --format=%h -- plugin/skills/coordination/SKILL.md plugin/commands/go-backlog.md \
  plugin/commands/go.md plugin/commands/runner.md plugin/hooks/
```
No change in hash: proceed. A changed hash: `git diff <recorded-hash> <current-hash> -- <same paths>`,
then classify deterministically -- a named file+pattern list, not judgment:

- **EXPANDS** (not silently adopted -- HUMAN-HOLD it, citing the file(s) and old/new hash; the
  authorizer is whoever owns this repo's muster configuration) iff the diff touches ANY of: a
  `forbiddenActions` entry, a `fences` block, `action-guard` matching logic, anything under
  `plugin/hooks/`, a new RECEIPTS-enum token (`CLAIMED`/`DONE`/`BLOCKED`/`HUMAN-HOLD`/`FAILED`/`YIELD`/
  `IDLE`/`LEDGER`), or a new resume rule (who/what can clear a held/blocked item beyond the existing
  BLOCKED-any-reply / HUMAN-HOLD-named-authorizer split).
- **CONFINED** (reload the changed file(s), proceed under them for the rest of this cycle, no approval
  needed) -- everything else: a clarification, a new example, a tightened description of a rule the
  runner was already bound by.

Ambiguous? Say so in the HUMAN-HOLD question rather than guess -- a runner cannot authorize its own
scope expansion. Composes with an item's resume/claim-window mechanics unchanged -- a version mismatch
is a property of the RUNNER's session, not the item's claim state.

## Binding A — GitHub issues (`issues:<label>`)

States are labels on the issue: `agent:todo` → `agent:working` → `agent:review` (PR open, awaiting
merge) or `agent:done` (merged). `agent:needs-input` is the BLOCKED/HUMAN-HOLD side-state (resumes back
to `agent:working`); `agent:todo` is also the FAILED landing state -- retry-eligible, unassigned.

**Bootstrap** (one-time per repo, idempotent, safe to re-run every sprint start):
```
gh label create agent:todo --color ededed --force
gh label create agent:working --color fbca04 --force
gh label create agent:review --color 0e8a16 --force
gh label create agent:done --color 5319e7 --force
gh label create agent:needs-input --color d93f0b --force
gh label create muster:ledger --color 1d76db --force
```
`--force` updates color/description instead of erroring on an existing label, so this runs
unconditionally.

**Claim** (assign + label flip, both before work starts -- assignment alone is not the lock):
```
gh issue edit <N> --add-assignee "@me" --remove-label agent:todo --add-label agent:working
gh issue comment <N> --body "MUSTER CLAIMED <runner> <ts>"
```
GitHub allows multiple assignees, so two runners racing the same issue can BOTH land as assignee --
assignee-based detection fails open. The CLAIM COMMENT is the actual lock, scoped to the **current claim
window**: comments since the last terminal receipt (`MUSTER DONE`/`BLOCKED`/`HUMAN-HOLD`/`FAILED` --
deliberately NOT `YIELD`, else a loser's yield before the winner's re-read would floor the winner's own
claim out of its window). Without that floor, a fresh claim after a retry/resume compares against a
stale prior-cycle claim, always earlier -- every legitimate reclaimer "loses" and the item strands
unowned. `src/coordination.js` is the source of truth for this race rule and the HUMAN-HOLD resume
gate. Re-read every comment (paginated -- truncating at 30 is a false read), find the window floor,
rank only the `CLAIMED` comments inside it by server `created_at`, identifying each by the `<runner>`
token in the comment BODY, not the author's `login` (runners sharing one GitHub token are otherwise
indistinguishable):
```
gh api repos/{owner}/{repo}/issues/<N>/comments --paginate --slurp --jq '
  flatten
  | ([.[] | select(.body | test("^MUSTER (DONE|BLOCKED|HUMAN-HOLD|FAILED)")) | .created_at] | sort | last // "") as $windowStart
  | [.[] | select(.body | test("^MUSTER CLAIMED")) | select(.created_at > $windowStart)
     | {runner: (.body | capture("^MUSTER CLAIMED (?<r>[^ ]+)").r), created_at}]
  | sort_by(.created_at)'
```
Earliest `created_at` wins (server-ordered, a real tiebreak for near-simultaneous claims). Not yours?
You lost the race:
```
gh issue edit <N> --remove-assignee "@me"
gh issue comment <N> --body "MUSTER YIELD <runner> <ts> — lost claim race to <winning runner>"
```
then move to the next `agent:todo` issue -- leave the label alone. Exception: a later-state label
already present (`agent:review`/`agent:done`/`agent:needs-input` -- your claim-time label add landed
after the winner moved past that state) also needs `gh issue edit <N> --remove-label agent:working` so
the issue isn't mislabeled with both states.

Winner: before starting work, count prior `MUSTER FAILED` receipts across the WHOLE history
(cumulative, not windowed), paginated:
```
gh api repos/{owner}/{repo}/issues/<N>/comments --paginate --slurp --jq \
  'flatten | [.[] | select(.body | test("^MUSTER FAILED"))] | length'
```
At 2 prior failures, redirect to needs-input instead of another attempt:
```
gh issue comment <N> --body "MUSTER BLOCKED <runner> <ts>
retry cap reached (2 prior failures) — needs human input before another attempt"
gh issue edit <N> --remove-label agent:working --add-label agent:needs-input
```
Fewer than 2: proceed with work as normal.

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

**Blocked:** `<question>` is free text (may carry unescaped quotes/backticks/`$(...)`) -- write it to a
scratch file with your file-write tool (not shell `echo`/`printf`) and pass `--body-file` instead of
inlining `--body "..."`, so hostile text can't break shell quoting:
```
# write "MUSTER BLOCKED <runner> <ts>\n<question>" to <bodyfile> with your file-write tool, then:
gh issue comment <N> --body-file <bodyfile>
gh issue edit <N> --remove-label agent:working --add-label agent:needs-input
```
**Human-hold:** the narrower BLOCKED variant -- raise it when only one specific human can
authoritatively answer (external-effect approval, scope change, spend), not "any" replier. Reuses the
SAME `agent:needs-input` label (the receipt body alone discriminates BLOCKED from HUMAN-HOLD; a second
label would cost a bootstrap + add/remove pair for a distinction already free). Same hostile-quoting
handling as BLOCKED:
```
# write "MUSTER HUMAN-HOLD <runner> <ts> authorizer=<login>\n<question>" to <bodyfile>, then:
gh issue comment <N> --body-file <bodyfile>
gh issue edit <N> --remove-label agent:working --add-label agent:needs-input
```
`<login>` is the GitHub login who must personally answer -- the repo owner unless named otherwise.
**Validate before writing** -- adversarial text must not name an arbitrary login and have it accepted:
```
gh api repos/{owner}/{repo}/collaborators/{login}
```
404 (not a collaborator): fall back to the repo owner (`gh repo view --json owner --jq .owner.login`).
Only a 2xx-confirmed login may be recorded as `authorizer=<login>`.

**Resume scan** (before claiming anything new -- one unordered pass over every `agent:needs-input`
issue; its own latest receipt decides which rule applies):
```
gh issue list --label agent:needs-input --state open --json number,comments
```
Find the latest `MUSTER BLOCKED`/`MUSTER HUMAN-HOLD` comment (later one decides).
- **BLOCKED**: any LATER non-`MUSTER `-prefixed comment (any human) answers it.
- **HUMAN-HOLD**: a later non-`MUSTER `-prefixed comment only counts if its author's `.user.login`
  equals the recorded `authorizer=<login>` (same listing, no extra call). Any other reply is inert.
  (Inverse of the CLAIMED identity problem: there the BODY token was authoritative since runners share
  a token; here the AUTHOR's login is, since a human replies under their own account.)

Either way, once answered/authorized: re-claim ahead of any fresh `agent:todo` item (`--remove-label
agent:needs-input --add-label agent:working`, then `MUSTER CLAIMED` noting the resume) -- subject to
the same windowed race check as any claim, since that `MUSTER BLOCKED`/`HUMAN-HOLD` comment is itself
the window floor.

**Failed** (revert to claimable, always leaving a record, unless the retry cap already redirected to
`agent:needs-input`): `<reason>` is free text -- same hostile-quoting risk as `<question>`:
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
Each cycle, find-then-edit (or first-create) your own comment (same hostile-quoting risk as above --
write to a scratch file, reference via `@<bodyfile>` or `--body-file`):
```
gh issue view <ledgerNum> --json comments \
  --jq '.comments[] | select(.body | startswith("MUSTER LEDGER <runner> ")) | .id'
# write "MUSTER LEDGER <runner> <ts>\nlast item: <N or item text>\nresult: <claimed|done|blocked|human-hold|failed|idle>" to <bodyfile>, then:
# found -> edit in place:
gh api -X PATCH repos/{owner}/{repo}/issues/comments/<commentId> -F body=@<bodyfile>
# not found -> first heartbeat:
gh issue comment <ledgerNum> --body-file <bodyfile>
```
Idle cycle: `last item: none — nothing claimable` / `result: idle` in this SAME comment -- same `IDLE
<runner> <ts> — nothing claimable` heartbeat Binding B writes, wrapped in this binding's template.

## Binding B — backlog.md

Extends the existing `{key: value}` grammar (`src/sprint-waves.js`) — its generic annotation strip
passes unknown keys through harmlessly: `{claimed:}`/`{blocked:}`/`{human-hold:}` parse and strip
cleanly, leaving wave computation and the audit dedupe/assess rule unaffected. `{human-hold:}` is a
distinct key (unlike Binding A's reused label) since annotations cost nothing extra here. Verified
live: `node src/cli.js sprint-waves` on a line with `{id}`/`{deps}` plus `{claimed: x@y}` returns
`ok:true` with the correct wave and the annotation stripped from `items[...].text`.

**Coordination is orchestrator-level** — only the top-level `/muster:sprint` driver reads/writes the
`{claimed:}`/`{blocked:}`/`{human-hold:}`/`{attempts:}` annotations and the STATE `## Coordination`
section; per-item worktree runners touch neither. The driver writes each item's `{claimed:}`
receipt itself before dispatching that item's worktree runner (subagent type `muster-runner` when the
session registry carries it, else the generic-subagent fallback), then transcribes the runner's
returned outcome, via the existing return contract, into its DONE/BLOCKED/HUMAN-HOLD/FAILED receipt and
the ledger once the wave completes.

- **Claim** — append `{claimed: <runner>@<ts>}` before starting work. Scan unchecked items top to
  bottom; skip any already `{claimed:}` by a DIFFERENT runner (your own prior annotation is a no-op
  resume, e.g. after a restart). Claim-then-verify: re-read right after writing; another runner's
  `{claimed:}` instead of/alongside yours means you lost -- move on. No true compare-and-swap in
  plain-file coordination; assumes cooperative runners, not adversarial concurrency (a documented
  limit).
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
  `LEDGER` is edited in place (find-and-replace your prior `LEDGER <runner> ...` OR `IDLE <runner> ...`
  line -- one entry, not appended twice). **IDLE** is that same slot: nothing claimable means no item
  to annotate, so the heartbeat reads `IDLE <runner> <ts> — nothing claimable` instead of the usual
  fields.
- **Blocked/Human-hold→resume** — append `{blocked: <slug>}` (anyone answers) or `{human-hold: <slug>}`
  (only the named authorizer -- external-effect approvals, scope changes, spend) replacing `{claimed:}`,
  and write the matching receipt with the question (`HUMAN-HOLD` also records `authorizer=<human>`).
  Resume scan (one unordered pass over every `{blocked:}`/`{human-hold:}` item):
  - `{blocked: <slug>}`: search STATE for an `ANSWER <slug>: <text>` line newer than the matching
    `BLOCKED ... <slug>` receipt -- any author counts. Found: replace with `{claimed: <runner>@<ts>}`
    and resume.
  - `{human-hold: <slug>}`: a written `ANSWER <slug> by <authorizer>: <text>` STATE line is **NOT
    sufficient on its own** -- a plain-file line can't authenticate who wrote it (any runner with STATE
    write access could self-approve its own hold, defeating the named-authorizer gate). Resume instead
    requires an **ATTENDED** session: present the question via **AskUserQuestion**; only AFTER the human
    answers does the orchestrator itself, exclusively -- not the runner alone, not by pre-writing the
    `ANSWER` line -- write it to STATE and replace `{human-hold: <slug>}` with `{claimed: <runner>@<ts>}`. An
    **UNATTENDED** runner (`/muster:runner`, or Routine mode) has no session to ask, so every
    `{human-hold:}` item is **permanently parked** for that cycle -- skip it, move on. Binding A's
    HUMAN-HOLD resume is unaffected: its `authorizer=<login>` is already GitHub-authenticated, which a
    plain STATE line never is.
- **Done/Failed** — DONE: leave `{claimed:}` as a harmless audit trail. FAILED (crash/dispatch failure,
  not an escalation): strip `{claimed:}`, bump `{attempts: n}` (absent → `1`; else increment) across
  runners/restarts, write the `FAILED` receipt. At `{attempts: 2}`: replace with `{blocked:
  max-retries-<item-id>}` (item-id keeps the slug unique) and a `BLOCKED <item-id> <runner> <ts> retry
  cap reached (2 prior failures) — needs human input` receipt in place of `FAILED` -- re-enters the pool
  only via the normal resume scan. Below the cap, stays reclaimable, `{attempts:}` intact.

## Binding C — Linear (`linear:<team key or project>`)

Inspected live against a trial workspace (Linear MCP: `list_teams`/`list_issue_statuses`/`list_users`):
one team, statuses `Backlog`(backlog) → `Todo`(unstarted) → `In Progress`/`In Review`(started) →
`Done`(completed) → `Canceled`(canceled), plus `Duplicate` -- no `Blocked`/agent-queue status exists
yet. The mapping below is by STATUS NAME, parameterized per team/project -- derive names from the
target workspace at bind time.

States map onto Linear's status-type categories: claimable queue = a designated unstarted status
(default `Todo`); claim = a started status (default `In Progress`) + assignee; review (disposition
pr/ask) = a started status (default `In Review`, mirrors Binding A's `agent:review`); done
(merge-local/merge-push/keep) = the completed status (default `Done`); BLOCKED/HUMAN-HOLD = ONE
designated blocked status (default `Blocked` -- Linear has no built-in "blocked" category, so bootstrap
must create it), carrying both plus the escalated-marker, discriminated by the comment receipt's first
line -- same single-status reuse reasoning as Binding A's `agent:needs-input` label.

**Claim** (status flip + assignee, then the actual lock):
```
save_issue({ id, state: "<working-status>", assignee: "<runner-identity>" })
save_comment({ issueId: id, body: "MUSTER CLAIMED <runner> <ts>" })
```
Linear's single `state` field can't hold two values like GitHub's label SET, but assignee+state is
still not a lock (two runners can both read pre-claim state and both write before either is visible to
the other). THE CLAIM COMMENT IS STILL THE LOCK -- same **current claim window** rule as Binding A
(window floor = last terminal receipt, NOT `YIELD`; earliest `CLAIMED` after the floor wins,
`src/coordination.js` is the source of truth), via MCP instead of `gh`/jq: `list_comments({ issueId:
id, orderBy: "createdAt" })`, paginate on `cursor`/`hasNextPage` to exhaustion, take the MAX `createdAt`
among `^MUSTER (DONE|BLOCKED|HUMAN-HOLD|FAILED)` comments as the floor, keep only `^MUSTER CLAIMED`
after it, sort ascending, identify by the `<runner>` BODY token (not the actual Linear author -- one
MCP session/account is shared across runners). Not yours:
```
save_issue({ id, assignee: null })
save_comment({ issueId: id, body: "MUSTER YIELD <runner> <ts> — lost claim race to <winning runner>" })
```
then move to the next queue item -- leave `state` alone. Linear's `state` is single-valued (last write
wins), so unlike Binding A there's no "left mislabeled with both states" cleanup step.

Same retry-cap check as Binding A (count prior `MUSTER FAILED` comments across the WHOLE history,
cumulative not windowed, via the same paginated call filtered to `^MUSTER FAILED`). At 2 prior
failures, redirect to the blocked status:
```
save_comment({ issueId: id, body: "MUSTER BLOCKED <runner> <ts>\nretry cap reached (2 prior failures) — needs human input before another attempt" })
save_issue({ id, state: "<blocked-status>" })
```
Fewer than 2: proceed with work as normal.

**Receipts** — same fixed-first-line enum as Binding A/B, unchanged (the standing-context preflight's
EXPANDS rule already treats any new token here as scope-widening):
```
MUSTER CLAIMED <runner> <ts>
MUSTER DONE <runner> <ts>                (+ disposition and PR/commit link)
MUSTER BLOCKED <runner> <ts>             (+ the question)
MUSTER HUMAN-HOLD <runner> <ts> authorizer=<displayName>  (+ the question)
MUSTER FAILED <runner> <ts> attempt <n>  (+ the reason)
MUSTER YIELD <runner> <ts>               (+ which claim comment won the race)
```

**Done:**
```
save_comment({ issueId: id, body: "MUSTER DONE <runner> <ts>\n<disposition> <PR link or commit sha>" })
save_issue({ id, state: "In Review" })   # disposition pr/ask
# OR, when the disposition merges directly (merge-local/merge-push/keep):
save_issue({ id, state: "Done" })
```

**Blocked:** `<question>` may carry markdown/backticks/etc, but `save_comment`'s `body` takes literal
content directly (real newlines, no escape sequences) -- no shell-quoting hazard the way Binding A's
`gh --body` needs a scratch file, so write straight to `body`:
```
save_comment({ issueId: id, body: "MUSTER BLOCKED <runner> <ts>\n<question>" })
save_issue({ id, state: "<blocked-status>" })
```
**Human-hold:** same status-reuse reasoning -- one blocked status carries BLOCKED/HUMAN-HOLD/escalated,
discriminated by receipt body:
```
save_comment({ issueId: id, body: "MUSTER HUMAN-HOLD <runner> <ts> authorizer=<displayName>\n<question>" })
save_issue({ id, state: "<blocked-status>" })
```
`<displayName>` is the Linear user who must personally answer -- the workspace's default authorizer
unless named otherwise. **Validate before writing** (Binding A's `collaborators/{login}` analogue;
Linear has no single "repo owner" so the fallback is a configured admin):
```
list_users({ query: "<name>" })
```
No match/inactive → invalid: fall back to the configured default (`isAdmin: true` member). Only a
`list_users`-confirmed active identity may be recorded as `authorizer=<displayName>`.

**Resume scan** (one unordered pass, same rule as Binding A):
```
list_issues({ team, state: "<blocked-status>" })
```
For each: `list_comments({ issueId: id, orderBy: "createdAt" })`, find the LATEST `MUSTER BLOCKED`/
`MUSTER HUMAN-HOLD` comment. **BLOCKED**: any LATER non-`MUSTER `-prefixed comment (any author) answers
it. **HUMAN-HOLD**: only if its actual author (Linear-authenticated) matches the recorded
`authorizer=<displayName>` -- any other author's reply is inert.

Once answered/authorized: re-claim ahead of any fresh queue item (`save_issue({ id, state:
"<working-status>" })` + a `MUSTER CLAIMED ... — resumed` comment), subject to the same windowed race
check -- the `MUSTER BLOCKED`/`HUMAN-HOLD` comment is itself the new window floor.

**Ledger** — one designated issue, per-runner comment edited in place. No pin capability via MCP
(unlike `gh issue pin`), so find-or-create by an exact, fixed title:
```
list_issues({ team, query: "MUSTER Coordination Ledger" })   # bootstrap: save_issue to create if absent
```
Each cycle: `list_comments({ issueId: ledgerIssue })`, filter body `startswith("MUSTER LEDGER <runner> ")`
→ found: `save_comment({ id: <foundCommentId>, body: "MUSTER LEDGER <runner> <ts>\nlast item: <id or item text>\nresult: <claimed|done|blocked|human-hold|failed|idle>" })` (`id` updates rather than creating,
Binding A's `gh api -X PATCH` equivalent). Not found: the same call omitting `id`. Idle cycle: `last
item: none — nothing claimable` / `result: idle`, exactly Binding A's convention.

**Bootstrap** (one-time per team/workspace -- Linear workflow states are admin-configured, no MCP tool
creates one, needs a human with admin): (1) confirm queue/working/review/done statuses exist
(`list_issue_statuses({ team })` -- every team ships these by default, no action unless names differ);
(2) create ONE blocked-state status (default `Blocked`) if missing, via Linear's UI (any category
works, keyed off NAME) -- agents can't self-serve this, ask the admin once; (3) no label bootstrap --
Binding C adds zero labels; (4) ledger issue -- find-or-create by title (above).

**Costs** (honest, not hidden): **two-queue drift** -- a THIRD, independent backlog (Linear's queue vs
Binding B's `.muster/backlog.md`); running both against the same work risks a double-worked item, pick
one source of truth. **MCP auth in headless runners** -- the Linear connector's auth in an unattended
runtime isn't guaranteed the way Binding A's `gh` token is; confirm first, fail closed if unavailable.
**Rate limits** -- Linear is rate/complexity-limited; a full-thread resume scan every cycle is the same
read-heavy pattern as Binding A -- same cadence guidance as runner.md (15-30 min, widen if idle).

**Standing-context preflight / retry cap / escalation** — inherits the core mechanism unchanged; the
fingerprint set (SKILL.md/go-backlog.md/go.md/runner.md/hooks/) already covers this binding's own text,
no new file to watch. Only delta: the escalation marker is a move to the blocked status with a question
comment, discriminated from BLOCKED/HUMAN-HOLD purely by receipt body -- identical reuse reasoning.
