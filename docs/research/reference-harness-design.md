# Reference harness design — a buildable agent-harness spec distilled from seven harnesses

Capstone synthesis for `harness-internals-research`. This document distills seven researched agentic harnesses into (Part A) the universal anatomy every one of them shares, stated at a depth a competent team could rebuild a minimal CLI+desktop agent harness from; (Part B) the load-bearing design decisions, each attributed to the harness that taught it; (Part C) muster's augmentation-vs-enforcement doctrine and per-harness port surface; and (Part D) a contradictions ledger. Every claim cites one of the seven research docs, a burn decision record, or muster's shipping code, by anchor resolving in the Sources list at the end. [src: cc-loop] [src: hermes-port]

The seven harnesses (by research doc): Claude Code CLI [src: cc-loop], Claude Code Desktop/Web [src: ccd-arch], Claude Cowork [src: cw-loop], OpenAI Codex CLI [src: cx-loop], Codex/ChatGPT Desktop [src: cxd-arch], "GPT Work" / OpenAI Agents SDK [src: gw-sdk], and Hermes Agent (Nous Research) [src: hermes-loop]. Where a numeric claim is internally implausible it is marked **[UNVERIFIED-SUSPECT]** and never stated as fact — see Part D. [src: hermes-scale]

## Part A — Universal agent-harness anatomy

Nine components appear, under different names, in all seven harnesses. Each subsection gives the buildable design first, then a comparison row per harness. [src: cc-loop] [src: hermes-loop]

### A1. The agent loop

**Design.** Build ONE homogeneous request/response loop, not a planner/executor/verifier state machine. Per user turn: (1) assemble context — system prompt + instruction files + tool definitions + prior transcript, subject to compaction; (2) issue one Messages-API-shaped model call; (3) the model streams a single assistant message whose content array interleaves `thinking`/`text`/`tool_use` blocks; (4) for each `tool_use`, resolve permission then execute, dispatching independent calls as a concurrent batch; (5) append each result as a `tool_result` block inside the next user-role message; (6) repeat until the assistant stops requesting tools (`stop_reason ≠ tool_use`), then fire the turn-end event. "Plan" and "verify" are overlays on this single loop, not phases: plan is a read-only permission-mode gate, verify is a turn-end block gate. [src: cc-loop] [src: gw-sdk]

| Harness | Loop primitive | Termination signal |
|---|---|---|
| Claude Code CLI | gather→act→verify, one tool-use loop; `PostToolBatch` after each parallel batch [src: cc-loop] | `stop_reason ≠ tool_use` → `Stop` event [src: cc-loop] |
| Codex CLI | Thread→Turn→Items event stream (`codex exec --json`) [src: cx-loop] | `turn.completed` carries token usage [src: cx-loop] |
| Hermes | `AIAgent.run_conversation`; strict role alternation; interruptible background API thread [src: hermes-loop] | final text vs tool_calls loop; 90-turn default budget [src: hermes-loop] |
| Agents SDK | `Runner.run` loop: call LLM → final_output / handoff / tool calls → re-run [src: gw-sdk] | text output with no tool calls; `max_turns` else `MaxTurnsExceeded` [src: gw-sdk] |
| Cowork | 5-step: plan→decompose→run in sandbox→parallel coordinate→deliver [src: cw-loop] | free-form plan, no exposed task graph [src: cw-loop] |
[src: cc-loop] [src: cx-loop] [src: hermes-loop] [src: gw-sdk] [src: cw-loop]

**Context assembly + compaction** is the only subtle part. Load order (broad→narrow) is system prompt → instruction files (walk cwd→root, closest wins) → memory → tool names → skill descriptions; deliver instruction files as a user message, not inside the system prompt, so prompt-cache reuse survives. When context nears the limit, drop old tool outputs first, then summarize the middle while preserving a tail of recent messages; re-inject the root instruction file from disk afterward because summarization loses it. [src: cc-context] [src: hermes-loop]

### A2. Tool dispatch and registry

**Design.** A registry maps tool name → {JSON schema, handler, availability check}. On each `tool_use`: validate input against schema, run an availability gate (env/binary/service present), dispatch, and wrap all errors as well-formed JSON the model can read and recover from. Spill oversized outputs to disk and replace them in-context with a pointer + preview. At scale, defer tool schemas — load only names up front, fetch full schemas on demand — to keep context cheap. [src: cc-mcp] [src: hermes-loop]

| Harness | Registry mechanism | Scale strategy |
|---|---|---|
| Claude Code CLI | fixed built-in roster + `mcp__*`; binary carries a broader agent-teams surface [src: cc-mcp] | `ToolSearch` deferred schemas (`ENABLE_TOOL_SEARCH`) [src: cc-mcp] |
| Codex CLI | `shell`/`unified_exec` (PTY)/`apply_patch`/`web_search`/MCP/skills [src: cx-loop] | interception is partial by design (§B2) [src: cx-hooks] |
| Hermes | AST-discovered self-registering `tools/*.py`; `check_fn` drops unavailable tools [src: hermes-loop] | ~70+ tools; schema patched to survivors (anti-hallucination) [src: hermes-loop] |
| Agents SDK | function/hosted/agents-as-tools/MCP; `tool_type` enum [src: gw-sdk] | concurrent local dispatch, `max_function_tool_concurrency` cap [src: gw-sdk] |
| Cowork | agent-owned; an MCP server cannot spawn or list tools for the loop [src: cw-subagents] | MCP-only capability surface [src: cw-mcp] |
[src: cc-mcp] [src: cx-loop] [src: hermes-loop] [src: gw-sdk] [src: cw-subagents]

