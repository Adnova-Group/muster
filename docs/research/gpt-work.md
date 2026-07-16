# Research: "GPT Work" — OpenAI's agentic work surfaces as a muster harness target

Research date: 2026-07-16. Target named by the user as "GPT work, etc" — an OpenAI
agent-platform layer distinct from Codex CLI/Desktop. This banner was genuinely ambiguous
when the research started; it is much less ambiguous now, because OpenAI shipped a product
literally named **ChatGPT Work** on July 9, 2026 — seven days before this research date
[src: chatgpt-work]. This document first disambiguates everything living under the banner,
then documents the naked base loop of the one muster-relevant execution model (the OpenAI
Agents SDK), and ends with an augmentation-surface table and a per-candidate verdict.

Evidence tags: [DOCUMENTED] = stated in a cited primary source. [INFERRED] = reasoned from
documented facts, not directly stated. [AMBIGUOUS-BANNER] = the naming/positioning itself is
unsettled in the sources. All sources are official OpenAI properties (openai.com,
help.openai.com, developers.openai.com, openai.github.io) [src: sdk-index].

## 1. Disambiguation: what actually exists under "GPT Work / ChatGPT agentic work"

Eight distinct things plausibly answer to the banner. They are NOT one product.

| # | Candidate | What it is | Status (2026-07) | Muster harness target? |
|---|---|---|---|---|
| 1 | **ChatGPT Work** | Agent mode in ChatGPT (web/mobile/desktop) with "Codex technology built-in"; produces sheets/slides/docs/Sites; runs hours-long tasks [src: chatgpt-work] | GA rollout since 2026-07-09 [src: chatgpt-work] | NO as a separate target — it is the Codex substrate in a deliverables skin (§1.1) [INFERRED] |
| 2 | **Workspace agents in ChatGPT** | Shared, Codex-powered cloud agents for teams; evolution of GPTs; Slack + schedule + API trigger [src: workspace-agents] | Research preview since 2026-04-22 [src: workspace-agents] | NOT YET — write-only trigger API, no run retrieval (§1.2) [src: workspace-trigger] |
| 3 | **OpenAI Agents SDK** (Python/JS) | Code-first agent runtime: agent loop, handoffs, guardrails, sessions, MCP, sandbox agents [src: sdk-index] | Actively developed; the recommended code path [src: agentkit] | YES — the muster-relevant execution model; but it is a framework to build ON, not an installed harness to augment (§9) [INFERRED] |
| 4 | **Responses API** | The API primitive under everything; own-the-loop tool calling, hosted tools, conversations [src: platform-agents] | Core, current [src: platform-agents] | Substrate, not a harness [INFERRED] |
| 5 | **ChatGPT agent / "agent mode"** | 2025 end-user virtual-computer agent (visual browser, text browser, terminal, connectors) [src: chatgpt-agent] | Launched 2025-07-17; functionally superseded by ChatGPT Work's launch [AMBIGUOUS-BANNER] | NO — end-user feature, no programmatic surface [src: chatgpt-agent] |
| 6 | **AgentKit** (Agent Builder, ChatKit, Connector Registry, Evals) | 2025 DevDay visual-builder suite [src: agentkit] | Agent Builder + Evals winding down; unavailable after 2026-11-30 [src: agentkit] | NO — dying product [src: agentkit] |
| 7 | **Assistants API** | The old threads/runs/steps agent API | Filed under "Legacy APIs" with a migration guide to Responses [src: platform-agents] | NO — legacy [src: platform-agents] |
| 8 | **Apps / plugins / connectors in ChatGPT** | MCP-based integration fabric (apps) packaged into a Plugins Directory as of 2026-07-09 [src: apps-help] | Current | Integration fabric, not a harness; but a distribution channel (§7) [INFERRED] |

The one-line resolution: **"GPT Work" resolves to ChatGPT Work, which is Codex wearing a
non-developer skin. The independently interesting execution model under the banner is the
OpenAI Agents SDK. Everything else is either substrate, legacy, or an end-user feature.**
[INFERRED from the sources cited above; the merge evidence is §1.1] [src: chatgpt-work]

