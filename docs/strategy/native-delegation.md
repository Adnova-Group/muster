# Maximal native-delegation plan + the build-vs-buy verdict

Strategic synthesis answering the maintainer's challenge: *"Make it even faster and even
less bloated. Make me not want to build a custom harness (or convince me maybe it's worth
a shot). For each harness muster targets, do everything we can to replace muster skills,
plugins, gates, and nags with native harness functionality."*

Evidence base: the seven naked-base-loop research docs and the capstone
`reference-harness-design.md` [src: ref-a] [src: ref-c], the codex-burn decision records
[src: dr-efficiency] [src: dr-install], and a first-hand inventory of the current muster
surface [src: m-surface] [src: m-hooks]. Claims grounded in a research doc or muster's own
code are cited by anchor to the Sources list; claims that are strategic judgment beyond
what a doc asserts are marked **[JUDGMENT]**. The trajectory this doc extends is already
set: enforcement simplified to one action fence + one border invitation, weight-reduction
(fast path, diff-scaled gates, cli-resolve) and speed-tuning landed, and the first
harness-native-delegation pass rode plan-mode / task-board / worktrees [src: m-surface].

---

## Part A — Build vs buy: should muster own a harness?

The question is whether muster should stay a **judgment layer riding existing harnesses**
or become a **custom muster-native harness** muster fully controls. Both sides steelmanned,
then a verdict.

### Steelman: BUILD a custom harness

- **One enforcement model muster fully controls — no advisory-only ceiling.** The codex
  burn taught that hooks can be advisory-by-design: Codex's `PreToolUse` is "a guardrail
  rather than a complete enforcement boundary" because `unified_exec`, subagent tool work,
  and non-shell tools are unintercepted [src: cx-hooks], and the `codex-efficiency-enforcement`
  contract was *retired, not rescoped*, because its fail-closed clauses were "architecturally
  unreachable… it never existed" [src: dr-efficiency]. A harness muster owned could make every
  gate a true pre-execution veto, the way Claude Code's `PreToolUse deny` already is
  [src: cc-hooks].
- **No per-harness porting tax.** Today muster reasons about seven surfaces with different
  hook, permission, and dispatch semantics, plus live contradictions — config-file local
  MCP servers in Cowork [src: cw-mcp], plugin-bundled hooks not executing on Codex 0.144
  [src: cx-hooks]. One surface erases all of that.
- **Muster's opinionated lifecycle becomes first-class.** Waves, barriers, adversarial
  review gates, and tournaments are prose discipline riding on top of a loop muster doesn't
  own [src: m-surface]; a custom harness could bake them into the loop as primitives.
- **It is provably buildable.** The reference spec states a minimal CLI+desktop harness is
  reconstructible from Part A's nine components [src: ref-a].

### Steelman: BUY — stay a judgment layer

- **The native infra muster rides free is enormous, and each piece is a serious program.**
  Every harness already supplies: a homogeneous tool-use loop with context compaction
  [src: cc-loop] [src: cc-context], tool dispatch/registry with schema deferral [src: cc-mcp],
  a layered permission model plus an OS sandbox (seatbelt/bubblewrap) [src: cc-perm]
  [src: cc-sandbox], append-only session persistence with resume/fork/rewind [src: cc-sessions],
  subagent isolation in git worktrees [src: cc-subagents], the SKILL.md extension ecosystem
  [src: cc-skills], the hook lifecycle [src: cc-hooks], an MCP client [src: cc-mcp], and a
  config/auth/quota topology metering a shared subscription pool [src: cc-config]
  [src: cxd-quota] — plus desktop/IDE integration whose internals are an explicit
  documentation GAP a from-scratch build would have to spike, not read [src: ref-a].
- **Reach.** Staying a layer buys seven harnesses — and their installed bases — for the
  price of thin adapters [src: ref-c]. A custom harness buys one surface and zero installed
  base; users must adopt a brand-new tool. **[JUDGMENT]**
- **The harnesses are converging, so the porting tax is falling, not rising.** SKILL.md /
  agentskills.io is the near-universal extension unit [src: cc-skills] [src: hermes-skills];
  MCP is the universal capability bus [src: cc-mcp] [src: cx-mcp]; and Claude Code's hook
  block-JSON is the de-facto standard — Hermes adopts it *verbatim*, accepting
  `{"decision":"block","reason":…}` and mapping `UserPromptSubmit`→`pre_llm_call`
  [src: hermes-hooks]. The one thing BUILD would buy — a single controlled surface — is
  being commoditized by standards muster already writes against once and runs near-verbatim
  on Hermes and Codex. **[JUDGMENT]**
- **The enforcement ceiling is already solved out-of-loop.** Muster's augmentation-vs-
  enforcement doctrine puts determinism in muster's *own* code (manifest validation,
  worktree/base-SHA receipts, the deterministic CLI/MCP brain) and hard-enforces only at the
  single native veto per harness [src: ref-c]. The burn came from fighting for in-loop hard
  enforcement muster couldn't reach [src: dr-efficiency] — exactly the fight a custom harness
  would re-open on its own dime.

### The middle path — a thin muster runtime on one harness's primitives

Rather than a full harness, muster could ship a **runner lane** on one substrate. Two
candidates:

- **OpenAI Agents SDK.** It gives a native orchestration loop for free — the `Runner` loop
  with handoffs and agents-as-tools, plus per-agent `model` override [src: gw-sdk] — and
  real opt-in blocking via `needs_approval` + `RunState.reject()` [src: gw-hitl]. But it has
  **no plan mode, no task board, no wave-barrier / review-gate / tournament** primitive
  [src: gw-sdk], and it is a *framework to build on, not an installed harness*; targeting it
  means muster "ships a runner lane built on it, owning dispatch, gates, receipts"
  [src: gw-verdict].