### A3. Permission / approval model

**Design.** Put a layered veto in front of every side-effecting tool call: (1) declarative rules (allow/ask/deny, deny-wins, merged across config scopes) → (2) a mode or classifier gate → (3) a programmatic hook decision → (4) for shell only, an OS-level sandbox boundary. Any layer can deny independent of the others. The load-bearing choice is which layers are HARD (harness-enforced, the model cannot route around them) vs advisory (the model can equivalently reach the goal another way). [src: cc-perm] [src: cx-hooks]

| Harness | Native gate | Hard vs advisory |
|---|---|---|
| Claude Code CLI | rules (deny→ask→allow) + modes + `auto` classifier + PreToolUse hook + Bash sandbox [src: cc-perm] [src: cc-sandbox] | PreToolUse `deny` is a true pre-execution veto — HARD [src: cc-hooks] |
| Codex CLI | `sandbox_mode`/`approval_policy`; PreToolUse hook | PreToolUse is "a guardrail rather than a complete enforcement boundary"; unified_exec/subagent/non-shell unintercepted — ADVISORY [src: cx-hooks] |
| Hermes | dangerous-pattern interception (`DANGEROUS_PATTERNS`) + `approvals.deny` globs [src: hermes-approval] | permissive by default; `pre_tool_call` block + deny globs are HARD, rest advisory [src: hermes-approval] |
| Agents SDK | default approval-FREE; `needs_approval` predicates + guardrails, opt-in [src: gw-hitl] | strong once engaged (durable `RunState` pause/resume), nothing gates unless declared [src: gw-hitl] |
| Cowork | UI-modal Manual/Auto/Skip + hard delete-approval [src: cw-loop] | native, but not hookable by an MCP integrator — advisory for muster [src: cw-augment] |
[src: cc-perm] [src: cx-hooks] [src: hermes-approval] [src: gw-hitl] [src: cw-loop]

### A4. Session persistence and the transcript

**Design.** Persist an append-only event log keyed by `(cwd-slug, session-id)` — not just a message array: log hook firings, mode changes, compaction, and PR links as first-class record types alongside conversational turns. This enables resume (append in place), fork (mint a new id), and rewind (pre-edit file snapshots). Namespace subagent transcripts and spilled tool outputs under the same key. [src: cc-sessions]

| Harness | Store | Notable |
|---|---|---|
| Claude Code CLI | plaintext JSONL under `~/.claude/projects/<slug>/`; `uuid`/`parentUuid` DAG [src: cc-sessions] | resume = in-place append + `bridge-session` marker [src: cc-sessions] |
| Codex Desktop/CLI | rollout files; SQLite-backed thread/turn metadata; `thread/*` app-server API [src: cxd-arch] | one `CODEX_HOME` shared by CLI/IDE/app-server [src: cxd-config] |
| Hermes | SQLite `state.db` (WAL), FTS5 `messages_fts`, `state_meta` K/V, schema v21 [src: hermes-kanban] | `session_search` = agent queries its own past [src: hermes-kanban] |
| Agents SDK | pluggable Session backends (SQLite/Redis/Encrypted/Conversations) [src: gw-sandbox] | `RunState` durable JSON for cross-process resume [src: gw-hitl] |
| Desktop/Web | each surface keeps its own history; cloud = fresh VM per session [src: ccd-web] | web commits carry a `Claude-Session:` git trailer [src: ccd-web] |
[src: cc-sessions] [src: cxd-config] [src: hermes-kanban] [src: gw-hitl] [src: ccd-web]

### A5. Subagent orchestration and isolation

**Design.** A subagent is a nested instance of the same loop with its OWN context window — not a continuation of the parent's. It inherits configuration (tools/MCP/skills) but NOT conversation history or memory; the parent hands it a task brief in place of a user message, and only its final summary re-enters the parent. Isolate filesystem work in a git worktree. Bound nesting depth and concurrency — fan-out multiplies token spend, and unbounded depth is a quota bomb. [src: cc-subagents] [src: hermes-delegation]

| Harness | Dispatch | Isolation + limits |
|---|---|---|
| Claude Code CLI | `Agent` tool (`subagent_type`, `model`, `isolation: worktree`) [src: cc-subagents] | own context; nesting ≤5; worktree shell-lock (v2.1.203+) [src: cc-subagents] |
| Codex CLI | `collaboration.spawn_agent`/`wait_agent`/`list_agents`; `fork_turns:"none"` [src: cx-subagents] | `agents.max_threads`(6)/`max_depth`(1); NO cwd field on dispatch [src: cx-subagents] |
| Hermes | `delegate_task(goal,context,toolsets,role)`; parallel batches [src: hermes-delegation] | fresh context; depth-1 default; `hermes -w` worktrees [src: hermes-worktree] |
| Agents SDK | agents-as-tools + handoffs; per-agent `model`, `RunConfig.model` [src: gw-sdk] | Sandbox agents beta: `Manifest` + capabilities + resumable [src: gw-sandbox] |
| Cowork | agent-owned parallel fan-out; steered by prompt only [src: cw-subagents] | no dispatch API; per-item worktree isolation absent [src: cw-subagents] |
[src: cc-subagents] [src: cx-subagents] [src: hermes-delegation] [src: gw-sandbox] [src: cw-subagents]

### A6. Extension / plugin model (skills)

**Design.** A skill is a directory with a `SKILL.md` (frontmatter `name` + `description` required) using progressive disclosure — only names/descriptions load into context, the full body loads on invocation. A plugin bundles skills + hooks + subagents + MCP servers behind a manifest, distributed via marketplace JSON catalogs and installed into a per-user cache. `SKILL.md` (the agentskills.io open standard) is the near-universal unit. [src: cc-skills] [src: hermes-skills]

