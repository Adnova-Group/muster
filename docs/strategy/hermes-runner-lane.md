# Hermes-hosted runner lane — a bounded spike

Design + capability probe for `hermes-runner-lane-spike`, the "worth a shot" hedge the
maintainer greenlit alongside the STAY-A-LAYER verdict
(`docs/strategy/native-delegation.md` Part A: "Stay a judgment layer. Do NOT build a
custom harness. Confidence: HIGH (~85%)." [src: nd-verdict]). This document is the design
of an **optional muster runner lane** on Hermes — never a replacement for the layer
strategy — plus the one piece of it that is real, testable code, plus an honest capability
probe result. Evidence tags follow `docs/research/hermes.md`'s convention: [DOCUMENTED] =
stated in a cited primary source, [INFERRED] = reasoned from documented facts,
[JUDGMENT] = this document's own strategic call, not asserted by a source.

## 0. Capability probe (re-run for this spike)

Re-checked live on this machine, 2026-07-17, same checks `docs/research/hermes.md`'s
research pass ran: no `~/.hermes` directory, no `hermes` binary on `PATH`. **No live Hermes
host is reachable from this repo's tooling.** Everything below is therefore **designed +
probed, not executed** — per the dispatching brief, that is the honest, valid outcome for
this bounded spike, and this document does not fabricate a live run anywhere. The one
concrete artifact that could be built and verified without a host — a pure translation
function plus fixture tests — was built and is green (§4).

## 1. Framing: optional lane, not a replacement

**This is not a fourth harness muster is porting to, and it does not change anything about
the layer strategy.** `native-delegation.md` Part A's verdict stands as written: muster
stays a judgment layer riding native harness primitives on Claude Code, Codex, and Cowork;
a custom muster-owned harness is explicitly rejected [src: nd-verdict]. The "middle path"
section carves out exactly one exception to "no new substrate": *"an optional
Hermes-hosted (or Agents-SDK) runner lane added beside the layer strategy, never as a
replacement"* [src: nd-middle]. This document is that carve-out, elaborated — it answers
"could a thin lane exist" for one candidate substrate; it does not conclude muster should
ship one, does not touch any of muster's shipped Claude Code / Codex / Cowork surfaces, and
adds zero wired code (§4 explains exactly how the one artifact this spike ships stays
inert). The **only** thing that changes is: this document now exists, plus one pure,
unwired, unit-tested function.

Relationship to adjacent backlog items: `hermes-kanban-binding` (execution backlog #3 in
`native-delegation.md`) scopes a *formal* Binding D spec — CLAIM/RECEIPT/BLOCKED/LEDGER
mapped onto specific kanban columns/annotations/`task_event`s, as a fourth coordination
binding beside GitHub issues, `backlog.md`, and Linear. This spike's kanban usage (§3) is
illustrative — it shows the shape a Binding D would take inside a worked example — but does
not itself constitute that binding spec; the two items are complementary, not duplicative.
`agents-sdk-runner-lane` (execution backlog #9) is this spike's twin for the other
substrate; §5 below folds its one-paragraph comparison in here per the dispatching brief
rather than standing up a second spike document.

## 2. Why Hermes is primary (closest-fit, recap)

Three of Hermes's native surfaces are the reason it, not the Agents SDK, is the substrate
this spike designs against [src: hermes-port]:

1. **Skills port near-verbatim** — Hermes speaks agentskills.io `SKILL.md`, reads
   `AGENTS.md`/`CLAUDE.md`, can consume muster's skills via an external dir or a GitHub tap
   [src: hermes-skills].
2. **Hooks port near-verbatim** — shell hooks take JSON on stdin/stdout in any language;
   `pre_tool_call` is a genuine veto point [src: hermes-hooks].
3. **Kanban IS muster's coordination protocol, natively** — atomic claims, structured
   `task_runs` handoff metadata, `kanban_block(kind)` with auto-resume, heartbeats, an
   append-only `task_events` log [src: hermes-kanban].

The Agents SDK gets none of these three for free (§5) — it is a framework to build an inner
loop on, not an installed harness with a coordination board and a hook contract already
speaking muster's dialect.

## 3. The lane design: three legs

### Leg 1 — `delegate_task` for wave dispatch

A muster run maps to one kanban card, claimed by an orchestrator-role worker (a full
`hermes -p <profile> chat -q` process) [src: hermes-kanban]. Muster's own wave computation
(`src/wave.js` / `src/sprint-waves.js` — unchanged, still muster's judgment) produces the
dependency-ordered item groups exactly as it does on every other harness. For each wave, the
orchestrator issues one `delegate_task(tasks=[...])` batch call — Hermes's parallel-batch
form, default 3 concurrent children, each a **fresh context** (zero parent history; goal and
context must carry everything the child needs) [src: hermes-delegation]. This is the same
"in-session waves" fit `native-delegation.md`'s Part B table already scored **Good** for
Hermes (`max_spawn_depth: 2` for wave-of-waves) [src: hermes-port-table]. Only the parent
sees each child's final summary — nothing else crosses back automatically
[src: hermes-delegation], so the orchestrator (muster's glue, still muster-owned judgment)
is responsible for turning those summaries into the kanban receipts leg below.

### Leg 2 — kanban for coordination state

The durable ledger lives in `~/.hermes/kanban.db`: statuses
`triage|todo|ready|running|blocked|done|archived`, an append-only `task_events` log
(claimed, heartbeat, reclaimed, crashed, protocol_violation, gave_up, …), and per-attempt
`task_runs` rows carrying `summary` (human) plus `metadata` JSON with convention keys
`changed_files`, `verification`, `dependencies`, `blocked_reason`, `retry_notes`,
`residual_risk` [src: hermes-kanban]. That metadata shape already carries muster's
CLAIM/RECEIPT/BLOCKED/LEDGER grammar's payload almost field-for-field — `changed_files` +
`verification` is muster's RECEIPT, `blocked_reason` (typed `dependency|needs_input|
capability|transient` via `kanban_block`) is muster's BLOCKED, the `task_events` log is the
LEDGER. The orchestrator writes each wave's outcome as a `kanban_comment` (the documented
inter-agent protocol [src: hermes-kanban]) plus, at run end, a `kanban_complete(summary,
metadata, result, artifacts)` call carrying the full run's receipts.

### Leg 3 — `pre_tool_call` as the action-fence analog

Hermes's approval surface has two independent hard-deny paths muster's fence design should
use together, not either/or: **(a)** `pre_tool_call` hooks, which can return
`{"action": "block", "message": ...}` to veto a specific call
[src: hermes-hooks] — the dynamic, run-scoped leg, mirroring muster's own
`.muster/run-active` + `.muster/forbidden-actions` file-based signal exactly as the Claude
Code fence already reads it (`plugin/hooks/pre-tool-use.js`); and **(b)**
`approvals.deny: [globs]`, unconditional blocks that survive even `yolo`/`off` mode
[src: hermes-approval] — a static, config-level belt-and-suspenders layer independent of
any per-run state. Both matter because Hermes's *general* approval posture is
dangerous-pattern interception (permissive by default), not an allowlist
[src: hermes-approval]; muster's fence must not assume Hermes denies anything by default —
it has to actively install both legs.

§4 below is the one piece of leg 3 that is real code: a pure function translating the same
classification `plugin/hooks/action-guard.js` already computes into Hermes's canonical
`pre_tool_call` response shape.

## 4. What's actually built (thin, unwired scaffold)

`docs/strategy/hermes-lane/hermes-action-fence.js` exports
`mapActionFenceToHermes(payload, forbiddenClasses, mode)`, which:

- reuses `classifyAction` from `plugin/hooks/action-guard.js` (same sibling-import
  convention `pre-tool-use.js` already uses — no re-implementation, no drift risk between
  the Claude Code and Hermes classifications);
- returns `{action: "block", message: "..."}` — the one `pre_tool_call` response shape
  every section of `hermes.md` agrees on: section 7 (Hooks) documents it as pre_tool_call's
  own canonical veto [src: hermes-hooks]. (Section 7's prose separately notes
  Claude-Code-Stop-shape acceptance for "shell-hook block responses" generally, and
  sections 10/11 state more specifically that pre_tool_call block hooks accept it too — the
  two passages aren't fully reconciled within `hermes.md` itself. This module sidesteps that
  ambiguity by emitting only the shape confirmed under every reading.) — for a call that
  classifies into a forbidden class and `mode` is anything other than `"off"`/`"warn"`
  (including an unrecognized value — fail-CLOSED, mirroring
  `plugin/hooks/pre-tool-use.js`'s own `MUSTER_ACTION_GUARD` handling: only `"warn"` and
  `"off"` are special-cased, everything else denies);
- returns `null` (no block) for `"off"`, for a non-matching class, for a non-array/missing
  `forbiddenClasses`, and — **documented port gap** — for `"warn"`, because `pre_tool_call`
  has no allow-with-context response; the warn text would need to ride `pre_llm_call`'s
  `{"context": ...}` injection instead [src: hermes-hooks], which this bounded spike does
  not build.

This module deliberately lives under `docs/strategy/`, not `plugin/hooks/`: `plugin/` is
muster's *published* Claude Code plugin surface (npm `files`, pinned byte-identical by
`test/claude-parity.test.js`), and shipping inert spike code inside it would be exactly the
kind of bloat this spike's own dispatching context ("faster and less bloated") argues
against. It is **not wired into `plugin/hooks/hooks.json`** (that file wires Claude Code
events only, and Claude Code never reads this file) and is **not imported by any shipped
dispatch path** (`src/cli.js`, `src/harness.js`, or any other production module). It exists
only so a real future Hermes host could point its own `config.yaml` `hooks:` block at a
script built on this shape — today it is inert, reachable only from its own test file. That
inertness is deliberate: it is how this spike avoids being a creeping replacement while
still shipping something a reviewer can run.

Tests: `test/hermes-lane.test.js`, 10 cases, all against fixture payloads (deny-match,
bash-command-match, no-match fail-open, class-not-in-forbidden-set, off mode, warn mode's
documented gap, empty forbidden set, harness-internal tool names never classify, non-array/
missing `forbiddenClasses`, unrecognized mode string falling through to deny). All green —
see the runner's receipts for the pasted `node --test` output.

## 5. Worked example — a 2-wave outcome through the lane (designed, not executed)

**Outcome:** "Add per-IP rate-limit backoff to the gateway, with an audit-log entry for
every throttled request." Two items: (A) backoff logic, (B) audit-log wiring — B depends on
A's throttle-decision hook existing, so muster's own wave computation places them in
separate waves.

1. **Run start.** A human (or muster's own dispatcher) creates one kanban card for the
   outcome, `role="orchestrator"`, workspace `worktree` (a disposable git worktree under
   `.worktrees/<id>/` [src: hermes-kanban]). The orchestrator writes `.muster/run-active`
   and `.muster/forbidden-actions` (e.g. `publish`, `delete-remote` — this outcome must not
   push or release mid-run) into that worktree, exactly as any other harness's run start
   does.
2. **Wave 1 dispatch.** The orchestrator calls
   `delegate_task(tasks=[{goal: "implement per-IP rate-limit backoff...", context: <full
   outcome + acceptance criteria + relevant file list>, toolsets: ["file","terminal"],
   role: "worker"}])` — a single-item "batch" here since wave 1 has one task
   [src: hermes-delegation]. The child gets a fresh context (it never saw this
   conversation) and works inside the shared worktree. Any tool call it makes that
   classifies into `publish`/`delete-remote` (e.g. an errant `git push`) is vetoed at
   `pre_tool_call` by a script built on `mapActionFenceToHermes` (§4), returning the
   canonical block shape; `approvals.deny` globs stand as the static second layer
   regardless of what the dynamic fence does.
3. **Child returns; receipt written.** Only the final summary crosses back
   [src: hermes-delegation]. The orchestrator writes it into the kanban card via
   `kanban_comment`, with `changed_files`/`verification` populated — muster's RECEIPT.
4. **Review gate between waves.** The orchestrator issues a second `delegate_task` call,
   `role: "reviewer"`, `context` carrying the full wave-1 diff summary plus muster's
   review-gate rubric verbatim (children start with zero history — the rubric must be
   passed, not assumed known). The reviewer child's `goal` requires it to end with an
   explicit `VERDICT: PASS` or `VERDICT: FAIL` line, mirroring the review-gate skill's
   existing discipline unchanged. The orchestrator (still muster's own glue, still
   muster-owned judgment — this barrier is not a Hermes primitive) does not issue wave 2's
   `delegate_task` call until it parses `VERDICT: PASS` out of the reviewer's summary; a
   `FAIL` is written back as a `kanban_block(reason="review findings", kind="needs_input")`
   and wave 1's task is re-dispatched with the findings folded into the next child's
   `context`, exactly matching muster's own fix-loop-until-PASS-or-bounded-escalate
   discipline.
5. **Wave 2 dispatch.** Only after a recorded PASS: `delegate_task(tasks=[{goal: "wire the
   audit-log entry for throttled requests, using the backoff hook from wave 1", context:
   <wave-1 summary + file locations>, ...}])`.
6. **Review gate again**, same shape as step 4.
7. **Run receipts.** On a final PASS, the orchestrator calls
   `kanban_complete(summary, metadata={changed_files: [...], verification: "node --test
   passed, N/N", dependencies: ["wave1->wave2"], retry_notes: "", residual_risk: "none
   identified"}, result: "merged to <branch>", artifacts: [...])` — the run's full
   receipts, in Hermes's own durable store, in the same shape muster's coordination
   protocol already expects (CLAIM/RECEIPT/LEDGER, via `task_events` + `task_runs`).

Nothing in this walkthrough was executed against a live Hermes process — every primitive
cited (`delegate_task` call shape, kanban statuses/fields, `kanban_block` kinds,
`pre_tool_call`'s response shape) is doc-sourced [src: hermes-delegation]
[src: hermes-kanban] [src: hermes-hooks], and the one piece of it that is code (§4) is
tested against fixtures, not a running Hermes instance. That is exactly the honest
"designed + probed, live-execution needs a Hermes host" outcome the dispatching brief
allows as a valid PASS.

## 6. The Agents-SDK-alternative comparison (one paragraph)

The OpenAI Agents SDK's `Runner` loop is a real alternative substrate for a runner lane —
`Runner.run()` drives a documented call-LLM/handoff/tool-call cycle with `RunConfig` hooks
(`call_model_input_filter`, `handoff_input_filter`, `tool_error_formatter`, `max_turns`) as
its closest analog to a hook-interception point, and `needs_approval` predicates plus
durable, serializable `RunState.approve()`/`reject()` give it a genuinely strong, opt-in
action-fence analog — arguably stronger in isolation than Hermes's dangerous-pattern
interception, since it is a real pause-the-run primitive rather than a pattern-match veto
[src: gw-sdk] [src: gw-hitl]. Handoffs and agents-as-tools would carry the wave-dispatch
role `delegate_task` plays here. But the SDK supplies none of Hermes's other two legs for
free: it has no plan-mode analog, no task-board primitive, and — load-bearing for this
lane's design — **no kanban-equivalent durable coordination board**; muster would have to
build the CLAIM/RECEIPT/BLOCKED/LEDGER ledger itself on top of a pluggable `Session`
backend (SQLite/Redis/etc.) rather than inherit one [src: gw-sdk]. Combined with the SDK
being "a framework to build on, not an installed harness" — targeting it means muster ships
and owns the whole runner, not a thin adapter over converged natives
[src: gw-verdict] — Hermes stays primary for this spike specifically because two of its
three legs (skills, hooks) port near-verbatim and the third (kanban) is already-built
harness machinery, where the SDK would require muster to build the coordination-board leg
from scratch. The Agents SDK spike (`agents-sdk-runner-lane`, backlog #9) is filed
separately and remains the item that would go deeper on the SDK's `needs_approval` edge —
this paragraph is not a substitute for that item, only this spike's required comparison.

## 7. Constraints and risks a real port would have to design around

- **Python plugin surface vs Node muster** [src: hermes-port] — any real shell-hook script
  (like a wired version of §4's module) runs as a subprocess with JSON stdin/stdout, so the
  language boundary is a process boundary, not an import boundary; this is already how
  `plugin/hooks/*.js` work today (Node subprocesses under Claude Code's own hook contract),
  so the shape is familiar, not new.
- **Model override is config-level, not per-call, on `delegate_task`** — `delegation.model`
  routes ALL subagents to one alternate model; per-role model routing would degrade to one
  subagent model in-session unless kanban *profiles* are used instead (each profile carries
  its own model) [src: hermes-delegation].
- **Unattended consent gate** — shell hooks need first-use consent per `(event, command)`
  pair unless `--accept-hooks` / `HERMES_ACCEPT_HOOKS=1` / `hooks_auto_accept: true` is set;
  an unattended lane run must pre-accept this or hooks silently stay unregistered
  [src: hermes-hooks].
- **Approvals are permissive by default** — dangerous-pattern interception, not allowlisting
  [src: hermes-approval]; leg 3 (§3) must install both `pre_tool_call` and `approvals.deny`
  deliberately, never assume a default-deny posture.
- **No documented blocking plan-approval mode** — `/plan` and `/goal` completion contracts
  exist, but approve-first enforcement stays muster's own responsibility, same as every
  other harness [src: hermes-port].
- **Single-host by design** — kanban's crash detection is PID-based, so this lane (like the
  rest of Hermes) is not itself a distributed-multi-host design [src: hermes-kanban].

## Sources

- nd-verdict: docs/strategy/native-delegation.md Part A ("Verdict") — stay a judgment
  layer, do not build a custom harness, confidence HIGH (~85%).
- nd-middle: docs/strategy/native-delegation.md Part A ("The middle path") — the only
  funded part of "worth a shot": an optional Hermes-hosted or Agents-SDK runner lane beside
  the layer strategy, never a replacement.
- hermes-port: docs/research/hermes.md section 11 — verdict, first-class port surfaces,
  port constraints (Python-vs-Node, no per-call model override, no clarify for subagents,
  permissive approval default).
- hermes-port-table: docs/strategy/native-delegation.md Part B section 7 — the Hermes
  maximal-native-replacement row table (win/risk/effort per muster construct).
- hermes-skills: docs/research/hermes.md section 7 (Skills) — agentskills.io SKILL.md,
  AGENTS.md/CLAUDE.md project-context resolution, external dirs, hub taps.
- hermes-hooks: docs/research/hermes.md section 7 (Hooks) — event surface including
  pre_tool_call's `{"action":"block","message":...}` veto shape and pre_llm_call's
  `{"context":...}` injection; Claude Code Stop-shape acceptance for shell hooks generally;
  consent allowlist / `--accept-hooks`.
- hermes-delegation: docs/research/hermes.md section 5 — delegate_task call shape, parallel
  batch, fresh-context children, config-level (not per-call) model override, depth/
  concurrency limits.
- hermes-kanban: docs/research/hermes.md section 4 (Kanban) — statuses, task_events log,
  task_runs structured handoff metadata convention keys, kanban_block kinds, worker tool
  surface, workspace types.
- hermes-approval: docs/research/hermes.md section 3 (Approval model) — dangerous-pattern
  interception as the general posture, `approvals.deny` globs surviving yolo/off mode.
- gw-sdk: docs/research/gpt-work.md section 2 — Agents SDK Runner loop, RunConfig hooks,
  no plan/task-board/kanban-equivalent primitive.
- gw-hitl: docs/research/gpt-work.md section 2.4 — needs_approval predicates, RunState
  pause/approve/reject, durable serialized state.
- gw-verdict: docs/research/gpt-work.md section 9 — Agents SDK is a build (a runner lane
  muster would own), not an augmentation of an installed harness.