### 1.1 ChatGPT Work is Codex — the load-bearing disambiguation fact

- ChatGPT Work is "an agent that can take action across your apps and files, stay with a
  project for hours if needed, and turn a goal into finished work," launched 2026-07-09
  for Pro/Enterprise/Edu first, Plus/Business days later [DOCUMENTED] [src: chatgpt-work].
- "With Codex technology built-in, ChatGPT can now move beyond answering questions to
  getting real work done across web, mobile, and desktop" — the Work agent IS the Codex
  agent substrate [DOCUMENTED] [src: chatgpt-work].
- "Starting today, the Codex app is merging with the new ChatGPT desktop app"; the old
  ChatGPT desktop app is renamed "ChatGPT Classic"; Chat, Work, and Codex are three modes
  of one desktop app, on every plan including Free [DOCUMENTED] [src: chatgpt-work].
- The help center frames the split by task type: "Choose Work for research and
  deliverables, or Codex for software development" — same machinery, different lane
  [DOCUMENTED] [src: work-codex-help].
- "Work follows the same usage structure as Codex," pointing at the Codex pricing page for
  included usage and credits [DOCUMENTED] [src: work-codex-help].
- On desktop, ChatGPT Work "builds on Codex's enterprise governance model and admin
  controls" — the governance docs it links are the developers.openai.com/codex pages
  [DOCUMENTED] [src: chatgpt-work].
- The Codex developer docs now carry Work pages directly: "Get started with Work" and a
  "ChatGPT Work Admin FAQ" live inside developers.openai.com/codex [DOCUMENTED]
  [src: platform-agents].
- Consequence for muster: whatever muster builds for the Codex lane (AGENTS.md, skills,
  plugins, hooks, MCP, config.toml, permission profiles — all present in the Codex docs
  tree [src: platform-agents]) is the augmentation surface for ChatGPT Work too. There is
  no separate "ChatGPT Work harness" to integrate with [INFERRED].

### 1.2 Workspace agents — the team-shared cloud lane

- Workspace agents (2026-04-22, research preview for Business/Enterprise/Edu/Teachers) are
  "an evolution of GPTs. Powered by Codex, they can take on many of the tasks people
  already do at work"; they "run in the cloud, so they can keep working even when you're
  not" [DOCUMENTED] [src: workspace-agents].
- Each agent gets "a workspace for files, code, tools, and memory" via Codex in the cloud;
  agents can write/run code, use connected apps, remember what they learn, and continue
  across steps [DOCUMENTED] [src: workspace-agents].
- Builders set per-agent controls: which tools/data it can use, what actions it can take,
  and which sensitive steps (editing a spreadsheet, sending email, calendar writes) require
  approval before proceeding [DOCUMENTED] [src: workspace-agents].
- There is a real programmatic trigger: `POST https://api.chatgpt.com/v1/workspace_agents/{id}/trigger`
  with a Workspace Agent access token, an `input` string, an optional `conversation_key`
  for continuing a conversation across trigger events, and an optional `Idempotency-Key`
  header [DOCUMENTED] [src: workspace-trigger].
- The trigger API is fire-and-forget: it returns `202 Accepted` with no body, "does not
  return a public run ID, and the agent response cannot currently be retrieved through the
  API. Support for retrieving agent responses is coming soon" [DOCUMENTED]
  [src: workspace-trigger].
- Pricing went credit-based on 2026-05-06 after a free preview window [DOCUMENTED]
  [src: workspace-agents].
- AgentKit's wind-down note explicitly routes former Agent Builder users here: "For use
  cases better suited to natural language prompting, we recommend Workspace Agents in
  ChatGPT" [DOCUMENTED] [src: agentkit].

### 1.3 The deprecation floor under the banner

- Agent Builder and Evals: "From November 30, 2026 onward, they will no longer be available
  on the OpenAI platform," with the Agents SDK recommended for code workflows
  [DOCUMENTED] [src: agentkit].