| Harness | Skill format | Plugin/distribution |
|---|---|---|
| Claude Code CLI | `SKILL.md`; 1,536-char description cap; `context:fork` [src: cc-skills] | plugin dir + `.claude-plugin/plugin.json`; `${CLAUDE_PLUGIN_ROOT}` [src: cc-skills] |
| Codex CLI/Desktop | `SKILL.md` (agent-skills standard); 2% context budget; `$`-invoke [src: cx-skills] | `.codex-plugin/plugin.json`; marketplaces incl. legacy `.claude-plugin/` [src: cx-skills] |
| Hermes | `SKILL.md` "compatible with agentskills.io"; every skill = a slash command [src: hermes-skills] | Python plugins `register(ctx)`; skills-hub taps (anthropics/openai/hf) [src: hermes-skills] |
| Agents SDK | skills as a hosted-tool/sandbox capability, host-dir lazy-load [src: gw-sandbox] | Apps SDK / Plugins Directory (MCP apps) [src: gw-sdk] |
| Cowork | plugins bundle skills; shared Claude Code plugin format [src: cw-plugins] | uploaded files or GitHub marketplaces; skills=`/` menu [src: cw-plugins] |
[src: cc-skills] [src: cx-skills] [src: hermes-skills] [src: gw-sandbox] [src: cw-plugins]

### A7. Hook / lifecycle model

