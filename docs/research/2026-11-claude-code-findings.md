# Claude Code findings for muster, 2026-11

These are the Claude Code changes from 2.1.220 through 2.1.322, plus the Desktop Code tab
through v4.23118.1, that muster's current design should adopt, fix or stop doing. "Current
design" means `docs/strategy/stage-2-contracts.md`, `plugin/workflows/`,
`plugin/commands/plan.md` and `go.md`, `plugin/skills/orchestrator/SKILL.md`, and
`plugin/hooks/`.

The evidence is in [claude-code-cli.md](claude-code-cli.md) §13 and
[claude-code-desktop.md](claude-code-desktop.md) §12. Every quote below is verbatim from the
CHANGELOG (re-fetched 2026-11-10, newest entry 2.1.322), the code.claude.com docs
(fetched 2026-11-10), the Desktop changelog (fetched 2026-11-10), or the
[2026-11-09 live probes](claude-code-live-probes-2026-11.md). Installed build: 2.1.319.
"Not stated in docs" marks the places where the sources say nothing.

Effort: **S** is under half a day, **M** is one to two days, **L** is more than that.
Findings marked **CONTRADICTS** conflict with the current design as written.

## Top 10

1. **F1 CONTRADICTS:** executor worktrees can branch from `origin/<default>`, not the work branch, so `build.js` would mark every task `blocked` in a repo with a remote.
2. **F2 CONTRADICTS:** the orchestrator says the rules "survive compaction", but only an invoked skill's body is re-injected, and nothing invokes `muster:orchestrator`.
3. **F3 CONTRADICTS:** `/muster:plan` inside native plan mode runs subagents that "stay in plan mode", so PLAN.md, CONTEXT.md and `git switch -c` may be blocked.
4. **F4 CONTRADICTS (partly):** "No task board on current models" is wrong for background and cloud sessions, and Desktop has its own checklist tool.
5. **F5:** the prose fallback assumes Agent results come back inline. Subagents now always run in the background in Desktop and VS Code, and by default in the terminal.
6. **F6:** the hook should use exec form. Shell-form PreToolUse hooks now fail closed on Windows PCs without Git for Windows, against the fence's fail-open design.
7. **F7:** Desktop WSL sessions load no plugins at all, so muster is absent there. Document it.
8. **F8:** environment variables can silently override the per-seat model and effort map. Preflight should detect and report them.
9. **F9:** `resumeFromRunId` works within the same session only. `go.md`'s resume step needs the fallback spelled out.
10. **F10:** unattended runs should set `permissions.denyInsteadOfPrompting` or `--permission-prompts none` so a stray prompt cannot stall them.

## Findings

### F1. Executor worktrees may branch from the remote default branch (CONTRADICTS)

- **Quote:** docs/worktrees: "`\"fresh\"` (default): branch from the repository's default
  branch on the remote, usually `main`". Also: "`\"head\"`: branch from your current local
  `HEAD` … Use this when isolating subagents that need to operate on in-progress work",
  and "If no remote is configured … the worktree falls back to your current local `HEAD`."
  CHANGELOG 2.1.133 applies the setting to "`--worktree`, `EnterWorktree`, and
  agent-isolation worktrees".
- **Version:** 2.1.133 (still the documented default on 2026-11-10).
- **Gap:** whether Workflow `agent({isolation:'worktree'})` worktrees follow
  `worktree.baseRef` is not stated in docs. Live probe §2 saw "based on HEAD", but that
  does not separate the `head` setting from the no-remote fallback.
- **Impact:** the work branch `muster/<runId>` carries the committed `build-args.json` and
  PLAN.md and is always ahead of `origin/main`. If executor worktrees start from
  `origin/main`, step 2 of the executor brief (`git merge-base --is-ancestor <base> HEAD`)
  fails, and every task returns `blocked`. That fails safe, but no real run could
  complete.
- **Affected:** `plugin/workflows/build.js` and `backlog.js` (executor brief steps 1-3),
  `docs/strategy/stage-2-contracts.md` (Workflow scripts),
  `plugin/skills/orchestrator/SKILL.md` (prose fallback).