- Assistants API: listed under "Legacy APIs" in the platform docs nav, reduced to a
  migration guide, deep dive, and tools reference [DOCUMENTED] [src: platform-agents].
  Its previously announced sunset timeline was not re-verified in this pass — treat the
  exact end-of-life date as a sourcing gap [INFERRED].
- Operator: sunset shortly after ChatGPT agent's 2025-07 launch, which absorbed it
  [DOCUMENTED] [src: chatgpt-agent].
- Atlas (standalone browser): "We'll begin sunsetting the standalone Atlas browser" in
  favor of the ChatGPT desktop app's built-in browser and Chrome extension [DOCUMENTED]
  [src: chatgpt-work].
- Pattern worth noting for muster's roadmap risk models: OpenAI has churned through four
  agent-surface generations in 18 months (Operator → ChatGPT agent → Agent Builder →
  ChatGPT Work / Workspace agents). Only the Agents SDK and Responses API have been stable
  across all of them [INFERRED from the launch/sunset dates cited above] [src: agentkit].

## 2. The naked base loop (OpenAI Agents SDK)

The Agents SDK is the muster-relevant execution model, so its loop is what gets documented
at mechanism level. Everything in this section is [DOCUMENTED] unless tagged otherwise.

### 2.1 Primitives

- Agents: "LLMs equipped with instructions and tools" [src: sdk-index].
- Agents as tools / handoffs: delegation across agents [src: sdk-index].
- Guardrails: input/output validation that runs "in parallel with agent execution" and
  fails fast [src: sdk-index].
- Sessions: "a persistent memory layer for maintaining working context within an agent
  loop" [src: sdk-index].
- Sandbox agents (beta): "run specialists inside real isolated workspaces with
  manifest-defined files, sandbox client choice, and resumable sandbox sessions"
  [src: sdk-index].
- Built-in tracing, human-in-the-loop mechanisms, MCP server tool calling, function tools
  with automatic schema generation and Pydantic validation [src: sdk-index].
- Lineage: "a production-ready upgrade of our previous experimentation for agents, Swarm"
  [src: sdk-index].

### 2.2 The loop itself

Entry points are `Runner.run()` (async), `Runner.run_sync()`, and `Runner.run_streamed()`;
input is a string, a list of Responses-API-format input items, or a `RunState` when
resuming an interrupted run [src: sdk-running].

The runner's documented loop [src: sdk-running]:

1. Call the LLM for the current agent with the current input [src: sdk-running].
2. If the LLM returns a `final_output`, end the loop and return the result
   [src: sdk-running].
3. If the LLM does a handoff, update the current agent and input, re-run the loop
   [src: sdk-running].
4. If the LLM produces tool calls, run them, append the results, re-run the loop
   [src: sdk-running].
5. If `max_turns` is exceeded, raise `MaxTurnsExceeded` (`max_turns=None` disables the
   limit) [src: sdk-running].

- Termination rule: output counts as final when "it produces text output with the desired
  type, and there are no tool calls" [src: sdk-running].
- One `Runner.run` call = one logical conversation turn, even if it spans multiple agents
  and LLM calls internally [src: sdk-running].
- Transport: Responses API by default; an optional websocket transport for the Responses
  API exists (`set_default_openai_responses_transport("websocket")`,
  `responses_websocket_session()` for multi-run reuse) [src: sdk-running].
- The SDK-vs-API boundary is documented explicitly: "Use the Responses API when you want to
  own the loop. Use the Agents SDK when you want the SDK to run it" [src: platform-agents].

### 2.3 Tool calling and dispatch

- Tool classes visible in the loop: function tools, hosted tools (platform-executed),
  agents-as-tools, MCP tools (hosted or local), plus specialized `ShellTool`,
  `ApplyPatchTool`, and computer/custom tool runtimes surfaced in the error-formatter's
  `tool_type` enum (`"function"`, `"computer"`, `"shell"`, `"apply_patch"`, `"custom"`)
  [src: sdk-running].
