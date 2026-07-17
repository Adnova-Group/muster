# Tura-AI/tura — build-vs-buy investigation

Research target: **[Tura-AI/tura](https://github.com/Tura-AI/tura)** — determine what it is, how it is built, how mature it is, and whether muster should **ride** it as a harness target, **adopt/fork** it as a custom-harness substrate, **compete** with it, or **ignore** it. Every claim is tagged `[src: anchor]` resolving in the Sources list, and marked **[DOCUMENTED]** (Tura's own docs/README), **[CODE-VERIFIED]** (read directly from Tura source), or **[INFERRED]** (reasoned from evidence). [src: readme]

Method note: primary sources are the rendered GitHub README, the checked-in `docs/` and `ARCHITECTURE.md` tree, `Cargo.toml`, and two source files read directly (`permission.rs`, `planning/prompt.md`); repo metadata (stars, license, dates, contributors, releases) comes from the authenticated `gh api`. The repository is ~11 days old at time of writing and heavily benchmark-marketed, so maturity is reported honestly rather than inflated. [src: gh-meta] [src: gh-tree]

---

## 1. What it is — category verdict

**Verdict: Tura is a local, single-agent CODING HARNESS / runtime (an agent-runtime), not a multi-agent orchestrator and not a judgment layer.** It is the same product category as Codex CLI and Claude Code — the layer muster *rides on* — not a peer of muster's orchestration role. [src: readme] [src: arch]

Tura's own one-line description: *"Tura is a local, open-source coding agent for developers who are tired of vague skill claims, token-saving extensions with no evidence, and agents without judgment wreck their repos."* [DOCUMENTED] [src: readme] Its GitHub topics name the category precisely: `coding-agent`, `harness-engineering`, `context-engineering`, `token-optimization`, `agentic-ai`, `terminal-based`. [DOCUMENTED] [src: gh-meta] The project markets itself almost entirely on a head-to-head against Codex CLI: *"83.1% fewer turns; 16.7 percentage points higher success"* across 348 long-horizon benchmark sessions on DeepSWE v1.1 with GPT-5.6 SOL. [DOCUMENTED] [src: readme]

The thesis is **context/turn efficiency**, not orchestration: reduce repeated context and model round-trips so the saved token budget can be spent on lower cost ("Direct" mode) or more reasoning/verification ("Balanced" mode). [DOCUMENTED] [src: readme] It ships CLI, TUI, and a Tauri desktop GUI as thin fronts over one local backend pipeline. [DOCUMENTED] [src: arch]

## 2. Architecture

Tura is a Rust workspace (Rust 59.7%, TypeScript 19.6% for the GUI/TUI, plus JS/Python/PowerShell tooling). [src: gh-meta] The `Cargo.toml` workspace members are the load-bearing map: crates `gateway`, `provider`, `router`, `runtime`, `session_log`, `tools`, `path`, plus an `agents` crate and a `personas` crate; apps are `apps/tui`, `apps/gui`, and `apps/tauri`. [CODE-VERIFIED] [src: cargo] [src: gh-tree]

**Binary topology — single backend, many thin fronts.** One isolated backend per `TURA_HOME` instance owns all sockets/locks/DB (derived via `tura_path`) and is reused by every front. [DOCUMENTED] [src: arch] Package→binary map: `gateway`→`tura_gateway`/`tura_exec`, `runtime`→`tura_runtime`, `session_log`→`tura_session_db`, `router`→`tura_router`, `tools`→`code_tools`, `provider`→`tura_llm_rust`. [CODE-VERIFIED] [src: arch] Entrypoints: `tura` (TUI), `tura exec "prompt"` (direct Rust CLI runner), `tura run` (gateway-backed streaming), `tura_gateway` (local HTTP/SSE gateway + optional web GUI), `tura_gui` (desktop client). [DOCUMENTED] [src: readme]

### 2.1 The agent loop and the `command_run` macro tool

Tura's single most distinctive architectural choice: **it exposes exactly one model-visible tool, `command_run`, instead of a pile of small tools.** [DOCUMENTED] [src: doc-command-run] The model emits one `command_run` call carrying a `commands` array; each item names a `command_type` (`shell_command`/`bash`/`zsh`, `apply_patch`, `web_discover`, `read_media`, `generate_media`, `task_status`, optional `planning`), a `command_line` payload, and a `step` integer. [DOCUMENTED] [src: doc-command-run] The runtime runs same-`step` commands together (they must have no output dependency on each other), serializes mutating work, and returns one normalized envelope — collapsing what an ordinary tool-calling agent does in ~4-5 provider turns into a single turn when the actions are already known. [DOCUMENTED] [src: doc-command-run] The checked-in schema requires `minItems: 5, maxItems: 20` and instructs the model to "complete all currently needed steps in one batch." [CODE-VERIFIED] [src: doc-command-run] This macro-batching is the mechanical root of Tura's token/turn advantage. [INFERRED] [src: readme] [src: doc-command-run]

Two reasoning strategies wrap the loop: **backward reasoning** (guide the LLM to estimate the goal state `s(n-1)` and reason backward to root cause before writing code) and a **runtime context/prompt manager** that treats context as a state machine rather than an accreting pile of skill files. [DOCUMENTED] [src: readme]

### 2.2 `task_status` — the state control plane

Instead of storing task state as chat prose, Tura writes structured fields into the session via a `task_status` subcommand of `command_run`: `task_group`, `status` (one of `doing` / `question` / `done`), `task_type` (an array of runtime-prompt manual ids), and optional `compact_context`. [DOCUMENTED] [src: doc-task-status] These fields drive Operation-Manual selection, completion gates, and compaction handoffs — Tura calls it "a control plane, not a note to the model's future self." [DOCUMENTED] [src: doc-task-status] Notable gates: a startup gate **requires `task_type` before `apply_patch` or any write-producing shell command**, and `status: done` is only valid after required verification and media-inspection rules are satisfied. [DOCUMENTED] [src: doc-task-status] Because compaction is a CLI operation, exact execution state survives in `task_status.compact_context` (Tura claims resuming real work ~2.6 rounds post-compaction vs an estimated ~5.4 for Codex). [DOCUMENTED] [src: readme] [src: doc-task-status]

### 2.3 Agents, personas, and the "runtime prompt / operation manual" model (the anti-skills stance)

An **agent** in Tura is a configurable runtime *profile* (`agents/src/<agent_id>/agent_config.json` + `prompt.md`), not a system-prompt blob — it separately declares `provider` route (tier/model/streaming/temperature/reasoning), `agent_capabilities` (the command ids exposed through `command_run`), `op_manual` policy, and reflection flags, so tool access and model choice are auditable fields rather than buried in prose. [DOCUMENTED] [src: doc-agents] Built-ins are `balanced` (thinking route, op-manuals on, verification discipline), `direct` (fast route, op-manuals off), and `direct-text-only`. [DOCUMENTED] [src: doc-agents] [src: gh-tree] `parent_agent_id` exists but is documented as "reserved for hierarchy" — i.e. multi-agent trees are a placeholder, not a shipped capability. [DOCUMENTED] [src: doc-agents]

**Capability-gating is the security/extension surface:** the allowed command list is baked into the provider schema per agent, so an agent literally cannot see commands it wasn't granted — Tura contrasts this with stacks that "expose every installed tool to every agent and trust the prompt to say 'do not use that one'." [DOCUMENTED] [src: doc-agents] Runtime-Prompt **Operation Manuals** are `task_type`-scoped instruction sets loaded per task (and re-added after compaction); this is Tura's deliberate replacement for Markdown "skills," which it dismisses as "weaker prompts loaded into context." [DOCUMENTED] [src: doc-task-status] [src: doc-agents] **Personas** are a separate voice/expression layer that explicitly does *not* change what the agent may do ("an agent decides what work can be done; a persona decides how that work is communicated"). [DOCUMENTED] [src: doc-personas]

### 2.4 Tool dispatch, permission model, and planning — code-verified

The permission model is **env-driven approval policy, not per-call interactive prompting.** `crates/runtime/src/tool_flow/permission.rs` reads an `APPROVAL_POLICY_ENV`: `always` requests permission for every tool; `on-request`/`untrusted` gate only high-risk tools; anything else (incl. `never`/empty) requests nothing — and the *only* high-risk tool is `command_run` itself. [CODE-VERIFIED] [src: code-permission] Critically, the **runtime cannot grant permission itself** — it returns a blocked result and routes permission/`sandbox_bypass` decisions "through gateway/router before dispatch," i.e. permission is a gateway concern, capability-gating is the runtime concern. [CODE-VERIFIED] [src: code-permission]

**Planning/delegation** exists as a `planning` command (`crates/tools/src/commands/planning/`) — a phase-based multi-step plan (prefer 3-7 steps, `task_summary` per step) placed last in a `command_run` batch; the runtime applies the new plan after the batch finishes and feeds the first step as the next turn's focused input. [CODE-VERIFIED] [src: code-planning] This is **intra-session task sequencing for one agent**, not parallel multi-agent orchestration. [INFERRED] [src: code-planning] [src: doc-agents]

### 2.5 Config / runtime / persistence

Durable session, task, message, todo, and workspace history live in embedded SQLite owned by `tura_session_db`; a per-instance index/write-queue sits under `tura_path::home_db_dir()` and the full per-workspace log at `<workspace>/.tura/session_log.sqlite3`, reached by every process over a service socket. [DOCUMENTED] [src: arch] Gateway exposes HTTP/SSE session-log query endpoints; provider call logs are written separately as JSON `llm_call` records. [DOCUMENTED] [src: arch]

### 2.6 Extension model — what is deliberately ABSENT

A tree scan for extension primitives is decisive: **no MCP** (0 matches), **no "skills"** (0 — actively rejected; there is a blog post titled *"token-saving-plugins-are-mostly-stupid-idea"*), **no plugin system**, and **no hooks** (the only `hook` matches are React hooks in the GUI). [CODE-VERIFIED] [src: gh-tree] Extension is instead by **config files** — custom providers, custom personas, custom agents, custom commands, and custom runtime prompts are the documented customization surface. [DOCUMENTED] [src: readme] Tura is therefore a **closed, opinionated harness**: extensible by editing typed config, not by installing a marketplace of plugins/skills/MCP servers. [INFERRED] [src: readme] [src: gh-tree]

## 3. Stack, license, and maturity

| Dimension | Finding | Source |
| --- | --- | --- |
| Language/stack | Rust 59.7% core; TypeScript 19.6% (Tauri GUI + TUI); JS/Python/PowerShell tooling | [src: gh-meta] |
| License | **AGPL-3.0-or-later** (strong network copyleft) | [src: gh-meta] [src: readme] |
| Stars / forks / watchers | **96 stars**, 8 forks, 1 subscriber | [src: gh-meta] |
| Created / last push | Created **2026-07-06**; last push **2026-07-16** (actively developed) | [src: gh-meta] |
| Commits | 617 commits, but most authored by a self-hosting `tura-ai-agent` bot ("tura completed tura-…" sessions) | [src: readme] [src: gh-tree] |
| Contributors | **2**: `Yohjisakamoto` (223, the sole human) + `tura-ai-agent` (bot) — effective bus factor of one | [src: gh-contributors] [src: gh-meta] |
| Releases | 5 releases, latest **v0.1.33** (2026-07-14); published to npm as `tura-ai` | [src: gh-releases] [src: readme] |
| Open issues | 0 | [src: gh-meta] |
| Usable? | **Yes, but early** — `npm install tura-ai` + `tura`, or source install scripts; real releases exist | [src: readme] |

**Maturity read: pre-1.0, single-maintainer, benchmark-marketing-forward, ~11 days public.** [INFERRED] [src: gh-meta] Tura's own ROADMAP frames 0.1.x as "stabilize the foundation… make the behavior already present reliable before adding a wider product surface," and its `KNOWN_ISSUES`/roadmap concede the published benchmark covers **only GPT-5.6 SOL** — Anthropic/Claude, Gemini, OpenAI-compatible, local-provider, UI-latency, and cross-OS results "remain part of the documented roadmap and known evidence gaps." [DOCUMENTED] [src: roadmap] [src: readme] The 0.2 milestone is a "task-planning workspace." [DOCUMENTED] [src: roadmap] It is installable and demonstrably functional, but adopting it means betting on one developer, an unproven-outside-one-model efficiency claim, and a copyleft license. [INFERRED] [src: gh-contributors] [src: roadmap]

## 4. Overlap with muster

muster is a **glass-box judgment/orchestration layer that rides existing harnesses** (Claude Code, Codex, Cowork, GPT-Work, Hermes), staying silent below the border and applying proportional weight above it, delegating mechanics to each harness's tuned primitives. Tura is one of those *harnesses* — a substrate, not a peer orchestrator. [src: readme] [src: arch] The overlaps are philosophical convergence on the same problems, implemented at different layers:

1. **Explicit state control plane.** Tura's `task_status` (`doing`/`question`/`done` + `compact_context`) that survives compaction ≈ muster's run STATE, receipts, and BLOCKED→RESUME coordination protocol. Both reject "state as chat prose." Tura enforces it inside one runtime; muster enforces it across dispatched agents. [DOCUMENTED] [src: doc-task-status]
2. **Completion/progression gates.** Tura's startup gate (`task_type` required before `apply_patch`) and verified-`done` gate ≈ muster's review-gate / scale-gate / todo gate. Same "you may not advance until X" pattern, harness-internal vs orchestrator-imposed. [DOCUMENTED] [src: doc-task-status]
3. **Auditable agent contracts (glass-box).** Tura's agents as separated, inspectable fields (route / capabilities / manuals, not a prompt blob) and capability-gating baked into the schema ≈ muster's Crew Manifest with per-choice rationale and its router's capability-gated dispatch. Shared "readable contract, no hidden behavior" value. [DOCUMENTED] [src: doc-agents]

Non-overlaps that matter: Tura is **single-agent-per-session** (its `planning` is intra-session sequencing; `parent_agent_id` is a reserved placeholder), whereas muster's core is **multi-agent fan-out** — crews, dependency-ordered waves, tournaments, and an adversarial review gate. Tura has **no MCP/hooks/skills** extension surface, which is exactly the surface muster uses to bind itself onto a harness. [CODE-VERIFIED] [src: code-planning] [src: doc-agents] [src: gh-tree]

## 5. Build-vs-buy verdict

**Ride Tura as a harness target? → IGNORE now (watch later).** It is technically ride-able — `tura exec`/`tura run` give a headless CLI and the gateway gives HTTP/SSE, the same shape muster already drives for Codex/Claude Code. [DOCUMENTED] [src: readme] [src: arch] But the value is low and the friction high: (a) it offers **no subagent/parallel primitive**, so muster's crews/waves/tournaments would have nothing to bind to — muster would have to fake fan-out by spawning many `tura exec` processes with no shared state; (b) **no MCP/hooks/skills** means none of muster's standard binding mechanisms exist — no PreToolUse gate, no MCP "brain," no skill routing; (c) it is 96 stars, ~11 days old, single-maintainer, GPT-5.6-only-benchmarked, AGPL. The harnesses muster already rides are radically more capable and extensible. Riding Tura buys nothing muster needs today. [INFERRED] [src: gh-meta] [src: gh-tree] [src: code-permission]

**Adopt/fork Tura as the custom-harness substrate? → DO NOT adopt; STUDY as prior art.** Three hard blockers against adopt/fork: **(1) License** — AGPL-3.0-or-later is strong network copyleft; forking it would force AGPL onto muster's derivative work, incompatible with muster shipping as a permissive npm package (`@adnova-group/muster`). [DOCUMENTED] [src: gh-meta] **(2) Architecture mismatch** — Tura is a from-scratch single-agent Rust runtime; muster's identity is multi-agent orchestration, so adopting Tura means inheriting a whole runtime whose core assumption (one agent per session) fights muster's core. [INFERRED] [src: doc-agents] **(3) Bus factor** — one human contributor, 0.1.x, unverified beyond one model. [src: gh-contributors] [src: roadmap] However, as **prior art / design reference it is genuinely valuable and validates several muster theses**: the `command_run` macro-batching (turn/token reduction by structural batching), `task_status` as a survives-compaction state machine, and capability-gating-in-schema over prompt-begging are all clean, defensible ideas worth mining if muster ever builds its own harness. [DOCUMENTED] [src: doc-command-run] [src: doc-task-status] [src: doc-agents]

**Compete? → No direct competition.** Tura competes with Codex CLI / Claude Code (harness layer), not with muster's orchestration/judgment layer. The only philosophical rivalry is the shared "opinionated context discipline + auditability" stance, which is convergence, not collision. [INFERRED] [src: readme] [src: doc-agents]

**Net effect on build-vs-buy:** Tura does **not** push muster toward BUY-a-substrate. It is a useful existence proof that a solo dev built a credible efficiency-focused harness quickly, but AGPL + single-agent design + immaturity make it unsuitable to ride or fork. It reinforces the **harness-native-first / ride-existing-harnesses** posture: keep muster the judgment layer, borrow Tura's *ideas* (not its code) if a custom harness is ever built. [INFERRED] [src: readme] [src: roadmap]

## 6. Relationship table

| Tura capability | muster equivalent | ride / adopt / compete / ignore | Rationale |
| --- | --- | --- | --- |
| `command_run` macro-batch tool (5-20 cmds, step-parallel, one turn) | No equivalent — muster relies on each harness's native tool loop | **ignore code / adopt idea** | Elegant turn/token reducer, but AGPL Rust; borrow the batching concept for a future muster harness, don't import it [src: doc-command-run] |
| `task_status` compaction-surviving state machine (`doing`/`question`/`done`, `compact_context`) | Run STATE + receipts + BLOCKED→RESUME coordination | **converge (adopt idea)** | Same "explicit state, not prose" thesis; Tura does it in-runtime, muster across agents — validates muster's design [src: doc-task-status] |
| Startup gate + verified-`done` gate | review-gate / scale-gate / todo gate | **converge** | Both gate progression; confirms gates are the right primitive [src: doc-task-status] |
| Agents as capability-gated, auditable profiles | Crew Manifest + router (capability-gated dispatch) | **converge (glass-box)** | Shared "readable contract" value; Tura single-agent, muster multi-agent [src: doc-agents] |
| `planning` command (3-7 phase intra-session plan) | plan / waves / backlog decomposition | **compete (muster stronger)** | Tura sequences one agent; muster fans out crews + tournaments — muster's is a superset [src: code-planning] |
| Personas (voice layer, no capability change) | n/a (muster stays silent below border) | **ignore** | Presentation concern muster deliberately doesn't own [src: doc-personas] |
| Env-driven approval policy (gateway-routed, `command_run`=high-risk) | Hook-based PreToolUse gates / MCP approval modes on ridden harnesses | **ignore** | Weaker/coarser than the harnesses muster already rides; nothing to gain [src: code-permission] |
| CLI (`tura exec`/`tura run`) + HTTP/SSE gateway | Dispatch surface muster drives on Codex/Claude Code | **ignore now / watch** | Ride-able in principle, but no subagent/MCP/hooks + immature + AGPL = no value today [src: arch] |
| Whole runtime (Rust workspace, AGPL-3.0) | The custom harness muster might someday build | **do not adopt/fork** | Copyleft + single-agent + bus-factor-1; mine ideas, not code [src: gh-meta] [src: gh-contributors] |

---

## Sources

- readme: https://github.com/Tura-AI/tura (rendered README, scraped 2026-07-17)
- gh-meta: `gh api repos/Tura-AI/tura` — stars 96, forks 8, license AGPL-3.0, created 2026-07-06, pushed 2026-07-16, topics, Rust primary
- gh-tree: `gh api repos/Tura-AI/tura/git/trees/main?recursive=1` — 1866 paths; crate/app layout; 0 MCP, 0 skills, 0 sandbox, 0 approval, plugin only in blog title, hooks = React only
- gh-releases: `gh api repos/Tura-AI/tura/releases` — v0.1.33 (2026-07-14) latest, 5 releases
- gh-contributors: `gh api repos/Tura-AI/tura/contributors` — Yohjisakamoto (223) + tura-ai-agent bot
- arch: https://github.com/Tura-AI/tura/blob/main/ARCHITECTURE.md
- cargo: https://github.com/Tura-AI/tura/blob/main/Cargo.toml (workspace members)
- roadmap: https://github.com/Tura-AI/tura/blob/main/ROADMAP.md
- doc-agents: https://github.com/Tura-AI/tura/blob/main/docs/core/agents.md
- doc-command-run: https://github.com/Tura-AI/tura/blob/main/docs/core/command-run.md
- doc-task-status: https://github.com/Tura-AI/tura/blob/main/docs/core/task-status.md
- doc-personas: https://github.com/Tura-AI/tura/blob/main/docs/core/personas.md
- code-permission: crates/runtime/src/tool_flow/permission.rs (read via gh raw contents API — APPROVAL_POLICY_ENV, command_run = only high-risk tool, gateway-routed)
- code-planning: crates/tools/src/commands/planning/prompt.md (read via gh raw contents API — 3-7 step intra-session plan, last in batch)
- website: https://turaai.net/ (official site / benchmark, linked from README)