- **Action:**
  1. Probe a Workflow `isolation:'worktree'` agent in a repo that has an `origin` and an
     unpushed commit.
  2. If it branches from the remote, have `muster init` or `preflight` require
     `"worktree": {"baseRef": "head"}` in project `.claude/settings.json`. A plugin
     `settings.json` honors only `agent` and `subagentStatusLine`, so the plugin cannot
     set it.
  3. Alternatively, make the executor brief check out `<base>` when HEAD lacks it.
- **Effort:** S (probe) + S (fix).

### F2. The orchestrator rules are not re-injected unless the skill is invoked (CONTRADICTS)

- **Quote:** docs/context-window: "Invoked skill bodies | Re-injected, capped at 5,000
  tokens per skill and 25,000 tokens total; oldest dropped first". 2.1.304: "Changed
  compaction to send Claude the skill list again afterwards".
- **Version:** docs current; 2.1.304.
- **Impact:** `go.md` and `plan.md` say "The **orchestrator** skill holds the rules that
  survive compaction", but neither tells the model to invoke it. The only hint is "if the
  `Workflow` tool is missing, follow its prose fallback". Unless Claude invokes
  `muster:orchestrator` itself, its body is never in context, before or after compaction.
  Only its one-line description appears in the skill list. `user-invocable: false` hides
  it from the `/` menu and does not load it. Whether a user-typed command's body counts
  as an "invoked skill body" for re-injection is not stated in docs. The orchestrator
  body is about 8.8 KB (roughly 2,200 tokens), under the 5,000-token cap.
- **Affected:** `plugin/commands/go.md`, `plugin/commands/plan.md`,
  `plugin/skills/orchestrator/SKILL.md`.
- **Action:** add an explicit first step, "invoke the `muster:orchestrator` skill", to
  `go.md` and `plan.md`. It costs one Skill call and gets the body re-injected after
  compaction. Keep the must-hold rules at the top, because truncation "keeps the start of
  the file".
- **Effort:** S.

### F3. `/muster:plan` in native plan mode (CONTRADICTS, needs a probe)

- **Quote:** docs/sub-agents: "When the main conversation is in `plan` mode, the subagent
  stays in plan mode whichever `permissionMode` you set". docs/permission-modes: plan
  mode "writes a plan, but does not edit your source", and "edits stay blocked until you
  approve the plan". docs/workflows: "In plan mode, the workflow doesn't start on the
  hook's approval alone, so use a permission rule or your host's approval there instead."
- **Version:** docs current.
- **Impact:** `plan.md` step 4 handles "Session already in native plan mode", but steps 2
  and 3 come first. Step 2 does `git switch -c` and writes CONTEXT.md. In step 3 the
  `muster:plan` planner writes `.muster/runs/<id>/PLAN.md`. Whether plan mode blocks
  writes outside source files is not stated in docs. If it does, the planner fails, or
  every write prompts.
- **Affected:** `plugin/commands/plan.md` (steps 2-4).
- **Action:** probe `/muster:plan` started in plan mode. Then either run steps 2-3 only
  after ExitPlanMode, or have the planner return PLAN.md text that the main thread
  presents via ExitPlanMode and writes after approval.
- **Effort:** S (probe) + S.

### F4. The task-board fact is incomplete (CONTRADICTS, partly)

- **Quotes:**
  - 2.1.233: "Todo/task-tracking tools (TaskCreate/Get/Update/List, TodoWrite) are no
    longer available on Opus 4.8, Sonnet 5, Fable 5, Mythos 5, and newer models".
  - 2.1.268: "Changed the task-tracking tools … to be offered only on Claude 3.x, Opus
    4.0–4.7, Sonnet 4.0–4.6, Haiku 4.5; set `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` elsewhere".
  - docs/tools-reference: "In background sessions and in cloud sessions, Claude Code
    provides the same tools on every model, listed or not."
- **Desktop evidence:** v2.42304.0 (2026-10-15) added "a box at the end of the
  conversation in local and SSH sessions that shows Claude's plan while it works". The
  2026-11-10 transcript shows the box is fed by the host MCP tool
  `mcp__ccd_turn__update_plan`, not by TaskCreate. The session (Desktop, 2.1.321,
  `claude-fable-5-2`) made six `update_plan` calls and no Task tool calls, and had no
  Task tools defined.
- **This answers the owner's screenshot:** the Fable 5.2 live step list is Desktop's plan
  box. "1 running task" and "3 background commands completed" are the background-work
  surface: the Tasks panel (Desktop v1.12603.1) and the output files Read uses since
  TaskOutput's removal in 2.1.277. No release through 2.1.322 re-enabled the tools.