- **Hermes — the closest fit.** Skills port near-verbatim (agentskills.io) [src: hermes-skills],
  hooks port near-verbatim (Claude Code block shape) [src: hermes-hooks], and **kanban IS
  muster's coordination protocol already implemented as harness machinery** — atomic claims,
  structured `task_runs` handoff metadata, `kanban_block(kind)` with auto-resume, heartbeats,
  an append-only `task_events` ledger [src: hermes-kanban] — with real hard denies via
  `pre_tool_call` block hooks and `approvals.deny` globs that survive even yolo mode
  [src: hermes-approval].

### Verdict

**Stay a judgment layer. Do NOT build a custom harness. Confidence: HIGH (~85%).**
The one asset a custom harness buys — a single fully-controlled enforcement surface — is
precisely the asset the ecosystem is commoditizing through SKILL.md, MCP, and the Claude-Code
hook standard, while the assets muster rides free (loop, sandbox, sessions, MCP, worktrees,
plan-mode, task-board, subagent dispatch, desktop/IDE, multi-provider auth, quota) are each a
multi-quarter build that a solo-maintained project would under-deliver — the desktop internals
alone are a documented GAP requiring a hands-on spike [src: ref-a]. The enforcement ceiling
that motivates BUILD is already answered by the out-of-loop augmentation doctrine
[src: ref-c], and the burn record shows that chasing in-loop hard enforcement is where muster
*lost*, not where it won [src: dr-efficiency]. **[JUDGMENT]**

The middle path is the only part of "maybe it's worth a shot" worth funding — and only as an
**optional Hermes-hosted (or Agents-SDK) runner lane added beside the layer strategy, never
as a replacement.** Hermes clears the bar (first-class; kanban = coordination; skills+hooks
near-verbatim) [src: hermes-port]; the Agents SDK is a genuine build, not an augmentation, so
it earns a bounded spike at most [src: gw-verdict]. The maintainer should not want to build a
custom harness: the faster/less-bloated win comes from **deleting muster mechanics that now
duplicate converged natives**, not from owning a new substrate. **[JUDGMENT]**

---

## Part B — Per-harness maximal-native-replacement map

For each harness: the muster construct, the native replacement on *that* harness, the win,
the risk, and the effort. "Keep muster" means no native equivalent exists and the muster
construct stays load-bearing.

### 1. Claude Code CLI — the reference implementation (strongest natives)

| muster construct | native replacement | win | risk | effort |
|---|---|---|---|---|
| orchestrator prose wave loop | agent-teams / `Workflow` background-agent surface (dispatch, `ListAgents`, `SendMessage`, `Monitor`) [src: cc-augment] | wave orchestration off-loads to tuned native scheduling; less prose in-context | Workflow reached only via agent-teams mode, not the single-session loop — capability-gated [src: cc-augment] | M |
| hand-managed worktrees | `Agent` tool `isolation:"worktree"` (auto-cleaned, shell-locked) [src: cc-subagents] | real branch isolation muster doesn't script; **landed #47** | none — already native | done |
| subagent dispatch | `Agent` tool (`subagent_type`, `model`, `isolation`); own context window; nesting ≤5 [src: cc-subagents] | 7 muster-* profiles ride native `.claude/agents/*.md`; identity via unforgeable `agent_id` [src: cc-hooks] | none | done |
| approve-first flow (`/muster:plan`) | plan mode (permission mode) + `ExitPlanMode`, plans persisted `~/.claude/plans/` [src: cc-plan] | Crew Manifest becomes the native plan artifact; **landed #47** | `EnterPlanMode` string vs docs-inference conflict [src: cc-plan] | done |
| STATE-mirrored task board | `TaskCreate/Update/List`; `TaskCompleted` hook *gates* the tick [src: cc-plan] | native board = user-visible progress; TaskCompleted hook ties a tick to review PASS | task board superseded TodoWrite — API churn | L |
| action fence (sole DENY) [src: m-hooks] | `PreToolUse permissionDecision:"deny"` — the one hard veto [src: cc-hooks] | already native; keep as the run-scoped, manifest-derived fence static rules can't express **[JUDGMENT]** | over-broad deny trains global disables [src: cc-hooks] | keep |
| border invitation (WARN) [src: m-hooks] | `additionalContext` injection / `SessionStart` context [src: cc-hooks] | muster-opinion nudge; already rides native injection | none (advisory) | keep |
| coordination protocol | no native durable board on CLI; GitHub-issues binding stays [src: m-surface] | — | — | keep |
| skills / verbs | `SKILL.md` progressive disclosure; `.claude/commands/*.md` = same mechanism [src: cc-skills] | verbs already ARE native slash commands; skills already native | none | done |

### 2. Claude Code Desktop / Web — stronger isolation, repo-`.claude/` is the only plane

| muster construct | native replacement | win | risk | effort |
|---|---|---|---|---|
| hand-managed worktrees | **automatic** per-session worktree under `<root>/.claude/worktrees/` [src: ccd-config] | stronger than CLI (opt-in) — muster scripts nothing | worktree location is native-owned | done |
| config delivery | repo-scoped `.claude/` is the sole plane reaching cloud VMs [src: ccd-config] | commit-everything makes muster reach every surface incl. cloud | `~/.claude/` never reaches cloud — user-scope installs invisible there [src: ccd-augment] | L |
| orchestrator wave loop | "dynamic workflows" run in place of agent-teams on Desktop [src: ccd-arch] | native multi-workstream execution | agent teams off by default on Web (env-flag) [src: ccd-arch] | M |
| session-context nudges | `SessionStart` hooks fire on every start/resume, local and cloud (`CLAUDE_CODE_REMOTE`) [src: ccd-augment] | border invitation rides native lifecycle | — | keep |
| run output surface | Artifacts + `Claude-Session` git trailer / session URL [src: ccd-web] | native traceable deliverables | — | L |
| everything else | inherits CLI engine ("the agentic loop is identical") [src: ccd-arch] | — | — | done |

