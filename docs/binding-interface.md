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
dispatch time: `plugin/commands` (the eight modes plus the `run`/`autopilot`/`sprint` alias
stubs, as `*.md` files), `plugin/skills` (the eleven core skills, one `SKILL.md` per
subdirectory), muster's own agents in `plugin/agents` (seven `muster-*.md` files; not the
vendored `wsh-*.md` personas), and `plugin/output-styles/muster.md` -- thirty files.

Two adjacent trees were deliberately excluded, with evidence rather than assertion:

- The vendored specialist packs (`plugin/agents`'s `wsh-*.md` personas and every SKILL.md under
  `plugin/builtins`) are payload content the router dispatches *into*, not muster's own
  orchestration prose. A raw grep for "hook" across `plugin/` before narrowing the scope
  pulled in React hooks (`plugin/agents/wsh-frontend-developer.md`: "Advanced hooks
  (useActionState...)"), git pre-commit hooks (`plugin/builtins/gsd-execute-phase/SKILL.md`), a
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
fallback for itself, not as theory: `plugin/agents/muster-runner.md`'s review-gate step reads
"use the Task tool (named Agent on some harnesses -- the frontmatter grants both) to dispatch
muster-reviewer... when agent dispatch is unavailable, run the reviewer's discipline yourself
in a strictly read-only pass over the diff." Generalized across every dispatch call in this
document: the orchestrator loop reads the resolved provider's skill or agent prose into its own
context and performs the step itself, sequentially, in the same thread. Consequences: waves
collapse from parallel fan-out to a strictly sequential pass; a tournament's N competing
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
mechanism in this audit (see the Grep audit table below): the scope confirmation in
`plugin/commands/plan.md` and `plugin/commands/go.md`, the merge-decision prompt in
`plugin/commands/go.md` and `plugin/commands/audit.md`, capture's write gate in
`plugin/commands/capture.md`, plan-backlog's approval gates in
`plugin/commands/plan-backlog.md`, the interview skill's one-question-at-a-time loop in
`plugin/skills/interview/SKILL.md`, coordination's HUMAN-HOLD resume in
`plugin/skills/coordination/SKILL.md`, the orchestrator's pre-flight plan-conflict batch
question and review-gate escalation resolution in `plugin/skills/orchestrator/SKILL.md`,
roadmap-prioritization's optional-push offers in
`plugin/skills/roadmap-prioritization/SKILL.md`, and the router and greenfield skills'
"ask, don't invent" rule in `plugin/skills/router/SKILL.md` and `plugin/skills/greenfield/SKILL.md`.

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

**Claude Code binding.** `plugin/hooks/hooks.json` registers three scripts against Claude
Code's hook lifecycle: `SessionStart`, `UserPromptSubmit`, and a single `PreToolUse` matched
against `Edit|Write|NotebookEdit|Bash|mcp__.*` (the `mcp__.*` arm widened onto the matcher so
the action-class fence also sees MCP tool calls) in `plugin/hooks/pre-tool-use.js`. The
enforcement-model redesign removed the wave-guard, the per-turn scale-gate, and the separate
`Task|Agent`-matched todo-gate entirely (unscopable in the field -- false-positive-trained kill
switches and denies on sessions/repos where muster never ran; see CHANGELOG); the action-class
fence is now the ONE hard deny this hook can emit, and a warn-only "border invitation" (the
cumulative inline-file counter, plus the `UserPromptSubmit` isDirective nudge) is the only other
thing it does. `plugin/skills/orchestrator/SKILL.md`'s own "Enforcement model: gates vs
conventions" section draws the identical line for a plugin-user reading skill prose rather than
hook source: one hook-enforced hard deny (the action-class fence), a warn-only hook-enforced
border invitation that never denies, and a CONVENTIONS tier -- dispatch-not-inline, todo-driving
visibility, crew-owner/state-in-subject, verb selection, humanizer routing, glass-box narration --
enforced only by SKILL discipline and the review gate after the fact, specifically because a
`PreToolUse` hook can observe a tool call, never a judgment call, and even the one hard deny only
ever sees the run's EXTERNAL effects (a forbidden action class), never the orchestrator's own
in-repo edits.

**Degradation ladder (no-hook harness).** No `PreToolUse`/`SessionStart`/`UserPromptSubmit`
event exists at all. The two hook-enforced items disappear outright rather than demoting to a
convention, since neither has a convention-tier substitute already documented for it: the
action-class fence becomes a `FORBIDDEN ACTIONS:` line carried in the dispatch brief -- the
brief-copy step is harness-agnostic prose already, not hook-dependent -- with no mechanical
block, relying entirely on the review gate catching a violation after the fact; the border
invitation (a warn-only nudge fired at the moment inline drift crosses a threshold, or a
directive-shaped prompt lands) has no equivalent at all on a no-hook harness, since firing at
that moment is specifically a hook-time observation -- this is a value-selling nudge, not an
enforcement guarantee, so losing it costs muster a sales pitch, not a control. Every item already
in the CONVENTIONS tier -- dispatch-not-inline, todo-driving visibility (that same file's "Task
board" section already documents its fail-soft path: "a harness with no task tools relies on
STATE alone (note this once)"), crew-owner/state-in-subject, verb selection, humanizer routing,
glass-box narration -- needs no further downgrade: none of them were hook-enforced to begin with,
so a no-hook harness changes nothing for that tier. `SessionStart`/`UserPromptSubmit`'s
context-injection role (drift reinforcement across a long session) has no direct substitute on a
harness with no session-lifecycle hook at all; the nearest available fallback is restating the
working principles at the top of every dispatch brief the orchestrator loop itself controls,
which only reaches subagent context, never the top-level loop between its own turns. Closing
that specific gap is what the parked AGENTS.md adapter, below, would be for.

### 4. Isolate

**What it is.** Give a unit of work -- a parallel same-wave task, or a whole backlog item
driven by a dispatched runner -- its own filesystem/branch sandbox, so concurrent work cannot
collide with the base checkout or with a sibling task.

**Claude Code binding.** Git worktrees, created per concurrent same-wave file-writing task
(`plugin/skills/orchestrator/SKILL.md`: `isolation: "worktree"` passed as a parameter on the
Agent tool call) and per dispatched backlog-item runner in wave mode
(`plugin/commands/go-backlog.md`: each parallel item-runner subagent gets its own
`.worktrees/<item-branch>`). The guarantee composes with Enforce:
`plugin/commands/go-backlog.md` notes a runner's tool calls inside its worktree rely on the
`PreToolUse` hook's subagent exemption, since a worktree carries no `.muster/` markers of its
own.

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

**Claude Code binding.** Three layers, only one of which is Claude-Code-specific. `.muster/STATE.md`
and git itself (commits, `git notes --ref=muster` written per wave by
`plugin/skills/orchestrator/SKILL.md`) are plain files and git, harness-agnostic already. The
mandated dispatch return contract (implementers return raw data capped at 2000 characters,
reviewers return a verdict first with findings capped at 1500 characters --
`plugin/skills/orchestrator/SKILL.md`'s "Return contract" section) is brief-level prose
discipline, not a Claude Code feature, though it only has something to bound *because* Dispatch
exists. The one genuinely Claude-Code-specific piece is the native todo list: Claude Code's own
`TodoWrite`/`TaskCreate`/`TaskUpdate` tool calls, surfaced in its own todo UI. A hook
(plugin/hooks/todo-gate.js) once read that list back to gate dispatch on it; the
enforcement-model redesign removed the gate (visibility is now convention, not hook-enforced --
see `docs/architecture.md`'s "Enforcement model" section), so `plugin/skills/orchestrator/
SKILL.md`'s "Task board" section carries the discipline on its own: "one harness-visible task
per work item... via the harness's task tools when present."

**Degradation ladder (no native todo tool).** The STATE.md ledger and git notes need no
ladder -- they survive unchanged on any harness with a filesystem and git, since neither one
was Claude-Code-specific to begin with. The native-todo-list receipt has no direct equivalent
absent that tool: `plugin/skills/orchestrator/SKILL.md`'s own "Task board" section already
states the fail-soft path verbatim -- "a harness with no task tools relies on STATE alone (note
this once)" -- so the todo-list receipt folds back into the STATE.md checklist, with visibility
enforced only by the same convention-not-gate downgrade named under Enforce, never
mechanically.

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

Reproducible commands, run from the repo root against the thirty-file "plugin prose" scope
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
AskUserQuestion    files=13  mentions=31
dispatch (Agent/Task tool)  files=5  mentions=21
hook (PreToolUse/SessionStart/UserPromptSubmit)  files=11  mentions=28
worktree   files=5  mentions=12
```

Every one of those 92 mentions accounted for above: AskUserQuestion under Ask; Agent/Task tool
and `subagent_type` under Dispatch; hook/PreToolUse/SessionStart/UserPromptSubmit under
Enforce; worktree under Isolate. Receipts and Capability scan bind to mechanisms (the native
todo tool, the plugin registry) that plugin prose refers to by their STATE/task-board/`muster
capabilities` names rather than by the literal strings audited here, which is why they are not
separate rows in this table -- their own sections above cite the exact files instead.

## AGENTS.md adapter (parked, not built)

AGENTS.md is an emerging cross-harness convention: a plain-text instructions file some
non-Claude-Code harnesses (and CLIs like Codex) read natively at session start, the way Claude
Code reads `CLAUDE.md`. It is a plausible landing spot for the one primitive with no clean
fallback above: Enforce's `SessionStart`/`UserPromptSubmit` context-injection role, which today
has no substitute on a harness with no session-lifecycle hook at all.

Two things already exist in this repo named "AGENTS.md" and neither is this adapter, which is
worth stating explicitly so a future reader does not conflate them: `src/setup.js`'s
`scaffoldProject()` seeds a placeholder `AGENTS.md` stub ("This repository is managed with
muster.") into a fresh greenfield project, and `eval/modes/fixtures/skills/greenfield/plan-annotated-parallel.md`
references seeding one the same way. Both are a one-line bootstrap file, not a binding.

Building an actual AGENTS.md adapter would mean generating and keeping in sync a real
degradation surface: the working principles, the verb lexicon, and a routing-policy reminder
written into AGENTS.md content a harness without `SessionStart` could load on its own, plus
deciding how (or whether) the wave-guard/scale-gate/todo-gate/action-fence conventions get
restated there once they are conventions rather than gates (see Enforce). That is real design
and implementation work, is out of scope for a doc-only item, and stays a named follow-up here
rather than a half-built adapter: **parked, not built.**