- **Impact:** the orchestrator line "Opus/Sonnet 5.x and Fable have none" is right for
  local terminal and Desktop sessions, but wrong for `claude --bg`, agent-view, cloud
  sessions and cloud scheduled tasks. Those are exactly muster's unattended lanes.
  "Never assume TaskCreate exists" stays correct.
- **Affected:** `plugin/skills/orchestrator/SKILL.md` ("Claude Code facts").
- **Action:**
  1. Reword to "TaskCreate/TodoWrite exist by default only on older models, and in
     background and cloud sessions on any model; never require them".
  2. Optional: in Desktop, when `mcp__ccd_turn__update_plan` is present, use muster's
     stages as its items. Its description says "Do not also write the plan as a numbered
     list in your message", which is compatible with `plan.md` showing PLAN.md as a
     document.
- **Effort:** S.

### F5. The prose fallback assumes synchronous Agent results

- **Quotes:**
  - 2.1.302: "Changed the desktop app and VS Code to always run the main conversation's
    subagents in the background, as the terminal does, rather than let Claude choose".
  - Desktop v3.1623.0 (3P): "Changed subagents in Code tab sessions to run in the
    background even when Claude asks for the foreground, so they keep running after
    Stop".
  - docs/sub-agents: in interactive terminal, VS Code and desktop sessions, "to let
    Claude wait for a subagent, turn off fork mode", via `CLAUDE_CODE_FORK_SUBAGENT=0`.
- **Version:** 2.1.232 (interactive background default), 2.1.302.
- **Impact:** the fallback says "In ONE message, one Agent call per task", then review
  each `done` task. Results now arrive as completion notifications in a later turn, not
  as tool results. The Workflow path is unaffected, because the script awaits its own
  agents.
- **Affected:** `plugin/skills/orchestrator/SKILL.md` (Prose fallback, Build).
- **Action:** say "wait for every executor's completion notification before reviewing;
  do not start review or merge on a partial wave". Note that this is the expected shape
  in Desktop and VS Code.
- **Effort:** M (wording plus a parity test update if one pins the text).

### F6. Use exec form in `hooks.json`, and make the failure mode explicit

- **Quotes:**
  - docs/hooks: "Set `args` whenever the hook references a path placeholder, since each
    element is passed as one argument with no quoting."
  - 2.1.295: "Added `onFailure: \"block\"` for command and HTTP hooks".
  - 2.1.299: "Fixed PreToolUse and PermissionRequest hooks that set no shell failing open
    when Git for Windows isn't installed; a guard that fails now blocks the call."
  - Desktop v2.42304.0 (3P): "if it sets none of `shell`, `args`, or `onFailure`, it now
    blocks the tool call."
- **Version:** 2.1.295, 2.1.299; Desktop v2.42304.0, v4.16336.0.
- **Impact:** `hooks.json` runs
  `node "${CLAUDE_PLUGIN_ROOT}/hooks/pre-tool-use.js"` in shell form. On a Windows PC
  without Git for Windows, a failure of that hook now blocks every Bash, PowerShell and
  MCP call. That contradicts `pre-tool-use.js`'s FAIL-SAFE contract and the
  bypass-training rule.
- **Affected:** `plugin/hooks/hooks.json`.
- **Action:** use
  `{"type":"command","command":"node","args":["${CLAUDE_PLUGIN_ROOT}/hooks/pre-tool-use.js"],"onFailure":"continue"}`.
  Exec form removes the shell dependency, and the explicit `continue` records the
  fail-open decision.
- **Effort:** S.

### F7. Desktop WSL sessions have no plugins, so muster is absent there

- **Quote:** docs/desktop-wsl: "**Plugins**: not available in WSL sessions".
- **Version:** docs current (2026-11-10).
- **Impact:** a Desktop Code-tab session inside WSL loads no muster commands, skills,
  agents, hooks or workflows. The orchestrator's "if the `Workflow` tool is missing"
  fallback cannot help, because nothing of muster loads. The owner works in WSL.