### 3. Claude Cowork — MCP-only today, but a native plugin surface may now exist

| muster construct | native replacement | win | risk | effort |
|---|---|---|---|---|
| the whole ride (21-tool MCP server + `instructions` protocol injection) | **possibly** native plugins — Cowork now bundles skills/hooks/subagents in the Claude Code plugin format [src: cw-plugins] | if `plugin/` loads under Cowork's loader, muster rides skills-as-`/`-menu natively instead of MCP-only [src: cw-plugins] | **unverified** — the single highest-value open question; adapter's "no plugin/skill/hook primitives" claim is stale [src: cw-plugins] | **probe (L)** |
| orchestrator wave loop | prompt-steered parallel fan-out (no dispatch API) [src: cw-subagents] | native fan-out exists; muster steers by prompt | no task-graph, no wave gate, per-call model override probe-only [src: cw-subagents] | keep |
| action fence (DENY) | **none hookable** by an MCP integrator [src: cw-augment] | — | muster's fence has no Cowork equivalent — session discipline is the only enforcement [src: cw-augment] | keep (advisory) |
| coordination / STATE | none — plan is free-form prose, STATE hand-written [src: cw-loop] | — | no dependency-ordered graph, no isolation model for concurrent items [src: cw-loop] | keep |
| permission gate | native Manual/Auto/Skip modes + hard delete-approval [src: cw-loop] | native anti-exfiltration review muster reuses | UI-modal, not settings.json rules, not injectable [src: cw-augment] | ride |

### 4. Codex CLI — advisory hooks by design; MCP is the only hard gate

| muster construct | native replacement | win | risk | effort |
|---|---|---|---|---|
| orchestrator wave dispatch | `collaboration.spawn_agent` / `wait_agent` / `list_agents`; custom-agent TOML per profile [src: cx-subagents] | native multi-agent dispatch; 27 TOML profiles ride it | must send `fork_turns:"none"` + `agent_type`; Codex REJECTS `agent_type`+`fork_turns:"all"`; fail-closed on rejected profile, never silent-degrade [src: cx-subagents] | M |
| worktree isolation | **no cwd field on subagent dispatch** [src: cx-subagents] | — | isolation is muster's own dispatch discipline verified by path/base-SHA receipts, not harness-guaranteed [src: cx-subagents] | keep |
| action fence / any gate | hooks are **advisory-by-design** — narrow interception, loop routes around [src: cx-hooks] | redesign every Codex gate to advisory-or-absent — **landed (codex-enforcement-port)** [src: dr-efficiency] | fail-closed clauses are unreachable; "it never existed" [src: dr-efficiency] | done |
| genuine hard gate | MCP governance (`required`, allow/deny tool lists, per-tool approval), `sandbox_mode` [src: cx-mcp] | "use MCP (not hooks) when a gate genuinely must gate" [src: cx-mcp] | narrow surface | ride |
| approve-first flow | bundled `plan` skill + `permission_mode:"plan"` + plan-update loop items [src: cx-loop] | native plan surface for `/muster:plan` | no standalone plan-mode object | M |
| skills / verbs | `SKILL.md` (agent-skills standard); `$muster-*` routing; marketplaces read legacy `.claude-plugin/` [src: cx-skills] | verbs+skills already native | plugin-bundled hooks not executed on 0.144 → install into `hooks.json` layer [src: cx-hooks] | done |
| thread/quota budgets | `agents.max_threads`(6)/`max_depth`(1); 25-step ceiling discipline [src: cx-subagents] [src: cxd-quota] | honor native limits — shared 5h pool is the burn hazard [src: cxd-quota] | budgets/timeouts have no install-time host [src: dr-efficiency] | ride |

### 5. Codex Desktop — same core, cross-surface parity, one shared config

