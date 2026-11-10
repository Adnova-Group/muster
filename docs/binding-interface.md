# Harness binding interface

`docs/architecture.md` calls muster "glass-box, multi-runtime, multi-domain." Glass-box and
multi-domain are both falsifiable elsewhere in that document: every routing decision names its
evidence, and the pipeline list spans PRD, business-case, launch-plan, and a dozen more
non-code artifacts. Multi-runtime has never gotten the same treatment. It reads as a README
adjective: muster composes whatever tools are present and falls back to its own built-ins, which
is true, but it says nothing about what happens if the runtime itself changes, only what happens
when the *tools inside* a Claude Code runtime change.

This document makes multi-runtime falsifiable the same way glass-box already is. It names the
harness primitives muster's modes actually consume, binds each one to its exact Claude Code
mechanism with file references, grep-audits every place that mechanism shows up in plugin prose,
and states a degradation ladder for a no-subagent, no-hook harness: what each primitive becomes
when neither Claude Code's subagent dispatch nor its hook lifecycle is available. It changes no
behavior. Nothing here is a spec for a new adapter -- one candidate adapter (AGENTS.md) is named
and explicitly parked, not built.

## Scope of the audit

"Plugin prose" here means the model-facing surface Claude Code actually loads and reads at
dispatch time: `plugin/commands` (the seven modes as `*.md` files),
`plugin/skills` (the seven core skills, one `SKILL.md` per
subdirectory), muster's own agents in `plugin/agents` (nine `muster-*.md` files; not the
vendored `wsh-*.md` personas), and `plugin/output-styles/muster.md` -- twenty-four files. The Workflow scripts in
`plugin/workflows/` are code, not prose, and sit outside the audit.

Two adjacent trees were deliberately excluded, with evidence rather than assertion:

- The vendored specialist packs (`plugin/agents`'s `wsh-*.md` personas and every SKILL.md under
  `plugin/builtins`) are payload content muster dispatches *into*, not muster's own
  orchestration prose. A raw grep for "hook" across `plugin/` before narrowing the scope
  pulled in React hooks (`plugin/agents/wsh-frontend-developer.md`: "Advanced hooks
  (useActionState...)"), git pre-commit hooks (in a since-deleted gsd builtin), a
  different harness's own hook system entirely
  (`plugin/builtins/wsh-signed-audit-trails-recipe/SKILL.md`, which documents *protect-mcp's*
  runtime hooks, unrelated to Claude Code's), and marketing copy ("Lead with a hook" in
  `plugin/builtins/muster-author/SKILL.md`). None of those are a Claude-Code-specific dependency
  of a muster mode; they are noise a scope this document could not stand behind. Narrowing to
  muster's own orchestration prose removed all of it.
- `plugin/hooks/hooks.json` and its scripts are the binding *targets*, not prose to audit --
  they are cited below as the exact Claude Code mechanism, not scanned for mentions of
  themselves.

## The six primitives

Every mode and skill under audit reduces to six things it asks the harness to do. None of the
six is unique to muster; they are what any orchestrator layered on top of a coding agent needs.
What is specific to muster is which exact Claude Code feature it currently binds each one to.

### 1. Dispatch

**What it is.** Spawn a bounded unit of specialist work -- a chosen role/provider, a model
override, a scoped tool set -- and get back one bounded result, without the orchestrator doing
the work itself in its own context.

**Claude Code binding.** Claude Code's built-in subagent dispatch, called the Task tool in
older sessions and the Agent tool in current Claude Code (`docs/architecture.md`'s Execution
model section: "Model work goes through Claude Code's built-in subagent dispatch (the
Task/Agent tool)"). `subagent_type` selects a named agent-kind provider
(`plugin/skills/orchestrator/SKILL.md`, `subagent_type = roles[<role>].chosen.id`); anything
else -- a skill/mcp/inline provider, or an agent type not yet registered in the running
session -- falls back to a generic subagent with the provider's brief or skill injected (the
same file's "Generic-subagent fallback (degraded path)" block). Every dispatch also carries a
`model` override, and same-wave concurrent file writers each get `isolation: "worktree"` on the
call (see Isolate, below). A todo-driving gate on the dispatch call itself, matching both the
`Task` and `Agent` tool names, existed at plugin/hooks/todo-gate.js through 0.4.x; the
enforcement-model redesign removed it (unscopable in the field -- see CHANGELOG) along with the
wave-guard and per-turn scale-gate. `plugin/hooks/pre-tool-use.js`'s action-class fence is the
one deny surface left on any dispatch-adjacent tool call.

**Degradation ladder (no-subagent harness).** There is no isolated-context spawn at all --
one thread of conversation, period. Muster's own dispatchable agent already states this
fallback for itself, not as theory: `plugin/skills/orchestrator/SKILL.md`'s "Prose fallback"
section dispatches the planner, executor, reviewer and verifier one Agent call at a time when the
Workflow tool is missing, and says to stop rather than work inline when the Agent tool is
missing too. Generalized across every dispatch call in this
document: the orchestrator loop reads the resolved provider's skill or agent prose into its own
context and performs the step itself, sequentially, in the same thread. Consequences: waves
collapse from parallel fan-out to a strictly sequential pass; any N competing
candidates become N sequential single-shot drafts scored by the same loop that wrote them,
which weakens the point of running a tournament at all; the model-tier-per-role advantage
narrows to whatever model-swap capability the harness exposes at the top-level call, if any; and
the "generic subagent + skill injection" fallback Claude Code already uses as a bonus path
becomes the *only* dispatch path -- every provider becomes "read the skill file, then proceed
inline." (The todo-gate hook mentioned above no longer exists on any harness, subagent-capable or
not -- its removal is unrelated to this degradation; see Enforce.)