- Local function-tool dispatch is concurrent by default: "when a model emits multiple
  function tool calls in a turn, the SDK starts all emitted local function tool calls";
  `ToolExecutionConfig(max_function_tool_concurrency=N)` caps it. This is distinct from
  `ModelSettings.parallel_tool_calls`, which governs whether the model may emit multiple
  calls per response [src: sdk-running].
- Unresolved tool calls: default raises `ModelBehaviorError`; opt in to
  `tool_not_found_behavior="return_error_to_model"` to append a `function_call_output`
  error and let the model recover [src: sdk-running].
- `tool_error_formatter` customizes model-visible error text per error kind
  (`"approval_rejected"`, `"tool_not_found"`, ...) [src: sdk-running].
- `call_model_input_filter` is a run-level hook to "edit the fully prepared model input
  (instructions and input items) immediately before the model call" — the closest thing
  the SDK has to a prompt-interception hook [src: sdk-running].
- The platform tools catalog behind hosted tools includes web search, file search,
  MCP/connectors, skills, tool search, programmatic tool calling, shell, computer use,
  apply patch, local shell, and code interpreter [src: platform-agents].

### 2.4 Permission / approval model — the finding

The SDK's default posture is **approval-free**: a tool call the model emits simply runs.
Every gate is opt-in, per tool or per server. That default-open stance is itself the
finding for muster — there is no global permission mode, no equivalent of Codex's
permission profiles, and nothing enforces a gate unless application code declares one
[INFERRED from the opt-in mechanisms documented below] [src: sdk-hitl].

The opt-in machinery, which is genuinely strong once engaged [src: sdk-hitl]:

- `needs_approval` (bool or async predicate over run context, parsed params, call ID) is
  available on `function_tool`, `Agent.as_tool`, `ShellTool`, and `ApplyPatchTool`
  [src: sdk-hitl].
- When approval is needed, the run pauses and `RunResult.interruptions` carries
  `ToolApprovalItem`s (agent name, tool name, arguments); interruptions from handoff
  targets and nested `Agent.as_tool()` executions surface on the OUTER run [src: sdk-hitl].
- Resume flow: `result.to_state()` → `state.approve(...)` / `state.reject(...)` →
  `Runner.run(agent, state)`. Decisions can be made sticky for the rest of the run with
  `always_approve=True` / `always_reject=True` [src: sdk-hitl].
- `RunState` is durable: `to_json()`/`to_string()` for queue/DB storage,
  `RunState.from_json(...)`/`from_string(...)` to resume in another process; serialized
  state includes approvals, usage, tool inputs, nested resumptions, trace metadata
  [src: sdk-hitl].
- Local MCP servers gate via `require_approval` ("always"/"never", per-tool map, or grouped
  object); hosted MCP gates via `tool_config={"require_approval": ...}` plus an optional
  `on_approval_request` programmatic callback [src: sdk-mcp].
- Hosted shell environments do NOT support `needs_approval`/`on_approval` — hosted-tool
  execution happens on OpenAI's side without the local pause surface [src: sdk-hitl].
- `pre_approval_tool_input_guardrails=True` runs function-tool input guardrails before the
  approval interruption is emitted, then re-runs them after approval [src: sdk-running].

On the ChatGPT product side the permission model is different and admin-shaped:

- ChatGPT app actions default to "Important actions" (read automatically, ask before
  consequential/sensitive/hard-to-undo actions); the tiers are Always ask / Any changes /
  Important actions / Never ask, with approval cards offering Deny / Allow once / Always
  allow [DOCUMENTED] [src: apps-help].
- ChatGPT agent (2025) shipped explicit user confirmation before consequential actions,
  "Watch Mode" active supervision for critical tasks like sending email, and trained
  refusal of high-risk tasks (e.g. bank transfers) [DOCUMENTED] [src: chatgpt-agent].
- ChatGPT Work adds "Auto-review," which "uses our most advanced models to review important
  actions involving connected tools and APIs before they happen," on top of Codex's
  enterprise governance model [DOCUMENTED] [src: chatgpt-work].