- **Affected:** user-facing install and troubleshooting docs (website, README),
  `plugin/skills/orchestrator/SKILL.md` (the fallback's surface note).
- **Action:** document "Desktop WSL sessions: use a local or SSH session, or the CLI
  inside WSL". Nothing in the docs offers a workaround.
- **Effort:** S.

### F8. Environment variables can override muster's tier map

- **Quotes:**
  - env-vars: `CLAUDE_CODE_EFFORT_LEVEL` "Takes precedence over `--effort`, `/effort`,
    and the `modelSettings` and `effortLevel` settings".
  - docs/sub-agents: the Agent `effort` parameter "overrides the `effort` field", and
    "The `CLAUDE_CODE_EFFORT_LEVEL` environment variable takes precedence over both."
  - 2.1.257: `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` applies one model "ignoring per-spawn and
    agent-definition model overrides".
  - 2.1.296: `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL` will "run every workflow agent on one
    model while other subagents keep theirs".
  - 2.1.316: `CLAUDE_CODE_SUBAGENT_EFFORT` sets the effort subagents run at "when nothing
    else names one".
- **Version:** 2.1.257-2.1.316. Whether `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL` beats a
  script's per-agent `model` is not stated in docs.
- **Impact:** `args.models[seat]` (contracts amendment 3) can be silently replaced. A
  receipt would then report the intended model, not the one that ran.
- **Affected:** `docs/strategy/stage-2-contracts.md` (amendment 3), `muster preflight`
  (code, other track).
- **Action:** have preflight report these variables when set, and mark the tier map
  "overridden by env". The Agent `effort` parameter (2.1.292) confirms the orchestrator's
  existing claim, so no change is needed there.
- **Effort:** S.

### F9. `resumeFromRunId` works in the same session only

- **Quote:** SDK reference: `resumeFromRunId` … "Same session only". docs/workflows: "In a
  fresh session, Claude has no earlier run to relaunch and starts the workflow over", and
  a missing run fails with "a `nothing to resume` error instead of starting the run over
  on its own".
- **Version:** docs current.
- **Impact:** `go.md` step 5 says "Interrupted? Resume with `{name:"muster:build",
  resumeFromRunId}`". After a crash or a new session that fails, unless the user ran
  `claude --resume`. The orchestrator already says "A killed run resumes with
  `/muster:go --run <runId>`". The two need to agree.
- **Affected:** `plugin/commands/go.md` step 5, `plugin/skills/orchestrator/SKILL.md`.
- **Action:** "same session (or after `claude --resume`): `resumeFromRunId`; otherwise
  `/muster:go --run <runId>`, which re-runs the build with idempotent executors". Live
  probe §2's warning still applies: a killed agent's shell command keeps running, so
  side effects can repeat.
- **Effort:** S.

### F10. Unattended runs should never wait on a prompt

- **Quote:** 2.1.319: "Added `permissions.denyInsteadOfPrompting` setting: a tool call
  that would wait on a permission prompt is denied and the turn continues, in terminal
  sessions, subagents and teammates". `claude --help` (2.1.319): `--permission-prompts
  <target>` takes "host" or "none", where none means "nobody: anything that would prompt
  is denied automatically".
- **Version:** 2.1.319.
- **Impact:** `go.md`'s unattended path (`claude -p`, cloud scheduled tasks) can stall or
  fail on a prompt nobody answers.
- **Affected:** `plugin/commands/go.md` (Unattended notes), user docs for scheduled runs.
- **Action:** recommend `--permission-prompts none` for `-p`, and
  `permissions.denyInsteadOfPrompting` in the settings of scheduled environments. A
  denied call surfaces as a tool error, which muster's escalation path already handles.
- **Effort:** S.

### F11. Workflow consent is a one-time choice in manual and accept-edits modes, not per run

- **Quote:** docs/workflows: "Manual, accept edits | Every run, unless you've selected
  **Yes, and don't ask again** for that workflow in this project", offered "when you run
  a bundled, saved, or plugin workflow by name". "Auto | First launch only." Desktop: "an
  approval card … with **Once**, **Always**, and **Deny** actions".
- **Version:** docs current.
- **Impact:** the orchestrator's "Workflow consent is per run in manual and accept-edits
  modes" overstates the friction.
- **Affected:** `plugin/skills/orchestrator/SKILL.md` ("Claude Code facts").
- **Action:** tell users to pick "don't ask again" (CLI) or "Always" (Desktop) once per
  project for `muster:plan`, `muster:build` and `muster:backlog`. Keep the named allow
  rules for `-p`.
- **Effort:** S.

### F12. Record the Workflow runtime limits in the contracts

- **Quote:** docs/workflows: "Up to 16 concurrent agents by default"
  (`CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS`, v2.1.269+); "1,000 agents total per
  run". The `Large workflow` warning appears "When a workflow schedules more than 25
  agents, or its projected token total passes 1.5 million", and "doesn't pause or limit
  the run". 2.1.271 "lowered the medium size guideline from 15 to 10 agents" (advice to
  Claude-written scripts only).
- **Impact:** a 5-item `muster:backlog` run with several tasks each (executor, reviewer,
  up to 2 fixers, verifier) passes 25 agents and shows the warning. That is expected.
  Waves wider than 16 tasks queue.
- **Affected:** `docs/strategy/stage-2-contracts.md` (Workflow scripts).
- **Action:** add a limits note, and tell users the large-run warning is expected for
  backlogs.
- **Effort:** S.

### F13. Unattended workflows don't pause at usage limits

- **Quote:** docs/workflows: at a usage limit "the run pauses rather than failing that
  agent", but "A run doesn't pause in non-interactive mode with `claude -p` or the Agent
  SDK, in a background session, or in a Remote Control" session.
- **Version:** 2.1.271 (pause added), docs current.
- **Impact:** in `-p` and cloud runs, agents fail at the limit. The `agent()` wrapper
  turns that into `{status:"error"}`, and the run escalates. That behavior is correct,
  but it should be named.
- **Affected:** `docs/strategy/stage-2-contracts.md`, `plugin/commands/go.md`.
- **Action:** document the outcome. `/muster:go --run` is the retry.
- **Effort:** S.

### F14. Consider `omitClaudeMd` for brief-only agents

- **Quote:** 2.1.271: "Added `omitClaudeMd` to agent frontmatter and `--agents` JSON,
  letting custom and plugin subagents run without user, project and local CLAUDE.md
  files". docs: "Use it for subagents that take everything they need from the delegation
  prompt."
- **Impact:** `muster-plan-checker` and `muster-investigator` work from the brief and
  `muster plan-lint`. Omitting CLAUDE.md cuts their startup context. The executor,
  reviewer and planner should keep CLAUDE.md, because they need project conventions.
  That is a judgment call; review it before adopting.
- **Affected:** `plugin/agents/muster-plan-checker.md`, `muster-investigator.md`.
- **Effort:** S.

### F15. A subagent that hits `maxTurns` returns partial output

- **Quote:** 2.1.246: "a subagent that stops at its `maxTurns` limit now returns its
  output marked as partial, with a hint to continue it via `SendMessage`, instead of
  appearing finished".
- **Impact:** `muster-executor` has `maxTurns: 25`. How a schema-bound Workflow agent
  behaves at the turn limit is not stated in docs. Expect the schema retry, then a
  throw, which the wrapper turns into an error.
- **Affected:** `plugin/agents/muster-executor.md`, `plugin/workflows/build.js`.
- **Action:** watch for executor errors that are really turn limits. Raise `maxTurns`
  if they appear.
- **Effort:** S.

### F16. Ship the CLI through plugin `bin/`

- **Quote:** docs/plugins/components: "Files in `bin/` at the plugin root are on the
  `PATH` of the Bash tool's shell while the plugin is enabled, so Claude can run them as
  bare commands." Exception: "a sandboxed PowerShell command doesn't" find them.
- **Impact:** commands spell out `sh "${CLAUDE_PLUGIN_ROOT}/runtime/muster.sh"` and
  repeat it in every Bash call. A `plugin/bin/muster` wrapper would turn each call into
  `muster preflight …`. That means fewer tokens and no quoting of plugin paths that
  contain spaces.
- **Affected:** `plugin/commands/*.md`, new `plugin/bin/muster`, the tests that pin the
  `M` text.
- **Effort:** M.

### F17. Add a plugin eval suite

- **Quote:** 2.1.269: "Added `claude plugin eval`: run a plugin's eval suite against
  Claude Code and get scored, reproducible results (JSON + HTML report)". 2.1.299 added
  `--disallow-tools` and the `disallowed_tools` case field.
- **Impact:** this gives regression coverage for command and skill behavior in a real
  harness, beyond the current unit tests. `/doctor prompt-audit` (2.1.283) and
  `/skill-doctor` (2.1.261) are cheap manual checks of the same surface.
- **Affected:** new `plugin/evals/` (manifest key `experimental.evals`).
- **Effort:** M-L.

### F18. The fence hook also fires on Desktop's own MCP tools

- **Evidence:** the Desktop host's tools are named `mcp__ccd_turn__update_plan`,
  `mcp__ccd_turn__wrap_up` and `mcp__ccd_session__*` (transcript, 2026-11-10). They match
  the `mcp__.*` matcher. [OBSERVED]
- **Impact:** every plan update spawns `node`. `classifyToolName` returns null for all
  six names, so this is a cost problem only.
- **Affected:** `plugin/hooks/hooks.json`.
- **Action:** optionally narrow the matcher to `Bash|PowerShell|mcp__(?!ccd_).*`. Matchers
  are JavaScript regex, per docs/hooks.
- **Effort:** S.

### F19. Update stale vocabulary

- **Quote:** docs/routines: "A cloud scheduled task, formerly a routine". 2.1.222:
  "Removed ultraplan feature".
- **Affected:** `plugin/commands/go.md` and `plan.md` ("Unattended (Routine, `claude
  -p`)").
- **Action:** say "cloud scheduled task".
- **Effort:** S.

### F20. The built-in Concise output style overlaps muster's

- **Quote:** 2.1.237: "Added a built-in \"Concise\" output style: Claude leads with
  results and skips preamble and narration, while doing the work just as thoroughly."
- **Affected:** `plugin/output-styles/muster.md`.
- **Action:** decide whether muster's style still adds anything over Concise. Its
  glass-box decision line does; the brevity rules mostly don't.
- **Effort:** S.

## Confirmed: no change needed

- **One `hooks.json` fence, no frontmatter hooks.** Live probe §1 showed that frontmatter
  hooks don't fire in subagents, don't survive `--resume`, and are broken in plugin
  `commands/*.md`. 2.1.304 also caps skill hooks. The current design already relies on
  the single registration plus on-disk run markers.
- **TaskOutput is removed.** 2.1.277: "Removed the deprecated TaskOutput tool; Claude
  reads a background task's output file with Read instead". The orchestrator already
  says so.
- **Workflow agents can't nest.** docs/sub-agents removes `Workflow` from every
  subagent, and the probe saw no Agent tool in workflow agents. The orchestrator's
  "one nesting level" and `backlog.js` inlining stand.
- **Agent tool parameters.** `model` (aliases only), `effort` (2.1.292) and
  `isolation: "worktree"` all exist, as the orchestrator says. The SDK typing also lists
  `isolation: "remote"`, which the docs prose does not describe.
- **Agent tool lists.** Every tool muster's agents list (`Read`, `Write`, `Edit`, `Bash`,
  `Grep`, `Glob`) is in the background-subagent keep list. On macOS, Linux and WSL a
  subagent "can also receive the Glob and Grep tools when the main conversation doesn't
  have them".
- **Workflow allow rules.** The named form `Workflow(muster:<name>)` is consistent with
  docs ("`Workflow(<name>)` to approve one saved workflow by name") and with the probe.
- **No 200-spawn cap to plan around.** 2.1.224: "Removed the 200-subagent-per-session
  spawn cap". Concurrency stays at 20 and depth at 3.

## Contradictions with the current design, summarized

| Finding | Design statement | What the sources say |
|---|---|---|
| F1 | Executors in `isolation:"worktree"` start from the work branch (contracts: wave N>1 executors merge earlier waves; brief step 2 checks the base) | Default `worktree.baseRef: "fresh"` branches agent-isolation worktrees from `origin/<default>`; Workflow worktrees: not stated in docs |
| F2 | "The **orchestrator** skill holds the rules that survive compaction" | Only invoked skill bodies are re-injected; nothing invokes it |
| F3 | `/muster:plan` works inside native plan mode and ends in ExitPlanMode | Subagents "stay in plan mode"; plan mode does not edit source; writes to `.muster/` not stated |
| F4 | "No task board on current models … Opus/Sonnet 5.x and Fable have none" | True for local terminal and Desktop sessions; false for background and cloud sessions; Desktop draws its own checklist |
| F6 | The fence is fail-open on any error | A shell-form PreToolUse hook that fails on Windows without Git for Windows now blocks the call |
| F11 | "Workflow consent is per run in manual and accept-edits modes" | A one-time "don't ask again" per project exists for plugin workflows |