### 2. Ask

**What it is.** Pause the run and collect a structured decision from a human at a small, named
set of gates -- offering the exact options and signals fired, never inferring silently -- rather
than parsing free text.

**Claude Code binding.** The AskUserQuestion selection UI tool. It is the single most-cited
mechanism in this audit (see the Grep audit table below): the backlog-scope confirm and the
approval stop in `plugin/commands/plan.md`, the unclear-outcome questions and the merge decision
in `plugin/commands/go.md`, the merge-decision prompt in `plugin/commands/audit.md`, capture's
write gate in `plugin/commands/capture.md`, the interview skill's question rounds (up to 4
questions per call, each with a recommended answer) in `plugin/skills/interview/SKILL.md`, the
PM command's question rounds and approval stops in `plugin/commands/pm.md`, the escalation stops
in `plugin/skills/orchestrator/SKILL.md`, the roadmap's optional-push offers in
`plugin/builtins/muster-roadmap/SKILL.md`, and the greenfield skill's "ask, don't invent"
rule in `plugin/skills/greenfield/SKILL.md`. Workflow agents cannot ask the user, so every one of
these stops sits between workflow calls in the main thread.

**Degradation ladder (no structured question UI).** No multi-choice tool exists -- the model
asks in prose and waits for the next turn's freeform reply, parsed by the calling skill's own
discipline instead of a tool-level options list. The "verbatim, never paraphrased" rule
(`plugin/commands/go.md`) still applies; it just has to be typed rather than rendered. If the
harness is attended (a human sits in the turn loop), `ask` degrades to plain conversational
question-and-answer with the same one-question-at-a-time rule, just without selectable options.
If the harness is unattended (no human turn loop at all, e.g. a CI batch), `ask` degrades
further to the pattern every muster mode already documents for its own Unattended (Routine)
branch: record the gap to STATE or the run report and apply the documented best-effort default
instead of blocking. That attended-vs-Routine branching every mode already carries is, read
this way, already the ask primitive's degradation ladder for the no-human case -- it was simply
never named as harness degradation before now.

### 3. Enforce

**What it is.** A guardrail on a tool call that fires deterministically, independent of whether
the model chooses to comply.