- Workspace agents let builders require approval for sensitive steps, and admins control
  tools/actions per user group, with Compliance API visibility into every agent's
  configuration, updates, and runs, plus agent suspension [DOCUMENTED]
  [src: workspace-agents].

## 3. Native planning / task primitives

- Confirmed: the Agents SDK has NO plan-mode analog — no plan artifact, no plan-approval
  step, no task list primitive appears anywhere in its documented primitive set (agents,
  handoffs, guardrails, sessions, tools, tracing, sandbox) [DOCUMENTED-absence across
  src: sdk-index and src: sdk-multi] [src: sdk-index].
- What substitutes, per the SDK's own orchestration guide: LLM-driven planning ("given an
  open-ended task, the LLM can autonomously plan how it will tackle the task") or
  code-driven orchestration — structured-output classification then routing, chaining
  agents, while-loop evaluator patterns, and `asyncio.gather` parallelism
  [src: sdk-multi].
- The guardrails/HITL pause-resume machinery can be bent into a plan gate (pause on a
  "submit_plan" function tool with `needs_approval=True`), but that is an application
  pattern, not a primitive [INFERRED] [src: sdk-hitl].
- On the product side, ChatGPT Work claims model-side decomposition — "stay with complex
  projects for hours by breaking them into smaller steps and completing them
  independently" — but exposes no plan artifact or plan-approval API; and Scheduled Tasks
  are recurrence/trigger automation, not planning [DOCUMENTED for the claims,
  mechanism-level detail unavailable] [src: chatgpt-work].

## 4. Subagents / multi-agent orchestration + model override

- Two first-class patterns: **agents as tools** (a manager agent keeps the conversation and
  calls specialists via `Agent.as_tool()`; use when one agent should own the final answer)
  and **handoffs** (a triage agent routes; the specialist becomes the active agent for the
  rest of the turn). They compose: a handoff target can still call agents as tools
  [src: sdk-multi].
- Handoff history control: `nest_handoff_history` (opt-in beta) collapses the prior
  transcript into a single assistant message before invoking the next agent; default
  passes the raw transcript; `handoff_input_filter` / `handoff_history_mapper` allow full
  custom rewriting of what a receiving agent sees [src: sdk-running].
- Model override per call is real and layered: each `Agent` has its own `model`;
  `RunConfig.model` sets "a global LLM model to use, irrespective of what model each Agent
  has"; `RunConfig.model_provider` swaps in non-OpenAI providers; `model_settings`
  overrides sampling globally [src: sdk-running].
- Nested agent-as-tool calls inherit the run's `run_config` (documented for the websocket
  session case), so a run-level model override propagates into subagents
  [src: sdk-running].
- Subagent approval gating: `Agent.as_tool(..., needs_approval=...)` gates the delegation
  itself, and tools inside the nested agent raise their own approvals to the outer run
  [src: sdk-hitl].
- The SDK exists in TypeScript (`openai-agents-js`) and Python (`openai-agents-python`)
  with the platform docs treating them as equivalent tracks; this research verified only
  the Python docs in depth [DOCUMENTED for existence, parity INFERRED]
  [src: platform-agents].

## 5. MCP integration