**Design.** Fire named lifecycle events (session start/end, prompt submit, pre/post tool, pre/post compact, subagent start/stop, turn stop). A handler receives a JSON payload on stdin — `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, plus `tool_name`/`tool_input` on tool events and `agent_id`/`agent_type` inside subagents — and answers via exit code + JSON on stdout, where a "block" decision differs by event family. Trust-gate non-managed hooks against their exact hash. [src: cc-hooks]

| Harness | Events | Block contract |
|---|---|---|
| Claude Code CLI | 31 named events; matcher-less subset; 3-level config [src: cc-hooks] | PreToolUse `permissionDecision`; block-family `decision:"block"` [src: cc-hooks] |
| Codex CLI | SessionStart/UserPromptSubmit/Pre-Post ToolUse/Subagent/Stop; trust-gated [src: cx-hooks] | advisory: PreToolUse can deny only a narrow interception set [src: cx-hooks] |
| Hermes | plugin hooks + shell hooks + gateway hooks; `pre_llm_call`/`pre_verify` [src: hermes-hooks] | `pre_tool_call` → `{"action":"block"}`; non-blocking on error [src: hermes-hooks] |
| Agents SDK | `RunConfig` hooks: `call_model_input_filter`, `tool_error_formatter` [src: gw-sdk] | no lifecycle-hook block; gating is `needs_approval` [src: gw-hitl] |
| Cowork | none for an MCP integrator; plugin hooks "run only in Cowork" [src: cw-plugins] | no external register point [src: cw-augment] |
[src: cc-hooks] [src: cx-hooks] [src: hermes-hooks] [src: gw-sdk] [src: cw-plugins]

### A8. MCP client

**Design.** Every harness is an MCP client: configure stdio/HTTP servers, namespace tools `mcp__<server>__<tool>`, read the server `instructions` field as session guidance, and govern per server (enabled / required / allow-deny tool lists / approval mode). Defer tool schemas by default. MCP is the universal capability bus and, on the weakly-enforcing harnesses, the MOST governable surface. [src: cc-mcp] [src: cx-mcp]

| Harness | Config | Governance |
|---|---|---|
| Claude Code CLI | local/project/user scopes; `.mcp.json`; `alwaysLoad` [src: cc-mcp] | project-server approval prompt; `requiresUserInteraction` [src: cc-mcp] |
| Codex CLI | `[mcp_servers.*]` in shared `config.toml` [src: cx-mcp] | `required`, `enabled_tools`/`disabled_tools`, per-tool approval — HARD [src: cx-mcp] |
| Hermes | `mcp_servers.<name>`; OAuth DCR/PKCE; `mcp_<server>_<tool>` [src: hermes-mcp] | include/exclude filters; can run AS an MCP server [src: hermes-mcp] |
| Agents SDK | `HostedMCPTool`/StreamableHttp/Stdio; connectors by `connector_id` [src: gw-sdk] | static/dynamic tool filters; `require_approval` [src: gw-hitl] |
| Cowork | `claude_desktop_config.json` local + MCPB + remote connectors [src: cw-mcp] | remote connectors cloud-brokered, undiscoverable [src: cw-mcp] |
[src: cc-mcp] [src: cx-mcp] [src: hermes-mcp] [src: gw-sdk] [src: cw-mcp]

### A9. Config topology, auth, quota

**Design.** Resolve config across layers (managed > CLI > local > project > user): scalars override, but permission rules MERGE with deny-from-anywhere winning. Keep one per-user state root (`~/.claude`, `~/.codex`, `~/.hermes`) for config/auth/sessions/skills. Make repo-scoped config the portable plane — it is the only layer that reaches remote/cloud placements. Auth is subscription-OAuth or API key; meter quota against a shared pool, which is the burn hazard. [src: cc-config] [src: cxd-quota]

| Harness | State root | Quota model |
|---|---|---|
| Claude Code CLI | `~/.claude` (+`CLAUDE_CONFIG_DIR`); `~/.claude.json` catch-all [src: cc-config] | subscription or API key; MCP defers to save context [src: cc-config] |
| Codex Desktop/CLI | one `CODEX_HOME`; Windows/WSL split-home hazard [src: cxd-config] | local+cloud share one 5h window; Luna is the budget lane [src: cxd-quota] |
| Hermes | `~/.hermes` per profile; managed scope pins keys via root files [src: hermes-config] | 18+ providers, credential pools, per-task auxiliary model slots [src: hermes-config] |
| Agents SDK | `OPENAI_API_KEY`; per-run tracing key [src: gw-sdk] | standard API model pricing [src: gw-sdk] |
| Desktop/Web | repo `.claude/` reaches cloud; `~/.claude` never does [src: ccd-config] | cloud VM per session; managed settings server-fetched [src: ccd-web] |
[src: cc-config] [src: cxd-quota] [src: hermes-config] [src: gw-sdk] [src: ccd-config]

## Part B — Design decisions (with the harness that taught each)

### B1. Agent loop + context/compaction — keep it one loop, treat compaction as context management

**Choice:** a single tool-use loop with a context-assembly step and a compaction step, not a hardwired phase machine. **Alternatives observed:** Cowork exposes a 5-step plan/decompose/execute framing but with no task-graph object or gate [src: cw-loop]; the Agents SDK offers explicit code-driven orchestration (routing, chaining, evaluator loops) as an alternative to LLM-driven planning [src: gw-sdk]. **Taught by Claude Code CLI**, whose binary teardown shows the naked loop is one homogeneous request/response cycle with plan/verify as overlays, and whose compaction preserves a recent tail while summarizing the middle and re-injects the root instruction file from disk. [src: cc-loop] [src: cc-context]

### B2. Permission model — the HARD advisory-vs-enforcement lesson

**Choice:** treat exactly one layer as a hard pre-execution veto and everything else as advisory; put deterministic enforcement in the orchestrator's own code, not in hooks the harness lets the model route around. **Alternatives observed:** Claude Code's PreToolUse `deny` IS a hard veto the model cannot forge [src: cc-hooks]; but Codex states its PreToolUse is "a guardrail rather than a complete enforcement boundary" because `unified_exec`, subagent tool work, and non-shell tools are unintercepted [src: cx-hooks], and Hermes hooks are "non-blocking on error" and permissive by default [src: hermes-approval]. **Taught by the Codex burn**, encoded in the decision records: the `codex-efficiency-enforcement` contract was **retired, not rescoped**, because its fail-closed clauses were "architecturally unreachable against Codex's own dispatch… the teardown did not remove a working fail-closed mechanism, it never existed" — every future enforcement item must be "scoped explicitly against what Codex's hook/dispatch model can actually enforce (advisory diagnostics, not blocking control)." [src: dr-efficiency] The corollary lesson is that even enforceable gates must fail *open* and carry per-gate overrides, or false denials teach users to disable guards globally. [src: cc-hooks]

### B3. Subagent isolation — worktrees are the universal primitive

**Choice:** isolate each subagent/wave in a git worktree with its own branch, and pass an absolute working directory in the brief. **Alternatives observed:** Claude Code `isolation: worktree` (auto-cleaned, shell-locked) [src: cc-subagents]; Hermes `hermes -w` / kanban `worktree` workspaces + per-worktree checkpoint managers [src: hermes-worktree]; Desktop makes worktree-per-session automatic under `<root>/.claude/worktrees/` [src: ccd-config]; the Agents SDK Sandbox-agent `Manifest` stages files into a fresh sandbox [src: gw-sandbox]. **Taught jointly by Claude Code and Hermes**, and sharpened by Codex's counter-example: Codex has NO cwd field on subagent dispatch, so isolation there is muster's own dispatch discipline verified by path/base-SHA receipts, not a harness guarantee. [src: cx-subagents]

### B4. The hook payload contract — Claude Code block-JSON is the de-facto standard

**Choice:** write hooks once against the Claude Code payload/response contract (`{session_id, transcript_path, cwd, tool_name, tool_input, hook_event_name}` in; `{"decision":"block","reason":…}` / `hookSpecificOutput.permissionDecision` out). **Alternatives observed:** Codex accepts the same event names and a near-identical JSON contract with documented divergences [src: cx-hooks]; the Agents SDK has no lifecycle-hook block at all, only `needs_approval` [src: gw-hitl]. **Taught by Hermes**, which is explicit: shell-hook responses "accept the Claude-Code Stop shape `{"decision":"block","reason":…}` alongside the Hermes-canonical `{"action":"block","message":…}`," and Claude Code's `UserPromptSubmit` "deliberately maps to `pre_llm_call`" — an independent harness adopting Claude Code's wire format verbatim is the strongest evidence it is the portable standard. [src: hermes-hooks]

### B5. Extension format — SKILL.md / agentskills.io is near-universal

**Choice:** ship behavior as `SKILL.md` skills with progressive disclosure and let each be a slash command. **Alternatives observed:** Claude Code, Codex, and Cowork all read the same plugin/`SKILL.md` structure (Codex marketplaces even read the legacy `.claude-plugin/marketplace.json`) [src: cc-skills] [src: cx-skills] [src: cw-plugins]; the Agents SDK treats skills as a sandbox capability rather than a document format [src: gw-sandbox]. **Taught by Hermes**, which states its skills are "compatible with the agentskills.io open standard," reads AGENTS.md and even CLAUDE.md, and ingests GitHub taps from `anthropics/skills` and `openai/skills` — the convergence point across three vendors. [src: hermes-skills]

### B6. MCP as the universal bus — and the most governable surface where hooks are weak

**Choice:** expose orchestration state and deterministic tools as an MCP server; rely on schema deferral so a large catalog costs only names. **Alternatives observed:** every harness is an MCP client [src: cc-mcp] [src: hermes-mcp] [src: gw-sdk]; Cowork's ENTIRE integration plane is MCP because it exposes no external hook point [src: cw-mcp]. **Taught by Codex**, whose docs make MCP the one fully hook-matchable, policy-governable tool class (`required = true`, allow/deny lists, per-tool approval modes are harness-enforced) — "use MCP (not hooks) when a gate genuinely must gate." [src: cx-mcp] [src: cx-augment]

### B7. Desktop process architecture + repo-`.claude/` as the universal config plane

**Choice:** build the desktop/IDE surface as a thin shell over the SAME engine (embedded via an SDK/app-server), and make repo-committed config the plane that reaches every placement. **Alternatives observed:** Claude Desktop embeds the engine as an Agent SDK host behind a web-delivered UI, surfaces shell capabilities to the loop as reserved MCP servers (`ide`, `Claude Preview`, `Claude Browser`), and its cloud VMs read only the repo's `.claude/` — "nothing from `~/.claude/` on your machine" applies [src: ccd-arch] [src: ccd-ide] [src: ccd-web]; Codex Desktop drives one Rust core through a JSON-RPC app-server shared by CLI/IDE, one `CODEX_HOME` for all local surfaces [src: cxd-arch] [src: cxd-config]; "GPT Work" is literally Codex wearing a deliverables skin — same AGENTS.md/skills/hooks/MCP surface, no separate harness [src: gw-verdict]. **Taught by Claude Desktop/Web:** the only strategy that survives every non-terminal surface is "put everything in the repo," because repo-scoped `.claude/` is the sole config plane reaching cloud sessions. [src: ccd-config]

### B8. Config/auth/quota topology — one state root, layered merge, shared-pool burn

**Choice:** one per-user state root, layered config where scalars override but permission rules merge deny-wins, and explicit budget discipline because quota is a shared pool. **Alternatives observed:** Hermes managed scope pins keys via root-owned `/etc/hermes/*` that even the shell env cannot override [src: hermes-config]; Codex enterprise `requirements.toml` constrains what any layer may set [src: cx-config]. **Taught by the Codex burn + Desktop quota model:** desktop Codex turns and CLI turns are both "local messages" against one shared 5-hour window, and "ChatGPT Work and Codex share usage" — a heavy desktop session plus a CLI sprint drain one pool, which is the mechanism behind the two-day $100 burn; the shipped discipline is 25-step ceilings, one follow-up, deferred broad suites, and respecting `agents.max_threads`. [src: cxd-quota] [src: cx-subagents] [src: dr-efficiency]

## Part C — Muster synthesis: the augmentation-vs-enforcement doctrine

**Doctrine (from all seven).** Muster keeps only the judgment layer and rides harness-native primitives; it enforces HARD only where a harness gives a real veto the model cannot route around, and everywhere else its "enforcement" is advisory prompt discipline made deterministic by muster's own out-of-loop code (manifest validation, worktree/base-SHA receipts, repository-state checks, the deterministic CLI/MCP brain). The advisory line sits at exactly one place per harness: the single hard pre-execution veto, if any. [src: dr-efficiency] [src: cw-port]

**Where the advisory line sits, per harness (one line each)** — the single hard veto, if any: [src: dr-efficiency]

- Claude Code CLI/Desktop — PreToolUse `deny` (+ `agent_id` crew signal, permission rules, sandbox) is HARD; wave-guard/scale-gate/action-class fence live here; everything else advisory. Strongest enforcement of the seven. [src: cc-hooks] [src: cc-augment]
- Codex CLI/Desktop — only MCP governance (`required`/allow-deny/approval), `sandbox_mode`, and install-time `config.toml` writes are HARD; hooks are diagnostics; determinism lives in muster's dispatch, receipts, and `doctor --codex`. [src: cx-augment] [src: cx-mcp]
- Cowork — NOTHING is hookable by an MCP integrator; muster's whole ride is the 21-tool MCP server + protocol injected via MCP `instructions`, with first-class degradation to inline execution. [src: cw-augment] [src: cw-port]
- Hermes — `pre_tool_call` block hooks + `approvals.deny` globs + managed-scope pins are HARD; default is permissive, so muster adds its fences as hooks. [src: hermes-approval] [src: hermes-hooks]
- GPT Work / Agents SDK — default approval-free; `needs_approval` + guardrails + durable `RunState` are HARD once declared but nothing gates by default; ChatGPT Work inherits Codex governance. [src: gw-hitl] [src: gw-verdict]

**What muster RIDES natively, per harness (one line each)** — the primitives muster reuses rather than rebuilds: [src: cc-augment]

- Claude Code CLI — `Agent` tool + worktree isolation, PreToolUse gates, skills-as-verbs, the task board, plan mode, plugin packaging, transcript mining. [src: cc-augment]
- Claude Desktop/Web — repo `.claude/` as the portable plane, `SessionStart` hooks (`CLAUDE_CODE_REMOTE`), automatic worktrees, routines/scheduled tasks, Artifacts for run output. [src: ccd-augment]
- Cowork — the 21-tool MCP server (Route A config-file / Route B MCPB), MCP `instructions` protocol injection, prompted parallel fan-out + per-call model override, the sprint-protocol degradation path. [src: cw-port]
- Codex CLI — `codex exec` in ported workflows, 27 agent TOML profiles (model/effort/sandbox pinned), the bundled MCP server, install-time config writes; hooks as diagnostics only. [src: cx-augment]
- Codex Desktop — the same plugin/marketplace + custom-agent TOML + shared `config.toml` reach all local clients from one generated artifact; `doctor` for split-state. [src: cxd-augment]
- GPT Work — no separate lane; the Codex lane covers ChatGPT Work; the Agents SDK would be a build (needs_approval + RunState + Sandbox agents + custom Session backends), not an augmentation. [src: gw-verdict]
- Hermes — a skills tap/external dir, a thin Python plugin shelling to the muster CLI, `pre_tool_call` gate hooks, `delegate_task` waves, kanban for coordination/backlog, cron for the runner, `/goal` completion contracts. [src: hermes-port]

**Closest-fit port = Hermes.** Three of muster's load-bearing surfaces exist natively and two are Claude-Code-compatible on purpose: skills port near-verbatim (agentskills.io `SKILL.md`, reads AGENTS.md/CLAUDE.md, GitHub taps) [src: hermes-skills]; hooks port near-verbatim (shell hooks take JSON on stdin and accept Claude Code's block shape; `UserPromptSubmit`→`pre_llm_call`) [src: hermes-hooks]; and kanban IS muster's coordination protocol already implemented as harness machinery — atomic claims, `task_runs` structured handoff metadata, `kanban_block(kind)` with auto-resume, heartbeats, and an append-only `task_events` ledger, giving the coordination skill a fourth binding beside GitHub issues, backlog.md, and Linear. [src: hermes-kanban] [src: hermes-port]

**Per-harness muster port surface** — ride, hard-enforce, advisory-only, and port cost per harness: [src: cw-port]

| Harness | Ride (native) | Enforce HARD | Advisory-only | Port cost |
|---|---|---|---|---|
| Claude Code CLI | Agent tool, hooks, skills, task board, plan mode, plugin [src: cc-augment] | PreToolUse deny, permission rules, sandbox [src: cc-hooks] | SessionStart context, task-board state [src: cc-augment] | native (reference impl) [src: cc-augment] |
| Claude Desktop/Web | repo `.claude/`, worktrees, routines, Artifacts [src: ccd-augment] | permission modes + managed settings, org tool policy [src: ccd-augment] | session-URL trailers, diff-pane review [src: ccd-augment] | low — repo-commit everything [src: ccd-config] |
| Cowork | 21-tool MCP server, MCP `instructions`, fan-out [src: cw-port] | none hookable; server enforces its own contracts [src: cw-augment] | crew dispatch, protocol, STATE (hand-written) [src: cw-augment] | medium — session-mode-dependent, contradictory local-MCP docs [src: cw-mcp] |
| Codex CLI | `codex exec`, 27 TOML profiles, MCP server [src: cx-augment] | MCP governance, `sandbox_mode`, install-time config [src: cx-mcp] | hook warnings, thread/step ceilings, receipts [src: cx-augment] | medium — advisory-by-design; determinism out-of-loop [src: dr-efficiency] |
| Codex Desktop | plugin/marketplace, custom agents, shared config [src: cxd-augment] | shared `config.toml` writes reach all clients [src: cxd-config] | in-app count parity (documented, not re-counted) [src: cxd-augment] | shared with Codex CLI lane [src: cxd-config] |
| GPT Work | Codex lane covers it; Agents SDK for a built lane [src: gw-verdict] | needs_approval + guardrails (opt-in) [src: gw-hitl] | Workspace-agents trigger (write-only today) [src: gw-verdict] | none new (Codex) / build (SDK) [src: gw-verdict] |
| Hermes | skills tap, plugin shim, delegate_task, kanban, cron, /goal [src: hermes-port] | `pre_tool_call` block + `approvals.deny` + managed scope [src: hermes-approval] | `/goal` judge (fail-open), delegate model routing [src: hermes-delegation] | low — closest fit; Python shim, kanban = coordination [src: hermes-port] |
[src: cc-augment] [src: ccd-augment] [src: cw-port] [src: cx-augment] [src: cxd-augment] [src: gw-verdict] [src: hermes-port]

## Part D — Contradictions ledger

Every disagreement surfaced across the seven docs, the three decision records, and muster's code — each resolved or flagged with what would settle it. [src: dr-efficiency]

1. **`EnterPlanMode` exists? (doc-internal, docs-inference vs binary).** claude-code-cli.md §6 infers "there is no `EnterPlanMode` tool" from its absence in the matcher docs/CHANGELOG, while §1 records the literal string in the 2.1.211 binary. Flagged, both kept. Resolves via a PreToolUse hook capturing `tool_name` on a real plan-mode entry. [src: cc-plan]

2. **Do Claude Code subagents get the `Agent` tool by default? (doc-internal).** The subagents section documents nesting to depth 5 (a subagent has `Agent` until depth 5), while the merged binary/context-window evidence says the `Agent` tool is withheld from subagents "by default… to bound recursion." Flagged. Resolves by inspecting the default tool grant of a spawned `general-purpose` subagent. [src: cc-subagents]

3. **Are config-file local MCP servers available in Cowork? (doc-vs-doc, unresolved in official docs).** Cowork's architecture overview lists "local plugin MCP servers" as a live desktop surface; the custom-connectors article states config-file local servers "aren't available in Cowork or claude.ai." Muster's port empirically worked on desktop-era Cowork. Resolves by re-running `scripts/cowork-probe.mjs` on a current build. [src: cw-mcp]

4. **"Cowork has no plugin/skill/slash/hook primitives" (doc-vs-muster-code).** Muster's shipping adapter comment asserts this; current Cowork docs describe a plugin system bundling skills/connectors/hooks/subagents in the Claude Code plugin format. The adapter predates the surface — stale. Resolves by a hands-on test of whether muster's `plugin/` loads under Cowork's loader (the port's highest-value open question). [src: cw-plugins]

5. **Cowork per-call model override (doc-absence vs muster-code).** No public Cowork source documents per-subagent model selection; muster's probe records it "confirmed working." Treat as CODE-VERIFIED-but-fragile. Resolves by re-probing after any Cowork update. [src: cw-subagents]

6. **Codex plugin-bundled hooks execute? (docs vs decision-record/0.144 ground truth).** Current Codex docs say enabled plugins' hooks load alongside other layers; muster's verified 0.144 behavior is that "Codex 0.144 does not execute plugin-bundled hooks," so muster installs into the supported `hooks.json` layer instead. Flagged as version-gated. Resolves by establishing a floor Codex version that provably runs bundled hooks. [src: cx-hooks]

7. **`codex-efficiency-enforcement`: fail-closed premise vs reality (backlog-item vs decision-record).** The contract assumed a controllable native dispatch runner sitting in front of Codex's collaboration schema; the retriage found every fail-closed clause "architecturally unreachable" because Codex hooks are advisory/fail-open by design. **Resolved: retired**, not rescoped; the claim was released and the dependency dropped as unresolvable on the lineage. [src: dr-efficiency]

8. **`codex-install-thread-limits`: claimed-done vs zero enforcement (backlog vs decision-record + code).** The item cited PR 34 as done, but `grep -rn "max_threads\|max_depth" src/*.js` found only generated *prose*, no `config.toml` write; the enforcing module (`src/codex-thread-limits.js`) died on the never-merged burn commit `f2da066`. **Resolved: invalidated and re-opened** as a fresh scoped item (`codex-thread-limits-enforcement`, floors `max_threads ≥ 12`/`max_depth ≥ 2`, fail-loud install). [src: dr-install] [src: dr-audit]

9. **Hermes scale: "215,942 stars, 40,332 forks" on a `v0.18.2` (0.x) release created 2025-07-22 — [UNVERIFIED-SUSPECT].** A ~1-year-old 0.x project at 216k stars is internally implausible (that would rival the most-starred repos on GitHub while still pre-1.0); the figure is a single GitHub-API reading. Never stated here as fact; Hermes's harness-target verdict does not depend on it. Resolves by an independent, dated `api.github.com` re-query. [src: hermes-scale]

10. **Claude Code docs host drift (doc-vs-doc, provenance).** claude-code-cli.md cites `docs.claude.com/en/docs/claude-code/*`; claude-code-desktop.md notes the docs moved to a dedicated `code.claude.com/docs/en/*` host. **Resolved:** `code.claude.com` is the current host per the desktop doc; the CLI doc's `docs.claude.com` anchors are the older mirror of the same content. [src: ccd-arch] [src: cc-config]

11. **Auto-mode classifier model version (merge decision, suppressed as unverifiable).** The binary-appendix evidence named specific classifier/eligibility model versions ("Sonnet 5", "Opus 4.6+/Fable 5") beyond confident verification; the merged CLI doc deliberately describes the classifier as "a server-selected model independent of `/model`" without asserting versions. Flagged here so the omission is intentional, not an oversight. Resolves via a dated official permission-modes page. [src: cc-perm]

## Buildability note

A minimal CLI+desktop harness is reconstructible from Part A: A1 gives the loop, A2 the dispatch/registry, A3 the layered veto, A4 the transcript event log, A5 subagents-as-nested-loops, A6–A8 the extension/hook/MCP surfaces, and A9 the config/auth/quota topology; Part B supplies the non-obvious decisions with a worked rationale. The **weakest-sourced components** are the Cowork integration plane (single-sourced to muster's own adapter plus mutually contradictory support articles — items 3–5) and desktop shell internals (UI framework, process tree, and UI↔engine IPC are explicit documentation GAPs for both Claude Desktop and Codex Desktop); a from-scratch build of those two would need a hands-on spike, not more reading. [src: cw-augment] [src: ccd-arch] [src: cxd-arch]

## Sources

- cc-loop: docs/research/claude-code-cli.md §1–2 — architecture; one homogeneous tool-use loop; turn structure; PostToolBatch.
- cc-context: docs/research/claude-code-cli.md §2.2–2.3 — startup context assembly order; compaction (preserve tail, re-inject root CLAUDE.md).
- cc-perm: docs/research/claude-code-cli.md §3.1 — tiered permissions; rules deny→ask→allow; auto classifier; protected paths.
- cc-hooks: docs/research/claude-code-cli.md §3.2–3.3 — 31-event lifecycle; payload contract; PreToolUse decision seam; fail-open guard design.
- cc-sandbox: docs/research/claude-code-cli.md §3.4 — OS-level Bash sandbox (seatbelt/bubblewrap); independent of permission mode.
- cc-sessions: docs/research/claude-code-cli.md §4 — JSONL transcript event log; cwd-slug/session-id key; resume/fork/rewind; bridge-session.
- cc-subagents: docs/research/claude-code-cli.md §5 — Agent tool; own context window; worktree isolation; nesting ≤5.
- cc-plan: docs/research/claude-code-cli.md §1, §6 — plan mode; ExitPlanMode; EnterPlanMode conflict flag; task board.
- cc-skills: docs/research/claude-code-cli.md §7 — SKILL.md; progressive disclosure; plugin packaging.
- cc-mcp: docs/research/claude-code-cli.md §8 — MCP client scopes; mcp__server__tool; ToolSearch deferral.
- cc-config: docs/research/claude-code-cli.md §9 — config scopes/precedence; ~/.claude state root; docs.claude.com anchors.
- cc-augment: docs/research/claude-code-cli.md §10 — augmentation surface table; enforcement vs advisory rows.
- ccd-arch: docs/research/claude-code-desktop.md §1–2 — one engine many shells; Desktop as Agent-SDK host; web-delivered UI; docs moved to code.claude.com.
- ccd-web: docs/research/claude-code-desktop.md §3 — cloud VM per session; GitHub/security proxies; repo-clone config; Claude-Session trailer.
- ccd-config: docs/research/claude-code-desktop.md §9, §11 — config topology; repo `.claude/` reaches every surface; automatic worktrees.
- ccd-ide: docs/research/claude-code-desktop.md §5 — `ide` MCP bridge; reserved server names; shell capabilities surfaced as MCP tools.
- ccd-augment: docs/research/claude-code-desktop.md §11 — muster augmentation surfaces on desktop/web.
- cw-loop: docs/research/claude-cowork.md §1–2 — same agentic architecture, no terminal; 5-step loop; native primitives/absences.
- cw-mcp: docs/research/claude-cowork.md §3, §5 — MCP integration plane; local-server doc contradiction; remote connectors undiscoverable.
- cw-plugins: docs/research/claude-cowork.md §3d — plugin system (skills/connectors/hooks/subagents); Claude Code plugin format.
- cw-subagents: docs/research/claude-cowork.md §4 — parallel fan-out; per-call model override (probe-only); no dispatch API.
- cw-port: docs/research/claude-cowork.md §6 — muster's ride; 21-tool MCP server; MCP instructions protocol injection; canonical shared source.
- cw-augment: docs/research/claude-cowork.md §7–8 — augmentation table; sourcing gaps; existential risks.
- cx-loop: docs/research/codex-cli.md §1 — Rust harness; Thread/Turn/Items via codex exec; shared config across surfaces.
- cx-models: docs/research/codex-cli.md §2 — GPT-5.6 lanes; reasoning-effort ladder; luna-xhigh budget evidence.
- cx-config: docs/research/codex-cli.md §3 — config.toml layers; [agents] thread limits; requirements.toml constraints.
- cx-hooks: docs/research/codex-cli.md §4 — hook contract; advisory-by-design line; PreToolUse partial interception.
- cx-skills: docs/research/codex-cli.md §5 — plugin anatomy; SKILL.md; marketplaces incl. legacy .claude-plugin.
- cx-subagents: docs/research/codex-cli.md §6 — spawn/wait/list; max_threads/max_depth; no cwd on dispatch; watch invariant.
- cx-mcp: docs/research/codex-cli.md §7 — MCP client/server; required/allow-deny/approval governance = most governable surface.
- cx-augment: docs/research/codex-cli.md §9 — augmentation table; canonical cannot-enforce list.
- cxd-arch: docs/research/codex-desktop.md §1–2 — five Codex surfaces; app-server JSON-RPC core; desktop internals GAP.
- cxd-config: docs/research/codex-desktop.md §4–5 — shared CODEX_HOME; WSL/Windows split-home; [agents] limits in shared config.toml.
- cxd-quota: docs/research/codex-desktop.md §9 — shared 5h window; local+cloud one pool; Luna budget lane; the burn mechanism.
- cxd-augment: docs/research/codex-desktop.md §10–11 — augmentation table; desktop-vs-CLI divergence.
- gw-sdk: docs/research/gpt-work.md §2, §4–5 — Agents SDK Runner loop; tool classes; per-call model override; MCP routes.
- gw-hitl: docs/research/gpt-work.md §2.4 — default approval-free; needs_approval + durable RunState pause/resume.
- gw-sandbox: docs/research/gpt-work.md §6 — Sandbox agents beta; Manifest + capabilities + resumable; Session backends.
- gw-verdict: docs/research/gpt-work.md §1.1, §9 — ChatGPT Work = Codex substrate; per-candidate harness-target verdict.
- hermes-loop: docs/research/hermes.md §2 — AIAgent loop; role alternation; compression; budgets.
- hermes-scale: docs/research/hermes.md §1 — identity/scale figures incl. the [UNVERIFIED-SUSPECT] 215,942-star / v0.18.2 claim.
- hermes-approval: docs/research/hermes.md §3 — dangerous-pattern interception; approvals.deny; permissive default.
- hermes-hooks: docs/research/hermes.md §7 — three hook systems; Claude Code block-JSON compatibility; UserPromptSubmit→pre_llm_call.
- hermes-kanban: docs/research/hermes.md §4, §6 — kanban durable queue (claims/receipts/blocked/heartbeat/task_events); SQLite state.db.
- hermes-skills: docs/research/hermes.md §7 — agentskills.io SKILL.md; every skill a slash command; GitHub taps.
- hermes-delegation: docs/research/hermes.md §5 — delegate_task; fresh context; config-level model override; depth/concurrency limits.
- hermes-mcp: docs/research/hermes.md §7 — MCP client/server; mcp_<server>_<tool>; OAuth.
- hermes-config: docs/research/hermes.md §8 — ~/.hermes per-profile; managed scope; provider resolver; auxiliary model slots.
- hermes-worktree: docs/research/hermes.md §6 — hermes -w worktrees; checkpoint managers; kanban worktree workspaces.
- hermes-port: docs/research/hermes.md §10–11 — augmentation table; first-class verdict; port constraints.
- dr-efficiency: docs/decisions/retriage-codex-efficiency-enforcement.md — retire-not-rescope; fail-closed unreachable on Codex; advisory-only consequence.
- dr-install: docs/decisions/retriage-install-items.md — counts still-true; thread-limits invalidated and re-opened with fail-loud floor.
- dr-audit: docs/decisions/retriage-audit-hardening.md — audit-stack retriage; f2da066 thread-limits module flagged-gap DROP.