**Claude Code binding.** `plugin/hooks/hooks.json` registers one script, and it does nothing
outside a muster run's scope: a single `PreToolUse` matched against `^(Bash|PowerShell|mcp__(?!ccd_turn__(?:update_plan|wrap_up)$).*)$`
(`plugin/hooks/pre-tool-use.js`, the action-class fence). The `TaskCompleted` gate was removed
in revival stage 2b with the native task board. There is no `SessionStart` or `UserPromptSubmit` hook
and no warn-only nudge: muster costs nothing in a session that never invokes a verb. The
enforcement-model redesign removed the wave-guard, the per-turn scale-gate, and the separate
`Task|Agent`-matched todo-gate (unscopable in the field -- false-positive-trained kill switches
and denies on sessions/repos where muster never ran; see CHANGELOG), and the zero-cost pass then
removed the border invitation, its inline-file counter, and the session/prompt hooks. The
action-class fence is the ONE hard deny. `plugin/skills/orchestrator/SKILL.md`'s must-hold
rules draw the same line for a plugin user reading skill prose rather than hook source: the fence
is hook-enforced, while dispatch-not-inline, evidence over verdicts and merge-wave as the only
merge path are run rules the skill states and `muster merge-wave` checks after the fact, because
a `PreToolUse` hook can observe a tool call, never a judgment call, and even the one hard deny
only ever sees the run's EXTERNAL effects (a forbidden action class), never the orchestrator's
own in-repo edits.

**Degradation ladder (no-hook harness).** No `PreToolUse` event exists at all. The action-class fence becomes a `FORBIDDEN ACTIONS:` line carried in the dispatch brief --
the brief-copy step is harness-agnostic prose already, not hook-dependent -- with no mechanical
block, relying entirely on the reviewer and `merge-wave` catching a violation after the fact.
The run rules need no further downgrade: none of them were hook-enforced to begin with, so a
no-hook harness changes nothing for them.

### 4. Isolate

**What it is.** Give a unit of work -- a parallel same-wave task, or a whole backlog item
driven by a dispatched runner -- its own filesystem/branch sandbox, so concurrent work cannot
collide with the base checkout or with a sibling task.