- The SDK supports four MCP integration routes: `HostedMCPTool` (the Responses API calls a
  publicly reachable server on the model's behalf — no round-trip through your process),
  `MCPServerStreamableHttp`, `MCPServerSse` (deprecated transport, legacy only), and
  `MCPServerStdio` (SDK spawns and pipes a local subprocess) [src: sdk-mcp].
- Hosted MCP supports OpenAI **connectors** directly: pass `connector_id`
  (e.g. `connector_googlecalendar`) plus an authorization token instead of a `server_url`
  [src: sdk-mcp].
- Local MCP servers get: static/dynamic tool filtering (`create_static_tool_filter`, or an
  async callable over `ToolFilterContext` with agent + run context), `cache_tools_list`
  with `invalidate_tools_cache()`, retry knobs, `tool_meta_resolver` for per-call `_meta`
  payloads, and server-prefixed tool naming to avoid collisions [src: sdk-mcp].
- `MCPServerManager` handles multi-server lifecycles (drop-failed vs strict, parallel
  connect, reconnect) [src: sdk-mcp].
- MCP prompts are supported (`list_prompts()` / `get_prompt(name, args)`) as dynamic
  instruction sources [src: sdk-mcp].
- On the ChatGPT side, apps are "built using the Model Context Protocol (MCP)," and as of
  2026-07-09 the app directory migrated into a **Plugins Directory** where "a plugin can
  include skills, apps, and app templates"; workspace admins manage plugin installation
  and per-app action controls, including regex/range parameter constraints on individual
  action arguments [src: apps-help].
- The Apps SDK is the recommended packaging for custom MCP apps in ChatGPT; app templates
  let admins wire org-specific OAuth/webhook/managed-MCP-server configuration
  [src: apps-help].

## 6. Session / thread persistence and the isolation model

- The SDK documents four conversation-state strategies: manual `result.to_input_list()`
  (app-owned), `session` (SDK-managed client-side storage), `conversation_id` (OpenAI
  Conversations API, server-side, shareable across workers), and `previous_response_id`
  (lightweight server-managed chaining). Sessions cannot be combined with the
  server-managed options in the same run [src: sdk-running].
- Session backends shipped in the SDK: `SQLiteSession`, `SQLAlchemySession`,
  `RedisSession`, `EncryptedSession`, `AdvancedSQLiteSession`,
  `OpenAIConversationsSession`, and `OpenAIResponsesCompactionSession`, behind a common
  Session protocol that custom stores can implement [src: sdk-sessions].
- Workspace/filesystem isolation is the **Sandbox agents** beta: `SandboxAgent` +
  `Manifest` (declares files/repos/dirs/mounts staged into a fresh sandbox, e.g.
  `LocalDir(src=...)` under a `repo/` entry) + `capabilities` (filesystem editing, shell,
  skills, memory, compaction) + `SandboxRunConfig.client` choosing the backend
  (`UnixLocalSandboxClient` for local dev, Docker, hosted providers) [src: sdk-sandbox].
- Sandbox runs are resumable: `SandboxRunConfig.session`, `session_state`, or `snapshot`
  reconnect later runs to prior work; `run_as` sets the sandbox user identity for
  model-facing tools; skills can be lazy-loaded into the sandbox from a host directory
  [src: sdk-sandbox].
- The SDK's own positioning: reach for sandbox agents "when workspace isolation, sandbox
  client choice, or sandbox-session resume behavior are part of the design"; hosted shell
  suffices when shell is only an occasional tool [src: sdk-sandbox].
- ChatGPT Work's isolation is surface-split at launch: web/mobile Work runs in the cloud;
  desktop Work can use local files/apps with permission; "cloud Work conversations do not
  appear in desktop Work; desktop Work threads and local files remain on that computer";
  Codex desktop tasks are reachable from mobile only via a Remote tab [src: work-codex-help].
- Workspace agents persist per-agent memory and improve through conversational correction;
  their runs live in the org workspace with Compliance API visibility rather than in any
  user-local store [src: workspace-agents].

## 7. Config / auth topology and quota metering

- Agents SDK: authenticates with a plain `OPENAI_API_KEY`; runs bill as standard API model
  usage ("all of these tools are included with standard API model pricing" was AgentKit's
  framing for the platform tooling) [src: sdk-index] [src: agentkit].
- Tracing has its own key surface: `RunConfig.tracing` accepts a per-run tracing API key,
  and serialized `RunState` can optionally embed it (`include_tracing_api_key=True`)
  [src: sdk-running].
- ChatGPT Work: ChatGPT-account plans, not API keys. "Usage varies with the amount of work
  required"; it "follows the same usage structure as Codex" (plan-included usage plus
  flexible credits) [src: chatgpt-work] [src: work-codex-help].