| muster construct | native replacement | win | risk | effort |
|---|---|---|---|---|
| profile/plugin/config delivery | one generated artifact (shared `config.toml`, custom-agent TOML, marketplace) reaches CLI+IDE+desktop [src: cxd-config] | write once, reach all local clients | WSL/Windows split-home hazard; `doctor --codex` for drift [src: cxd-config] | ride |
| subagent visibility | subagent activity appears across desktop/CLI/IDE; `/agent` switcher [src: cxd-arch] | native observability; muster adds none | dispatch API (`spawn_agent`) documented only in CLI doc [src: cx-subagents] | done |
| task board | Projects view; tasks are the unit of work [src: cxd-arch] | native task tracking (desktop-only; CLI has none) [src: cxd-arch] | desktop-only | L |
| worktree bootstrap | desktop-only per-project `.codex` worktree setup scripts [src: cxd-arch] | native worktree bootstrap for new tasks | not on CLI | ride |
| hooks | advisory — inherits the Codex CLI lesson (desktop doc doesn't restate it) [src: cx-hooks] | advisory-or-absent | same as CLI | done |

### 6. GPT-Work / OpenAI Agents SDK — a framework, not an installed harness

| muster construct | native replacement | win | risk | effort |
|---|---|---|---|---|
| ChatGPT Work lane | **none needed** — ChatGPT Work = Codex substrate; the Codex lane covers it [src: gw-verdict] | zero new porting for the product surface | write-only Workspace-agents trigger today [src: gw-verdict] | done |
| inner per-turn agent/tool/handoff loop | `Runner.run` loop + handoffs + agents-as-tools + per-agent `model` [src: gw-sdk] | muster need not hand-roll the inner loop on an SDK lane | it's a build, not an augmentation [src: gw-verdict] | keep muster loop (spike) |
| wave-barrier / review-gate / tournament | **no native equivalent** — SDK has no plan/task-board/wave primitive [src: gw-sdk] | — | muster MUST keep its dependency-ordered wave loop + gates on top [src: gw-sdk] | keep |
| action fence (DENY) | `needs_approval` predicates + `RunState.reject()`; MCP `require_approval` — real blocking [src: gw-hitl] | genuine hard deny (opt-in), unlike Codex hooks | hosted shell/tools cannot be gated locally; nothing gates by default [src: gw-hitl] | M (lane) |
| worktree isolation | Sandbox agents beta: `Manifest` + capabilities + resumable [src: gw-sandbox] | native per-task sandbox | beta / churn-risk [src: gw-sandbox] | keep |
| coordination / session | pluggable Session backends (SQLite/Redis/Encrypted); durable `RunState` resume [src: gw-hitl] | native persistence for a runner lane | — | ride (lane) |

### 7. Hermes — the closest-fit port (first-class)

| muster construct | native replacement | win | risk | effort |
|---|---|---|---|---|
| **coordination protocol (CLAIM/RECEIPT/BLOCKED/LEDGER)** | **kanban.db durable queue** — atomic claims, `task_runs` handoff metadata, `kanban_block(kind)` auto-resume, heartbeats, `task_events` ledger [src: hermes-kanban] | coordination is *already implemented as harness machinery* — becomes a thin Binding D [src: hermes-port] | Python plugin surface vs Node muster [src: hermes-port] | M |
| orchestrator wave loop | `delegate_task(goal,context,toolsets,role)` incl. parallel batch; fresh child context [src: hermes-delegation] | native fan-out with fresh-context leaves | model override is config-level, not per-call [src: hermes-delegation] | M |
| action fence (DENY) | `pre_tool_call` hooks `{"action":"block"}` + `approvals.deny` globs (survive yolo) [src: hermes-approval] [src: hermes-hooks] | real hard denies muster's fence maps onto | permissive default (dangerous-pattern interception, not allowlist) [src: hermes-approval] | L |
| worktree isolation | `hermes -w` disposable worktrees; kanban `worktree` workspaces; checkpoints/`/rollback` [src: hermes-worktree] | native per-task isolation + rollback | — | done-ish |
| approve-first flow | protected `plan` skill + `/plan`; `/goal` completion contracts [src: hermes-loop] | native plan surface | no documented blocking plan-approval mode — muster enforces approve-first itself [src: hermes-port] | M |
| skills / verbs | agentskills.io `SKILL.md`; every skill auto a slash command; GitHub taps [src: hermes-skills] | ports near-verbatim ("Direct") [src: hermes-port] | — | done |
| hooks payload | accepts Claude Code block-JSON verbatim; `UserPromptSubmit`→`pre_llm_call` [src: hermes-hooks] | write once against CC contract, runs here [src: hermes-hooks] | — | done |

---

## Part C — The irreducible muster core

After maximal delegation, what genuinely CANNOT be handed to any harness is **judgment**, and
it clusters in five places [src: m-surface]:

1. **Routing** — which crew a given outcome needs (`domain-router` + `router` skills over the
   deterministic `domain.js` / `detect.js` / `fast-path.js` / `scope.js` substrate).
2. **Crew composition** — the capability-ladder binding of role → provider → model → dispatch
   type, each member carrying provider/source/model/rationale/evidence/fallback
   (`router` skill + `capabilities.js` / `match.js` / `manifest.js` / `crew.js`).
3. **Adversarial review-gate ORCHESTRATION** — who reviews, the any-blocker-blocks tally, the
   fix-loop-or-escalate arithmetic (`review-gate` skill + `review.js` / `gate-cadence.js`).
   Harnesses give a reviewer *agent*; none gives muster's *gate policy*.
4. **The opinionated skill CONTENT / know-how** — the domain pipelines (`prd-pipeline`,
   `roadmap-prioritization`), the one-question interview, the anti-pattern ledger, the burn
   discipline. Skills are the near-universal *format* [src: cc-skills]; the *content* is
   irreducibly muster's.
5. **Tournament / fusion** — competing-solution dispatch, de-identified judging, deterministic
   `muster fuse` (`tournament` skill + `fusion.js` / `tournament.js`).

**One-liner:** *After maximal delegation muster IS the glass-box judgment layer — routing,
crew composition, adversarial-gate orchestration, opinionated skill know-how, and
tournament/fusion — with its determinism living in muster's own out-of-loop CLI/MCP brain;
everything else (the loop, isolation, plan mode, task board, subagent dispatch, sessions, MCP,
hook enforcement) is a thin adapter over native primitives.* [src: ref-c]

---

## Part D — The faster / less-bloated scorecard

What survives as **muster-owned** vs becomes a **thin native adapter** after maximal delegation.

| surface | count | survives muster-owned | thins to native / retire |
|---|---|---|---|
| **skills** | 11 | **11/11** survive as owned *content* — skills are the irreducible core [src: m-surface] | the load-bearing *mechanic inside* 2 skills delegates: orchestrator wave loop → Workflow/spawn_agent/delegate_task; coordination → Hermes kanban binding. 4 of 5 largest already cut ≥40% by speed-tuning [src: m-surface] |
| **verbs** | 11 | **8/11** real entry points, already riding the native slash-command layer (a command file IS the native primitive) [src: cc-skills] | **3 legacy alias stubs** (autopilot/run/sprint) — retire-eligible behind a deprecation window [src: m-surface] |
| **hooks** | 8 JS files → **3 wired** | enforcement already collapsed to **1 hard deny (action fence) + 1 warn (border invitation)** [src: m-hooks] | no owned judgment in the hook layer — real quality enforcement is the review-gate skills; on advisory-only harnesses the deny degrades to warn (Codex) or is absent (Cowork) [src: cx-hooks] [src: cw-augment] |
| **agents** | 27 | **7/27** muster-* profiles (crew-role judgment); dispatch mechanic is 100% native [src: cc-subagents] | **20 vendored wsh-*** (MIT) — already "buy," muster owns none of their content [src: m-surface] |
| **src/ brain** | ~23 modules | the deterministic judgment substrate stays owned (manifest/capabilities/match/fusion/review/gate-cadence/fast-path/scope/domain/detect/sprint-waves/crew) [src: m-surface] | thin mechanics absorb-able or self-scaffolding: `wave.js` (generic topo-sort), `cli-resolve.js` (npx perf shim), the projection/lint family (token/perf/plan-budget/brief-lint/skill-footprint) [src: m-surface] |

**Net bloat verdict:** the surviving muster-owned surface is **11 skills (content) + 8 verbs +
2 hook behaviors + 7 agent profiles + the deterministic src/ brain**. The delete/thin column
is **3 legacy verbs, 20 vendored agents (already bought), the 5 self-measurement helper
modules, and the dispatch/isolation/plan/task-board mechanics now delegated to natives.**
Skills don't shrink in *number* — they ARE muster — they shrink in *token footprint* and in
the amount of native-mechanic narration they carry. **[JUDGMENT]**

**Token / latency, measured and projected:**

- Already shipped and measured: a bare 1-task `/muster:plan` = **8,831 tokens** (≤15k target
  met); plan-to-manifest = **806 ms** (≤60s met); 4 of 5 largest skills cut **≥40%**;
  small-task consumption cut to **39.8%** (60.2% reduction) [src: m-perf].
- Open gap: the fast path is at **41.2%** of full-pipeline tokens vs the ≤25% target — closed
  by `fast-path-token-gap` (lighter reviewer prompt + cheaper reviewer tier for small diffs)
  [src: m-perf].
- Projected from native delegation: deleting the prose wave-loop, worktree-management, and
  task-board-mirror narration from the orchestrator + coordination skills removes per-dispatch
  context those skills currently carry; the exact figure needs measurement on the eval/perf
  harness after each delegation lands. **[JUDGMENT]**

---

## Execution backlog (native-replacement items, ordered by value/effort)

Assess-ready one-liners with measurable success criteria, tagged `[harness | thins/retires]`.
Items already captured in `.muster/backlog.md` are marked (existing #line); the rest are new.

1. **cowork-plugin-loader-probe** `[Cowork | thins: 21-tool MCP-only adapter]` — Hands-on probe
   whether muster's `plugin/` (skills+hooks+subagents, Claude Code plugin format) loads under
   Cowork's native plugin loader; if it loads, add a capability check that prefers the native
   plugin ride over MCP-only, MCP server kept as fallback. Success: a documented probe result
   with evidence; if it loads, ≥1 muster skill invoked via Cowork's `/` menu and the adapter's
   stale "no plugin/skill/hook primitives" claim corrected; fallback preserved; suite green.
2. **workflow-tool-delegation** (existing #123) `[Claude Code | thins: orchestrator wave-loop
   prose]` — orchestrator rides the native Workflow/agent-teams tool for wave dispatch when
   available, prose loop as fallback. Success: documented capability check, one worked
   multi-wave example dispatched via the native tool, fallback tested, suite green.
3. **hermes-kanban-binding** (existing #124) `[Hermes | thins: coordination skill to a native
   binding]` — map CLAIM/RECEIPT/BLOCKED/LEDGER onto Hermes `kanban.db` as Binding D. Success:
   a Binding D spec mapping each protocol state to a kanban column/annotation/`task_event`,
   cited to hermes.md §4, fallback + validation smoke-trail, suite green.
4. **codex-spawn-agent-dispatch** `[Codex CLI/Desktop | thins: orchestrator dispatch mechanic]`
   — wave dispatch rides `collaboration.spawn_agent`/`wait_agent`/`list_agents` with
   `fork_turns:"none"` + `agent_type`, fail-closed on a rejected profile (never silent-degrade
   to generic). Success: a routed multi-wave run dispatches each crew member via `spawn_agent`
   honoring `agent_type`; a rejected-profile case fails loud with a registration diagnostic;
   sequential-inline fallback when `multi_agent` is off; cited to codex-cli.md §6; suite green.
5. **task-board-authoritative** `[Claude Code (+Codex partial) | thins: STATE-mirrored board
   bookkeeping]` — native task board becomes the authoritative progress surface: `TaskCreate/
   Update` per item, `TaskCompleted` gating hook ties the tick to review-gate PASS, STATE.md
   demoted to durable ledger. Success: a go-backlog run creates one native task per item, flips
   in_progress/completed via native task tools, the completion tick is blocked until review
   PASS, STATE carries no board-mirror duplication; Codex maps to thread goals where available;
   suite green.
6. **coordination-footprint** (existing #128) `[all bindings | thins: coordination SKILL
   bloat]` — extract the 3 bindings' shared CLAIM/RECEIPT/LEDGER machinery to cut the
   coordination SKILL ≥40% without dropping protocol state. Success: SKILL ≥40% smaller than
   its pre-speed-tuning size, all binding contract tests green, no state dropped.
7. **native-plan-mode-parity** `[Codex, Hermes, Cowork-fallback | thins: approve-first flow]` —
   extend the shipped `ExitPlanMode` ride so `/muster:plan` drives native plan surfaces on
   every plan-capable harness (Codex `thread/goal` + `plan` skill; Hermes `/plan` + completion
   contracts) with the Crew Manifest as the plan artifact; Cowork degrades to prose. Success:
   one worked approve-first example per harness routing through the native plan surface,
   capability check + prose fallback, cited to each harness doc, suite green.
8. **fast-path-token-gap** (existing #127) `[all | thins: review-gate cost on small diffs]` —
   close the fast path to ≤25% token consumption via a lighter single-reviewer prompt + a
   cheaper reviewer model/effort tier for sub-threshold diffs. Success: a bare 1-task fast-path
   run measures ≤25% vs the full pipeline on eval/perf, no reduction in what the single reviewer
   checks, suite green.
9. **agents-sdk-runner-lane** `[GPT-Work/Agents SDK | retires the "no native loop → keep muster
   loop" gap for a runner lane]` — bounded spike: a thin muster runner lane on the Agents SDK
   `Runner` loop + handoffs + per-agent model, with muster supplying the wave-barrier +
   review-gate + receipts on top and `needs_approval` as the action-fence analog. Success: a
   2-wave outcome runs through the lane with muster's review gate between waves and
   `needs_approval` gating the forbidden action class, one worked example, documented as an
   optional lane not a replacement; cited to gpt-work.md §2/§4.
10. **worktree-isolation-native** `[all | thins: hand-managed worktrees]` — dispatched crew
    members use native worktree isolation everywhere it exists (Claude Code
    `isolation:"worktree"` — landed; Desktop automatic `.claude/worktrees/`; Hermes `hermes -w`
    / kanban worktree workspaces); Codex has no cwd-on-dispatch → keep receipts discipline.
    Success: crew runs in native worktrees on CC/Desktop/Hermes with base-SHA receipts, Codex
    path documented as receipts-verified, suite green.
11. **skill-content-only-thinning** `[all | thins: skills]` — audit each of the 11 skills to
    strip prose that merely re-narrates a native mechanic muster now delegates (wave-driving,
    worktree-management, task-board-mirroring), keeping only judgment + capability check +
    fallback. Success: measured per-skill footprint drop with contract tests still green, no
    load-bearing rule dropped.
12. **brief-lint-coverage** (existing #129) `[all | thins: dispatch briefs]` — expand
    `src/brief-lint.js` beyond its 2 marked templates to every dispatch/return-contract
    template. Success: lint scans all dispatch sites, flags briefs >2k / returns >1k tokens, a
    test asserts coverage of every site, suite green.
13. **legacy-alias-retirement** `[all | retires: 3 verbs]` — sunset autopilot/run/sprint behind
    a deprecation window (one-time notice, then retire after N releases), shrinking the verb
    surface 11→8. Success: deprecation notice shipped + dated, docs updated, alias tests assert
    the notice, no behavior change during the window.
14. **codex-hooks-advisory-audit** `[Codex | guards against fail-closed assumptions]` — a test
    asserts no muster construct assumes a fail-closed Codex hook (per dr-efficiency). Success:
    a guard test enumerates Codex-targeted gates and fails on any fail-closed assumption, green
    on the current tree.

---

## Part E — 2026-07-19 gap sweep: dated verdict ledger

A native-vs-replicated gap sweep run 2026-07-19 over surfaces this doc had not re-checked since
Part B's per-harness tables were written. Recorded here, dated, so the judgment survives past the
sweep session — the same durability discipline `codex-cli.md`'s dated experiment-design records
use for unproven primitives.

### DECLINED — evaluated and rejected, with rationale

1. **Codex `review/start` as a reviewer-dispatch seed.** Codex's app-server exposes a built-in
   reviewer via `review/start`, emitting review items over the same Thread/Turn protocol as any
   other collaboration primitive [src: cxd-review]. Declined as a seed for muster's review gate:
   the native reviewer cannot carry muster's own opinionated gate duties — the citation guard
   (`$MUSTER_CLI citation-check`, review-gate SKILL step 3), the intent-vs-implementation
   `git notes --ref=muster` check (step 4), the three surface-type definition-of-done gates
   (design/UX, humanizer, live-verification), and the worker-exhaustion contract that forces a
   deterministic block on any exhausted/absent reviewer entry (PR #82 `tally-worker-exhaustion`,
   PR #84 `exhaustion-status-producer`) [src: m-review-gate]. None of these ride `review/start`'s
   emitted items. This is not a new finding — gate ORCHESTRATION was already ruled irreducible in
   this file's own Part C item 3 ("Harnesses give a reviewer *agent*; none gives muster's *gate
   policy*") [src: m-surface]; `review/start` is exactly that kind of agent, and the sweep confirms
   it changes nothing about the verdict. **[JUDGMENT]**
2. **Native memory stores (Codex `memories`) as a replacement for `src/memory.js`.** Codex's
   `[features]` table gates a `memories` flag that is, uniquely among the table's listed flags,
   marked "(experimental, false)" — default OFF, unlike `hooks`/`multi_agent`/`unified_exec`/`goals`,
   which default on [src: cx-config]. muster's own store (`src/memory.js`) is slug-indexed,
   markdown-backed, and portable across every harness this doc targets — nothing harness-specific
   in its shape [src: m-memory]. Declined: building a muster mechanism on an experimental,
   default-false native primitive is exactly the codex-burn lesson — the burn record shows chasing
   unproven internals instead of a documented, stable contract is where muster lost quota, not
   where it won [src: dr-efficiency]. Codex's own `goals` primitive gets a dated, gated
   experiment-design record in `codex-cli.md` §3.1 for the same reason before any binding is built;
   `memories` doesn't even clear the "default true" bar that record demands as a precondition.
   **[JUDGMENT]**

### KEEP-AS-IS — reconfirmed, no change

Each: native primitive checked against, muster's mechanism, why it stays.

- **STATE.md append-only ledger** vs native per-session transcripts (Claude Code JSONL, Codex
  rollout events). STATE.md is portable across harnesses, human-readable without a session-log
  parser, and glass-box by design; native session logs are per-session, per-harness, and
  machine-local [src: cc-sessions] [src: m-surface].
- **Hygiene reaping** (`src/hygiene.js`) vs native auto-clean. No harness in this doc's inventory
  reaps orphaned provider processes, stranded worktrees, or dead cross-runner claims on its own —
  this is written from the real burn incident where exactly that gap cost quota [src: dr-efficiency]
  [src: m-surface].
- **Per-wave git commits + `git notes --ref=muster` provenance** vs Claude Code `/rewind`
  checkpoints. Checkpoints "only track changes made through Claude's file editing tools," not Bash
  or external processes, and are "explicitly not a git replacement" [src: cc-sessions] — they cannot
  carry the intent-vs-implementation record the review gate's step 4 reads.
- **Coordination CLAIM/RECEIPT/LEDGER protocol** vs the per-session task board (`TaskCreate/Update/
  List`). No harness in this doc's inventory ships a durable cross-runner claim board — this file's
  own earlier verdict already covers Claude Code CLI ("no native durable board on CLI") and the same
  absence holds on every other surface checked here [src: m-surface].
- **Advisor file round-trip** vs agent-teams `SendMessage`. `SendMessage` is reached only via
  agent-teams mode, capability-gated and non-portable [src: cc-augment]; the file round-trip works
  in a plain session on every harness, no mode switch required.
- **`AGENTS.md` left user-owned.** The border where muster stays silent below it — unchanged, no
  native primitive competes with a file muster deliberately does not write to [src: m-surface].

### Cross-references — the sweep's delegations that DID land

The next wave in this ledger, already shipped since Part B's tables were written:

- **`agent-maxturns-native-cap`** (PR #87) — native `maxTurns` caps landed on all 27 Claude-shipped
  agent defs, sized per role class, superseding the prose-only 25-step ceiling on that lane.
- **`skill-frontmatter-capabilities`** (PR #88) — native Claude Code frontmatter capability keys
  (`allowed-tools`/`disallowed-tools`, `argument-hint`, `disable-model-invocation`) landed on the
  skills/commands whose documented workflow actually supports them, evidence-first per file.
- **`structured-output-binding`** (PR #91) — landed with its own honest finding: native constrained
  output (Claude `StructuredOutput`/`--json-schema`, Codex `--output-schema`) is proven out of reach
  for reviewer dispatch on both lanes — neither binds to the in-session Agent-tool / `spawn_agent`
  call the review gate actually dispatches reviewers through. The real win was schema
  single-sourcing (`verdict.schema.json` read by both a hand-rolled validator and `tallyReview`),
  not native enforcement.
- **`harness-goal-primitives`** (PR #92) — Claude Code's native `/loop` scheduling landed as a
  documented runner-mode option (carrying the "likely blocked today, verify before relying on it"
  caveat its own fix loop produced); Codex's `thread/goal/*` stayed an explicitly NOT-wired, gated
  experiment-design record — nothing wires to it until a human runs the four-point proof this
  ledger's DECLINED `memories` verdict above holds itself to the same bar on.
  - Later settled by **`loop-dmi-conflict`** (2026-07-20): the `/loop` caveat resolved to a
    definitive negative from primary docs, so no live cycle was needed. As of Claude Code v2.1.196
    a scheduled/`/loop` fire does not execute a `disable-model-invocation: true` command (it reaches
    Claude as plain text), so `/loop /muster:runner` is documented-inert — `runner.md` keeps
    `disable-model-invocation: true` on the routing-safety rationale, standing cadence stays
    Routine/cron, and Claude Code's `/goal` (a completion CONDITION re-checked each turn, distinct
    from `/loop`'s time-interval re-fire) is confirmed as the native condition-based self-continuing
    alternative.

---

## Sources

- ref-a: docs/research/reference-harness-design.md Part A + Buildability note — universal nine-component anatomy; minimal harness reconstructible; desktop internals a GAP.
- ref-c: docs/research/reference-harness-design.md Part C — augmentation-vs-enforcement doctrine; per-harness port surface table; advisory-line placement.
- cc-loop: docs/research/claude-code-cli.md §1–2 — one homogeneous tool-use loop; turn structure; PostToolBatch.
- cc-context: docs/research/claude-code-cli.md §2.2–2.3 — startup context assembly; compaction.
- cc-perm: docs/research/claude-code-cli.md §3.1 — tiered permission rules deny→ask→allow; auto classifier.
- cc-hooks: docs/research/claude-code-cli.md §3.2–3.3 — 31-event lifecycle; PreToolUse permissionDecision deny (the one hard veto); unforgeable agent_id.
- cc-sandbox: docs/research/claude-code-cli.md §3.4 — OS-level Bash sandbox (seatbelt/bubblewrap).
- cc-sessions: docs/research/claude-code-cli.md §4 — JSONL transcript event log; resume/fork/rewind.
- cc-subagents: docs/research/claude-code-cli.md §5 — Agent tool; subagent_type/model/isolation; own context; nesting ≤5; worktree isolation.
- cc-plan: docs/research/claude-code-cli.md §6 — plan mode; ExitPlanMode; task board (TaskCreate/Update/List, TaskCompleted gating hook); EnterPlanMode conflict.
- cc-skills: docs/research/claude-code-cli.md §7 — SKILL.md progressive disclosure; .claude/commands = same mechanism as skills.
- cc-mcp: docs/research/claude-code-cli.md §8 — MCP client scopes; mcp__server__tool; ToolSearch schema deferral.
- cc-config: docs/research/claude-code-cli.md §9 — config scopes; ~/.claude state root; subscription quota.
- cc-augment: docs/research/claude-code-cli.md §10 — augmentation surface; agent-teams / Workflow reached via background-agent mode, not the single-session loop.
- ccd-arch: docs/research/claude-code-desktop.md §1–4 — one engine many shells; identical loop; dynamic workflows vs agent teams; Projects/tasks.
- ccd-web: docs/research/claude-code-desktop.md §3 — cloud VM per session; Claude-Session trailer; session URL.
- ccd-config: docs/research/claude-code-desktop.md §9, §2.2 — repo `.claude/` is the only plane reaching cloud; automatic per-session worktrees under <root>/.claude/worktrees/.
- ccd-augment: docs/research/claude-code-desktop.md §11 — augmentation surfaces; SessionStart hooks + CLAUDE_CODE_REMOTE; ~/.claude never reaches cloud.
- cw-loop: docs/research/claude-cowork.md §2 — 5-step free-form loop; absent primitives (no task graph, no wave gate, hand-written STATE, no concurrent-item isolation).
- cw-mcp: docs/research/claude-cowork.md §3 — MCP integration plane; local-server doc contradiction.
- cw-plugins: docs/research/claude-cowork.md §3d — native plugin system (skills/hooks/subagents, Claude Code plugin format); falsifies adapter's "no plugin/skill/hook primitives"; muster-load unverified.
- cw-subagents: docs/research/claude-cowork.md §4 — prompt-steered parallel fan-out; no dispatch API; per-call model override probe-only.
- cw-augment: docs/research/claude-cowork.md §7 — augmentation table; no integrator-hookable enforcement; UI-modal permission modes.
- cx-loop: docs/research/codex-cli.md §1 — Thread/Turn/Items via codex exec; bundled plan skill; permission_mode plan.
- cx-config: docs/research/codex-cli.md §3 — [features] table; memories flag marked experimental, default false (unlike hooks/multi_agent/unified_exec/goals, default true).
- cx-hooks: docs/research/codex-cli.md §4.2–4.3 — advisory-by-design line; "guardrail rather than a complete enforcement boundary"; plugin-bundled hooks not executed on 0.144.
- cx-skills: docs/research/codex-cli.md §5 — SKILL.md; $muster-* routing; marketplaces read legacy .claude-plugin.
- cx-subagents: docs/research/codex-cli.md §6 — collaboration.spawn_agent/wait_agent/list_agents; fork_turns:"none" + agent_type contract; no cwd on dispatch; max_threads/max_depth.
- cx-mcp: docs/research/codex-cli.md §7 — MCP governance (required/allow-deny/approval) = the most governable, hardest-enforcing surface.
- cxd-arch: docs/research/codex-desktop.md §1–2, §7–8 — shared Rust core; app-server; cross-surface subagent parity; Projects/tasks (desktop-only); per-project .codex worktree scripts.
- cxd-config: docs/research/codex-desktop.md §3–5 — shared CODEX_HOME/config.toml reaches all local clients; WSL/Windows split-home; doctor for drift.
- cxd-review: docs/research/codex-desktop.md §8 — review/start, a built-in reviewer emitting review items over the app-server Thread/Turn protocol.
- cxd-quota: docs/research/codex-desktop.md §9 — shared 5h window; local+cloud one pool; the burn mechanism; 25-step discipline.
- gw-sdk: docs/research/gpt-work.md §2, §4 — Agents SDK Runner loop + handoffs + agents-as-tools + per-agent model; no plan/task-board/wave primitive.
- gw-hitl: docs/research/gpt-work.md §2.4 — default approval-free; needs_approval + RunState.reject() real blocking; MCP require_approval; hosted tools ungateable locally; Session backends.
- gw-sandbox: docs/research/gpt-work.md §6 — Sandbox agents beta; Manifest + capabilities + resumable.
- gw-verdict: docs/research/gpt-work.md §1.1, §9 — ChatGPT Work = Codex substrate; Agents SDK is a build (runner lane), not an augmentation.
- hermes-loop: docs/research/hermes.md §2, §4 — AIAgent loop; protected plan skill + /plan; /goal completion contracts.
- hermes-approval: docs/research/hermes.md §3 — dangerous-pattern interception; approvals.deny globs survive yolo (hard block); permissive default.
- hermes-hooks: docs/research/hermes.md §7 — pre_tool_call {"action":"block"} veto; accepts Claude Code block-JSON verbatim; UserPromptSubmit→pre_llm_call.
- hermes-kanban: docs/research/hermes.md §4 — kanban.db durable queue: atomic claims, task_runs handoff metadata, kanban_block(kind) auto-resume, heartbeats, task_events ledger.
- hermes-skills: docs/research/hermes.md §7 — agentskills.io SKILL.md; every skill auto a slash command; GitHub taps.
- hermes-delegation: docs/research/hermes.md §5 — delegate_task(goal,context,toolsets,role) + parallel batch; fresh child context; config-level (not per-call) model override.
- hermes-worktree: docs/research/hermes.md §6 — hermes -w disposable worktrees; kanban worktree workspaces; checkpoints/rollback.
- hermes-port: docs/research/hermes.md §10–11 — first-class verdict; skills/hooks Direct; kanban = coordination protocol as harness machinery; Python-shim port constraints.
- dr-efficiency: docs/decisions/retriage-codex-efficiency-enforcement.md — retire-not-rescope; fail-closed unreachable on Codex ("it never existed"); advisory-diagnostics-only consequence.
- dr-install: docs/decisions/retriage-install-items.md — thread-limits invalidated and re-opened with fail-loud floor.
- m-surface: plugin/skills/*, plugin/commands/*, plugin/agents/*, src/*.js — current muster inventory: 11 skills, 11 verbs (8 canonical + 3 legacy aliases), 27 agents (7 muster + 20 vendored wsh), the deterministic src/ brain.
- m-hooks: plugin/hooks/pre-tool-use.js + hooks.json — 3 wired hooks (SessionStart/UserPromptSubmit/PreToolUse); enforcement collapsed to one action-class fence (sole DENY) + one border invitation (WARN).
- m-perf: docs/weight-reduction.md + .muster/STATE.md weight/speed-tuning receipts — plan=8,831 tok; plan-to-manifest 806 ms; 4/5 largest skills cut ≥40%; small-task consumption 39.8%; fast-path 41.2% vs ≤25% target.
- m-memory: src/memory.js — slug-indexed, markdown-backed memory store; no harness-specific dependencies, portable across every harness this doc targets.
- m-review-gate: plugin/skills/review-gate/SKILL.md — citation guard (step 3), intent-vs-implementation git notes check (step 4), surface-type definition-of-done gates, worker-exhaustion forced-block contract (PR #82 tally-worker-exhaustion, PR #84 exhaustion-status-producer).