**Claude Code binding.** Git worktrees, created by the `muster:build` Workflow script for every
executor (`isolation: "worktree"` on each `agent()` call in `plugin/workflows/build.js`, the same
parameter the Agent tool takes in the orchestrator's prose fallback). Fixers work in the builder's
kept worktree, the verifier integrates the wave commits in a scratch worktree, and `muster
merge-wave` (`src/merge-wave.js`) removes only clean, merged worktrees under `.claude/worktrees/`.
The action fence reads `.muster/run-active` and `.muster/forbidden-actions` from the tool
payload's cwd; Workflow worktrees are created by the harness, so the fence covers the main thread
and executor isolation is the worktree boundary itself.

**Degradation ladder (no-subagent harness, nothing to pin a cwd to).** Git worktrees and branches are
themselves plain git, not Claude-Code-specific, so the filesystem sandbox survives unchanged on
any harness with git available. What is Claude-Code-specific is pinning a *dispatched
subagent's* working directory to that worktree -- without Dispatch (above), there is no
independently running process to pin, so the concurrency guarantee narrows: instead of N
worktrees genuinely worked in parallel by N subagents, the single thread works them one at a
time, sequentially, still one worktree per item. This is the same fallback wave mode already
documents one level up for a related but distinct degrading condition
(`docs/architecture.md`: "a harness that cannot dispatch parallel subagents runs the same waves
sequentially instead") -- isolation rides on that same sequential fallback rather than needing
one of its own. Isolation itself (no collision with the base checkout) is not weakened by
serialization; the sandbox boundary holds even when the work inside it happens one item at a
time. Only a harness with no git worktree support at all would weaken isolation further, to a
single shared directory with serialized access and no per-item rollback boundary -- a
materially worse guarantee muster does not currently need to plan for, since every harness this
document considers still assumes git.

### 5. Receipts

**What it is.** Machine-checkable evidence of what happened, independent of prose summary,
durable enough for a resumed run or a reviewer to trust without re-deriving it from
conversation memory.

**Claude Code binding.** The run directory `.muster/runs/<runId>/` (CONTEXT, PLAN,
build-args, SUMMARY-*, VERIFICATION, STATE), committed on the work branch, plus git itself (the
tagged per-task commits and the `--no-ff` merges). These are plain files and git,
harness-agnostic already. The Claude-Code-specific layer is the Workflow script's
schema-validated returns (`plugin/workflows/schemas.js`): each executor, reviewer and verifier
returns evidence fields (`commit`, `commitReviewed`, `testsRun`, `testsPassed`) that
`src/merge-wave.js` re-checks against git and the committed build args before anything merges.
The native task board is gone on current models (the 5.x generation has no TaskCreate), so
progress is derived from disk by `muster next --run` (`src/run-next.js`) instead.

**Degradation ladder (no Workflow tool).** The run directory and git need no ladder. Without
schema-validated workflow returns, the orchestrator's prose fallback asks each Agent call for the
same JSON shapes and writes `build-result.json` itself; `merge-wave`'s checks are unchanged, so
the evidence bar holds even when the shape is model-written.

### 6. Capability scan

**What it is.** Discover what specialist tools (plugins, agents, skills, MCP servers) are
actually installed before routing a role to one, rather than assuming or hard-coding a fixed
list.

**Claude Code binding.** `src/harness.js`'s `readInstalled()` (via `src/plugin-inventory.js`'s
`readPluginInventory()`) reads Claude Code's own on-disk plugin registry:
`~/.claude/plugins/installed_plugins.json` (`installPath`-keyed records, `name@marketplace`)
plus `~/.claude/settings.json`'s `mcpServers` map and the `~/.claude/skills/` and
`~/.claude/agents/` directories. `src/capabilities.js`'s `resolveCapabilities()` walks the role
ladder against whatever this scan returns, using `src/installed.js`'s `isInstalled()` to check
each catalog entry against it, and terminates at `inline` when nothing is installed.

**Degradation ladder (no plugin registry to scan).** Muster already ships a second, working
binding for this exact primitive, which makes the ladder concrete rather than hypothetical
instead of a projection. `readInstalledCowork()` in `src/harness.js` swaps the
`~/.claude/plugins` registry read for Cowork's own MCP registry (local servers via
`claude_desktop_config.json`, MCPB/DXT extensions via a `Claude Extensions/` directory with no
index file, remote connectors that cannot be discovered on disk at all and must be passed
explicitly via `--connectors`/`MUSTER_COWORK_CONNECTORS`), while still reading the Claude Code
plugin inventory for the agent/skill/MCP-server lanes a plugin ships. On a harness with neither
registry -- no Claude Code plugin directory, no Cowork config, nothing on disk to scan --
capability scan degrades to a floor muster already documents for a different reason: every
role's ladder walk finds nothing installed and resolves to `inline` for every role, the same
"works on bare Claude Code, gets better as you install more tools" floor `docs/architecture.md`
states for the zero-install case. A no-registry harness is just the zero-install case with no
ceiling to climb toward, unless an operator hand-declares a fixed provider list the way
`--connectors` already lets Cowork's undiscoverable remote connectors be declared instead of
scanned.

## Grep audit

Reproducible commands, run from the repo root against the "plugin prose" scope
defined above (`FILES` set to every `*.md` in `plugin/commands`, every `SKILL.md` in
`plugin/skills`, every `muster-*.md` in `plugin/agents`, and every `*.md` in
`plugin/output-styles`):

```sh
grep -n "AskUserQuestion" $FILES | wc -l
grep -rl "AskUserQuestion" $FILES | wc -l

grep -n "Task tool\|Agent tool\|Task/Agent\|subagent_type\|dispatch a subagent\|dispatch subagents\|dispatches a subagent\|dispatch.*worker\|Task or Agent" $FILES | wc -l
grep -rl "Task tool\|Agent tool\|Task/Agent\|subagent_type\|dispatch a subagent\|dispatch subagents\|dispatches a subagent\|dispatch.*worker\|Task or Agent" $FILES | wc -l

grep -n "\bhook\b\|hooks\.json\|PreToolUse\|SessionStart\|UserPromptSubmit" $FILES | wc -l
grep -rl "\bhook\b\|hooks\.json\|PreToolUse\|SessionStart\|UserPromptSubmit" $FILES | wc -l

grep -n "worktree" $FILES | wc -l
grep -rl "worktree" $FILES | wc -l
```