- Enterprise metering for Work: admins set spend controls in the Admin Console —
  workspace-level defaults, group limits, individual overrides, and a request/rationale
  flow for extra credits [src: chatgpt-work].
- Workspace agents: credit-based pricing since 2026-05-06; programmatic access uses
  dedicated **Workspace Agent access tokens** (Bearer), not org API keys
  [src: workspace-agents] [src: workspace-trigger].
- ChatGPT agent (2025) quota shape for comparison: 400 messages/month on Pro, 40 on other
  paid tiers, extensible via credits [src: chatgpt-agent].
- Historical (dying) admin plane: AgentKit's Connector Registry consolidated data-source
  governance across ChatGPT and the API behind the Global Admin Console prerequisite
  [src: agentkit].

## 8. Augmentation-surface table

Where could muster attach, per surface? (SDK rows are mechanisms muster could code against
today; product rows are constrained by what OpenAI exposes.)

| Surface | Mechanism | Muster fit | Evidence |
|---|---|---|---|
| Agents SDK: run loop | `RunConfig` hooks — `call_model_input_filter`, `handoff_input_filter`, `tool_error_formatter`, `max_turns` | Inject muster context/rules per model call; bound runaway loops | [src: sdk-running] |
| Agents SDK: gates | `needs_approval` predicates + `RunState` pause/persist/resume | Muster review-gates as durable approval checkpoints, cross-process | [src: sdk-hitl] |
| Agents SDK: guardrails | Input/output guardrails run parallel, fail fast | Enforcement-follows-the-run checks in code, not prompts | [src: sdk-index] |
| Agents SDK: workspace | Sandbox `Manifest` + capabilities + skills lazy-loading + snapshots | Worktree-per-task analog; muster skills injected into sandboxes | [src: sdk-sandbox] |
| Agents SDK: sessions | Custom Session protocol backends | Glass-box STATE persistence in muster-owned storage | [src: sdk-sessions] |
| Agents SDK: MCP | stdio/HTTP servers, tool filtering, `HostedMCPTool` | muster CLI exposed as an MCP server to SDK agents | [src: sdk-mcp] |
| Agents SDK: models | Per-agent `model`, `RunConfig.model`, `model_provider` | Tiered model routing per role, muster-style | [src: sdk-running] |
| ChatGPT Work (desktop) | Inherits Codex surface: AGENTS.md, skills/plugins, hooks, MCP, config, permission profiles, subagents | Covered by muster's Codex lane; no separate work needed | [src: platform-agents] |
| Workspace agents | Trigger API (202, fire-and-forget, `conversation_key`, idempotency) | Dispatch-only today; unusable for muster's verify-and-gate loop until response retrieval ships | [src: workspace-trigger] |
| ChatGPT apps/plugins | Custom MCP app via Apps SDK; admin action controls + parameter constraints | Distribution channel for muster-as-a-connector, not a harness hook | [src: apps-help] |

## 9. Verdict: is this even a muster harness target?

Per-candidate, explicitly:

- **ChatGPT Work — NO (as its own target).** It is the Codex agent substrate with a
  deliverables skin, merged into one desktop app, governed by Codex's enterprise controls,
  metered like Codex [src: chatgpt-work]. Muster's Codex teardown/augmentation lane is the
  correct and sufficient vehicle; a separate "gpt-work lane" would duplicate it. Action:
  fold a "Work-mode divergence watch" note into the Codex lane instead [INFERRED]
  [src: work-codex-help].
- **OpenAI Agents SDK — YES, with a category caveat.** It is the real, documented,
  loop-level execution model under the banner, and sandbox agents make it a genuine
  repo/workspace execution surface [src: sdk-sandbox]. But it is a framework, not an
  installed harness: there is no user-facing CLI/product for muster to augment. Targeting
  it means muster *ships a runner lane built on it* (owning dispatch, gates, receipts via
  the surfaces in §8), which is a build decision, not an augmentation decision [INFERRED]
  [src: sdk-index].