Counts as of this writing (`files` = distinct files with at least one match, `mentions` =
matching lines, i.e. `grep -n ... | wc -l`). `test/docs-binding-interface.test.js` re-derives
both numbers on every test run from the live prose tree, so this table cannot silently go
stale:

```
AskUserQuestion    files=10  mentions=22
dispatch (Agent/Task tool)  files=2  mentions=8
hook (PreToolUse/SessionStart/UserPromptSubmit)  files=2  mentions=3
worktree   files=9 mentions=64
```

The worktree row dropped to 9 files and 64 mentions at revival stage 4, when go.md's trimmed
description stopped naming worktrees (its body never did). It was refreshed on 2026-11-10 for the dev-team seats: `muster-test-writer` and
`muster-integration-checker` work in an isolated and a scratch worktree, and the go and diagnose
commands name `muster:team`. Counts refreshed for revival stage 2b (2026-11-09): plan.md, go.md and the orchestrator were
rewritten around the Workflow scripts; plan-backlog, go-backlog, runner, the router,
domain-router, review-gate, tournament and coordination skills, the muster-runner agent and the
`TaskCompleted` gate were deleted, and the ten audit-pattern hunt lists moved out of
`plugin/skills/`. Earlier per-item refresh notes described prose that no longer exists and were
dropped; the test re-derives every number from the live tree.
2026-11-10: `write-book.md` (book runs) adds one AskUserQuestion mention (the attended
clarifying questions before the outline).

Refreshed for revival stage 3 (2026-11-10): plan.md and go.md gained the content-route and
skill-edit questions, and the build briefs and orchestrator describe the worktree base.
Refreshed for PM stage B (2026-11-10): the orchestrator's spec-run rules add the clarification
round's AskUserQuestion, and the verifier's anti-pattern scope line was shortened.

Every one of those mentions is accounted for above: AskUserQuestion under Ask; Agent/Task tool
and `subagent_type` under Dispatch; hook/PreToolUse/SessionStart/UserPromptSubmit under
Enforce; worktree under Isolate. Receipts and Capability scan bind to mechanisms (the run
directory, the plugin registry) that plugin prose refers to by their run-directory/`muster
capabilities` names rather than by the literal strings audited here, which is why they are not
separate rows in this table -- their own sections above cite the exact files instead.

## AGENTS.md adapter (parked, not built)

AGENTS.md is an emerging cross-harness convention: a plain-text instructions file some
non-Claude-Code harnesses (and CLIs like Codex) read natively at session start, the way Claude
Code reads `CLAUDE.md`. It is a plausible landing spot for the one primitive with no clean
fallback above: session-start context injection, which no muster harness binding performs
any more.

Two places already describe greenfield instruction scaffolding, and neither is this adapter,
which is worth stating explicitly so a future reader does not conflate them: `src/setup.js`'s
`scaffoldProject()` seeds the canonical pair, with `AGENTS.md` as the authority and
`CLAUDE.md` containing only the `@AGENTS.md` pointer, while
`eval/modes/fixtures/skills/greenfield/plan-annotated-parallel.md` names that same pair in its
legacy setup fixture. This is a bootstrap authority pair, not a generated binding surface.

Building an actual AGENTS.md adapter would mean generating and keeping in sync a real
degradation surface: the working principles, the verb lexicon, and a routing-policy reminder
written into AGENTS.md content a harness without `SessionStart` could load on its own, plus
deciding how (or whether) the action fence and the run rules get
restated there once they are conventions rather than gates (see Enforce). That is real design
and implementation work, is out of scope for a doc-only item, and stays a named follow-up here
rather than a half-built adapter: **parked, not built.**