- **Workspace agents — NOT YET; revisit.** Codex-powered cloud agents with real per-agent
  approvals and an API trigger [src: workspace-agents], but the API is write-only (202,
  no run ID, no response retrieval — "coming soon") [src: workspace-trigger]. Muster
  cannot close a verify loop against it today. Re-evaluate when run retrieval ships
  [INFERRED].
- **Responses API — substrate, not a target.** It is what the SDK and hosted tools stand
  on; muster would only touch it by owning the whole loop, which the SDK already does
  better [src: platform-agents] [INFERRED].
- **ChatGPT agent / agent mode (2025) — NO.** End-user feature, no programmatic surface,
  and its positioning is absorbed by ChatGPT Work [src: chatgpt-agent]
  [AMBIGUOUS-BANNER on whether "agent mode" remains a distinct composer entry post-Work;
  not re-verified].
- **AgentKit / Agent Builder — NO.** EOL 2026-11-30 [src: agentkit].
- **Assistants API — NO.** Legacy, migration-guide-only [src: platform-agents].
- **Apps/plugins/connectors — not a harness.** Integration fabric; relevant to muster only
  as a possible distribution channel (muster as a custom MCP app), which is a product
  question, not a harness-internals one [src: apps-help] [INFERRED].

## 10. Sourcing gaps (honest accounting)

- The Firecrawl search endpoint returned empty result sets for every query attempted, so
  disambiguation was built from direct scrapes of known official URLs plus cross-links
  found inside them; a product under the banner that none of these pages links to could
  have been missed [INFERRED — methodological note] [src: sdk-index].
- The Agents SDK JS docs were not scraped; Python/TS parity is asserted by the platform
  docs listing both as SDK tracks but was not verified feature-by-feature
  [src: platform-agents].
- The Assistants API's exact sunset date was not re-verified; only its "Legacy APIs"
  status is documented here [src: platform-agents].
- ChatGPT Work's internal loop (how it decomposes tasks, what its step executor looks
  like) is closed; every mechanism-level claim about it in this doc is limited to what the
  launch blog and help center state [src: chatgpt-work].
- The Workspace agents help article (help.openai.com/articles/20001143, per-agent tool and
  approval configuration detail) and the Codex-side "What's new" page describing Work
  capabilities in the desktop app were referenced by scraped pages but not scraped
  themselves [src: workspace-agents] [src: chatgpt-work].
- "GPT-Live" (launched 2026-07-08) is name-adjacent under the banner but was not
  investigated; its launch listing appeared in scraped page footers with no indication of
  being a work/agent surface [src: chatgpt-work] [AMBIGUOUS-BANNER].
- Sandbox agents are explicitly beta: "expect details of the API, defaults, and supported
  capabilities to change before general availability" — any muster build on them inherits
  that churn risk [src: sdk-sandbox].

## Sources

- sdk-index: https://openai.github.io/openai-agents-python/
- sdk-running: https://openai.github.io/openai-agents-python/running_agents/
- sdk-hitl: https://openai.github.io/openai-agents-python/human_in_the_loop/
- sdk-mcp: https://openai.github.io/openai-agents-python/mcp/
- sdk-sandbox: https://openai.github.io/openai-agents-python/sandbox_agents/
- sdk-multi: https://openai.github.io/openai-agents-python/multi_agent/
- sdk-sessions: https://openai.github.io/openai-agents-python/sessions/
- platform-agents: https://developers.openai.com/api/docs/guides/agents
- chatgpt-agent: https://openai.com/index/introducing-chatgpt-agent/
- chatgpt-work: https://openai.com/index/chatgpt-for-your-most-ambitious-work/
- workspace-agents: https://openai.com/index/introducing-workspace-agents-in-chatgpt/
- workspace-trigger: https://developers.openai.com/workspace-agents/trigger-runs
- agentkit: https://openai.com/index/introducing-agentkit/
- work-codex-help: https://help.openai.com/articles/20001275
- apps-help: https://help.openai.com/en/articles/11487775-connectors-in-chatgpt
