# muster vs gsd-core v1.20.1: lifecycle gap analysis (Claude Code + Claude Desktop only)

Date: 2026-11-09. Read-only. muster at `revival/stage-1` (93f8ce8). gsd-core at tag v1.20.1 (9385f46, 2026-11-05).
"M:" = muster repo path, "G:" = gsd-core clone path. Line numbers are from these checkouts.

## 0. Facts that constrain every verdict

1. **The Workflow tool has no filesystem or Node API.** Per the workflow-authoring reference: "Standard JS built-ins ... No filesystem or Node.js API access", and `Date.now()` / `Math.random()` throw. A workflow script therefore **cannot run git, the muster CLI or a test command itself**. Any deterministic check (base-SHA assert, `git merge-base --is-ancestor`, plan-structure lint, failing-direction probe) must run in one of two places: inside an agent that calls Bash and returns a `schema`-validated object, or in the main thread between workflows. That is one main-session round trip per deterministic step. It matters for receipts (section 5).
2. **Workflow capabilities usable for muster:** `agent({schema, model, effort, isolation:'worktree', agentType})`, `pipeline()` (no barrier), `parallel()` (barrier), `workflow()` (one nesting level), `resumeFromRunId` with a cached prefix, and a `journal.jsonl` holding each agent's actual return. Concurrency is capped at min(16, CPUs-2).
3. **The Workflow tool has never been invoked live by muster.** See M:docs/native-workflow-dispatch.md "Honest scoping" ("not a live-invocation demonstration"). There is no `plugin/workflows/` directory today.
4. **Whether a Workflow agent can use AskUserQuestion: not determined.** So human stops sit *between* workflows.
5. **gsd's orchestration is prose plus a 172k-line TypeScript runtime.** `wc -l src/*.cts` reports 172,182 lines. Every workflow opens with the same ~2 KB `gsd_run` resolver one-liner (G:gsd-core/workflows/resume-project.md:29, add-backlog.md Step 2). Calls to `gsd_run`/`gsd-tools` per workflow: plan-phase 41, execute-phase 43, verify-work 24, code-review 24, quick 28, autonomous 22. Adopting gsd means **taking agents and references, not workflows or runtime**.
6. **gsd ships always-on hooks**, which are disqualifying under muster's constraints. G:hooks/hooks.json registers SessionStart ×3, PreToolUse ×6 matchers (Write/Edit/Read/Grep/Bash/Agent), PostToolUse context-monitor + read-injection-scanner, SubagentStop, Stop, PreCompact and FileChanged. None are adopted.
7. **Churn by file class, v1.10.0 → v1.20.1** (`git rev-list --count`, ~3 months, 11 minor releases):
   - references: 0–2 commits each (revision-loop 2, honest-verifier 0, prohibition-probe 0, failing-direction 1, verifier-evidence-gate 1, context-budget 1, worktree-branch-check 0);
   - agents: 10–24 commits each (plan-checker 14, planner 21, executor 24, verifier 18, code-reviewer 10);
   - workflow spines: execute-phase.md 60, plan-phase.md 41.

   **Adopt the stable layer (agents and references); never track the spines.**
8. **The `.compact.md` agents do not apply to Claude Code.** G:gsd-core/references/compact-content-gate.md:52-60 says they fire "only inside the #2454 persona fallback for non-Claude, AGENTS-native runtimes that cannot dispatch a named subagent". They are also not much smaller: code-reviewer is 24.5 KB, its compact variant 20.7 KB. Ignore them.
9. **muster's existing gsd ports cannot work as shipped.**
   - M:plugin/builtins/gsd-{plan-phase,execute-phase,verify-work}/SKILL.md total 209 KB.
   - They contain 104 `gsd_run`/`gsd-tools` calls (45/46/13) and 13 `subagent_type="gsd-*"` dispatches (e.g. gsd-plan-phase:1050 `gsd-planner`).
   - muster ships **no gsd agents** (`ls plugin/agents | grep gsd` is empty), so they only work when gsd-core is separately installed.
   - Pin 18995380 (2026-06-29) is **2,445 commits** behind v1.20.1 (M:vendor/manifest.yaml:284-310).

## 1. Routing / crew choice

**muster.**
- The crew is assembled by an LLM. The router skill emits a Crew Manifest JSON (M:plugin/skills/router/SKILL.md:29-46). It runs `muster match` per specialist (:17) and `match --skills` for **every plan task** (:18).
- The structural validator (M:src/manifest.js:102-154) checks field presence, enums and dep ids, not fitness.
- Tiers are deterministic, from three sets (M:src/model.js:22,32,105-109: scout for nav/research, apex for judge/arch-review/improve/advisor, core otherwise). They map through M:src/claude.js:30-47 to haiku/sonnet/opus/fable. Effort is Workflow-only (claude.js:15-28; B3 notes the Agent tool now has `effort`).
- Known failure mode, documented in muster's own prompt: the "all-inline crew means routing was bypassed ... silently degrades to in-context work" (M:plugin/commands/go.md:78-83).
- Cost: detect, assess, fast-path, capabilities, router skill, N× match, then validate until ok. The revival review measured ~14+2N main-session turns before the first builder (M:docs/strategy/2026-11-revival-review.md:23).
- The fast path (M:src/fast-path.js, go.md:56-72) is muster's one deterministic shortcut, and it works.

**gsd.**
- A fixed roster with a profile table resolved in code: quality/balanced/budget/adaptive/inherit × 12 agents (G:gsd-core/references/model-profiles.md:7-20).
- Precedence: per-agent override, then per-phase-type map, then profile, then runtime default (:54-63).
- "Omit, do not emit an empty model" on inherit (#2517, model-profile-resolution.md:43-50).
- Specialist routing is a per-plan `agent_hint:`, default-on and resolved against the agent registry. When the hint is absent or unresolvable it falls back to `gsd-executor` "byte-identical to today" (G:gsd-core/workflows/execute-phase/steps/per-plan-executor-routing.md:11-39; CHANGELOG:1023).
- Weakness: the orchestrator-worktree path ignores the hint (:39).

**Robustness judgement.** gsd's is more robust *because the crew cannot be wrong*. Planner, checker, executor, verifier and reviewer always exist; only models vary, deterministically. muster's breadth (52 wsh agents, skill binding) is a capability, but it is LLM-assembled and costs O(N) round trips. The owner's claim holds for robustness, not for breadth.

**Verdict: MERGE.**
- From gsd: the fixed role roster plus the profile table (as muster tiers: `budget`/`balanced`/`quality`/`inherit`), the per-phase-type override, omit-on-inherit, and per-task `agent_hint` with executor fallback.
- From muster: the tier vocabulary and the claude.js adapter (extended with Agent-tool `effort`), and `match` as a *one-shot* candidate list passed into the planner prompt so the planner can set `agent_hint`. No per-task CLI calls.
- Delete: the router skill, the Crew Manifest crew block, `capabilities.json` for the software route, and `domain-router` for software (keep it only for the non-software pipelines, out of scope).
- Weight: −5 KB router skill, plus the manifest validator's crew half. Round trips: ~3+N fewer main turns. Role→model resolution becomes a pure function called inside the preflight CLI.

## 2. Planning and plan checking

**muster.**
- `plan-checklist` is a renderer, not a checker (M:src/checklist.js:8-13).
- The real gate is go.md step 4's "spec gate" (M:plugin/commands/go.md:97-121). A fresh architecture-review agent probes as a "lazy implementer" and a "malicious one" and verifies cited files exist. It returns free text ≤1500 chars with PASS/FAIL. There are no dimensions and no structured issue schema.
- Recovery (`specGateRecoveryState`, M:src/loop.js:127) continues "beyond the old round-2/round-3 boundary" as long as candidate bytes change. Any rewrite counts as progress.
- Planning is the router plus sp-plan (superpowers writing-plans, M:plugin/builtins/sp-plan/SKILL.md, 7.4 KB).
- The interview (M:plugin/skills/interview/SKILL.md) asks one AskUserQuestion at a time behind a HARD GATE. It only produces success criteria.

**gsd.**
- gsd-plan-checker (G:agents/gsd-plan-checker.md, 47.6 KB) has 12+ named dimensions:
  - coverage (:126), task completeness (:155), dependency correctness (:189), temporal coupling (:220), key links (:262), scope (:297, 5+ tasks is a blocker at :885), verification derivation (:346);
  - CONTEXT compliance (:376), scope-reduction detection, always a blocker (:423-452);
  - Nyquist and stated failing direction (:519-531), CLAUDE.md compliance (:551);
  - verify-command sanity: "a gate that already passes at HEAD ... BLOCKER (it measures nothing)" (:698).
- Structured issues carry `dimension, severity, required_property, description, fix_hint`. Only `required_property` binds (:913-960; revision-loop.md:65-80).
- A tool exit status other than 0/1 is "not evaluated" and is never read as "no errors" (:778). "Issues of ANY severity → ISSUES FOUND" (:899).
- The revision loop (G:gsd-core/references/revision-loop.md:7-52) caps at 3 iterations and escalates as stalled when BLOCKER+WARNING count does not decrease. A `REVISION_CONFLICT` return is not counted as a failed attempt.
- Deterministic probes run *before* the checker. The checker must not hand-reason them (failing-direction.md:32-38). Code: G:src/gate-verify-failure-directions.cts (42 lines), gate-verify-command-paths.cts (78), gate-decision-coverage-plan.cts (199) plus decision-coverage-support.cts (371), plan-document.cts (512), gate-codebase-drift.cts (292).
- gsd-planner: tracer-first decomposition by default (G:agents/gsd-planner.md:253-275), `<reversibility>` with a one-way checkpoint (:211), `<precondition>` (:209), `must_haves` goal-backward (:445-484), and user-decision fidelity via D-NN citations (:53-77).
- discuss-phase extracts phase-specific gray areas (G:gsd-core/workflows/discuss-phase.md:87-112), then writes locked decisions to CONTEXT.md that the checker enforces (Dimension 7).

**Verdict: ADOPT gsd** (planner + checker + revision loop + probes), **merging two muster pieces**:
- muster's interview UI and HARD GATE, rewritten to elicit gsd gray areas and emit D-NN decisions;
- muster's "malicious implementer" probe, added as one checker dimension.

Replace `specGateRecoveryState`'s byte-change progress with gsd's issue-count stall rule. Delete plan-checklist and sp-plan.

- gsd files: `agents/gsd-planner.md`, `agents/gsd-plan-checker.md`, `references/revision-loop.md`, `references/failing-direction.md`, `references/planner-verify-command-grounding.md`, `references/planner-reversibility.md`, `references/planner-mvp-mode.md` (tracer), `references/prohibition-probe.md`, `references/plan-checker-examples.md` (optional), plus the `src/gate-verify-*.cts` and `plan-document.cts` logic ported to plain JS in muster's CLI as `muster plan-lint` (~900 lines).
- Weight:
  - planner and checker each cut from ~48 KB to a **≤20 KB budget**. Remove `gsd_run` (8/14 calls), `.planning` paths (15/0), 29/9 `@~/.claude/gsd-core` refs, and RESEARCH/PATTERNS/Nyquist/UI dimensions muster does not produce. These are subagent prompts: a per-spawn token cost, zero main-context cost.
  - The revision loop lives in `plan.js` as code. Plan + check + revise takes **1 main-session round trip** (one Workflow call). `muster plan-lint` runs in a small lint agent inside the loop: subagent turns, not main-session turns.

## 3. Execution and waves

**muster.**
- The orchestrator skill (M:plugin/skills/orchestrator/SKILL.md, 29.5 KB, ~7.4k tok, over the 5k re-attach budget) is a prose wave loop:
  - waves from `muster wave` (62-line src/wave.js);
  - `isolation:"worktree"` on Agent for multi-writer waves;
  - owns/frozen fences;
  - `dispatchRetryState` retries;
  - return contract ≤2000 chars (:121-133).
- Action-fence propagation into each worktree (:58-66).
- A native Workflow path is described (:180-208) but has never run live.
- muster-builder is a 4 KB agent with refusal rules.

**gsd.**
- execute-phase.md is a 91.6 KB spine with 21 step fragments.
- Battle scars encoded as runnable guards:
  - orchestrator cwd-drift refusal after a worktree dispatch, with a stranded-work handoff report (#48/#1856, :445-530);
  - capture of `EXPECTED_BASE` before dispatch (:597-600);
  - "one Agent() per message ... simultaneous `git worktree add` calls race on `.git/config.lock`" (:665-671);
  - the orchestrator is the single writer of STATE/ROADMAP after a worktree merge (:949);
  - worktree-branch-check.md (2.9 KB, 0 churn).
- gsd-executor (47.8 KB):
  - deviation Rules 1–4 (auto-fix bug / add missing critical / unblock / STOP for architectural, :178-278);
  - analysis-paralysis guard;
  - atomic per-task commit protocol (:439-586);
  - destructive-git prohibition (:588-643);
  - SUMMARY with a typed deviation ledger (:645-748);
  - **self-check**, `git merge-base --is-ancestor` per claimed commit and `[ -f ]` per claimed file, with "Do NOT proceed ... if self-check fails" (:750-766).

**Verdict: REPLACE the orchestration with native Workflow; ADOPT gsd-executor (merged with muster-builder) and gsd's worktree guards.**
- `build.js` takes waves from PLAN frontmatter (`wave`/`depends_on`/`files_modified`, validated by the checker's Dimension 3/3b) and runs `pipeline()` per wave of `agent({agentType:'muster:executor', isolation:'worktree', schema})`.
- From muster-builder: the refusal of cross-cutting work and the one-slice scope.
- From gsd-executor: deviation rules, commit protocol, destructive-git prohibition, SUMMARY and self-check.
- From muster: the fast path for single tasks (gsd `quick` equivalent), plus the action fence (owner fence exception, M:docs/strategy/2026-11-revival-review.md:37).
- `worktree-branch-check.md` is embedded verbatim in the executor brief. Because the script cannot run git, the base-SHA assert runs **inside the executor agent** and comes back as `base_sha_ok` in the schema.
- Whether Workflow's worktree creation also races on `.git/config.lock`: **not determined.** Keep a concurrency knob and test it live.
- Weight: orchestrator skill cut to ≤18 KB chars of must-hold rules; the wave loop moves out of the prompt. One Workflow call per build: **~1 main-session round trip per run instead of 2+ per wave.**

## 4. Review

**muster.** M:plugin/skills/review-gate/SKILL.md, 7.9 KB:
- diff-size reviewer scaling plus a semantic security trigger (:17-30);
- concurrent refuters (:31);
- a citation guard;
- `verdicts.json` against a schema, then `tally`. M:src/review.js:6-27 **fails closed** on an exhausted/absent reviewer.
- The progress-aware fix loop is up to 12 total iterations while the digest changes (M:src/loop.js:94-125).
- Surface gates: UI, copy, live-integration.
- **Mutant-kill gate** (:84-100): the mutation, the failing output and a byte-identical restore are required for any new guard.

The reviewer agent itself is 1.6 KB with a generic checklist (M:plugin/agents/muster-reviewer.md). There is **no goal-backward verifier**: nothing checks that the outcome was delivered rather than the tasks completed. The tournament and fuse (M:plugin/skills/tournament, M:src/fusion.js) have no gsd equivalent.

**gsd.**
- gsd-code-reviewer (24.5 KB): an adversarial stance, three depth levels, deterministic grep pre-scans (secrets, dangerous functions, empty catch, unpinned actions), and CR/WR/IN classification.
- gsd-verifier (49 KB):
  - goal-backward must-haves, three-level artifact checks plus a data-flow trace, key-link wiring, requirements coverage, anti-pattern and stub scan, behavioural spot-checks, a self-check of the written status (:187-841);
  - **honest abstain**: `verification: backstop` truths without explicit evidence become `insufficient_spec` and then `human_needed`, never passed. The trigger is exogenous, not self-confidence. Measured false-pass rate went 100% → 17% (G:gsd-core/references/honest-verifier.md:9-60);
  - **convergence evidence gate**: on re-verification, a new-scope blocker must be a carried-forward gap or a regression in a file modified since the last verify. This prevents endless gap cycles (G:gsd-core/references/verifier-evidence-gate.md:1-60).
- **must-NOT probe**: recall→precision elicitation of omitted prohibitions into checkable criteria at spec time (G:gsd-core/references/prohibition-probe.md). The edge-probe caught 0/8 of these.
- Cross-AI review via external CLI lanes (review.md, reviewer-instances.md) depends on `gsd_run review-lane` and external CLIs.
- verify-work: conversational UAT into UAT.md (49.5 KB).

**Verdict: MERGE.**
- From gsd:
  - **ADD** gsd-verifier as a new seat (heavy adapt, ≤20 KB) with honest-verifier and verifier-evidence-gate included;
  - **REPLACE** the muster-reviewer body with gsd-code-reviewer (light-to-medium adapt, ≤16 KB);
  - **ADOPT** the prohibition-probe into the planner and interview (must_haves.prohibitions);
  - **ADOPT** revision-loop semantics for fix cycles (cap 3, stall on non-decreasing count), replacing the 12-iteration digest loop.
- Keep from muster: tally fail-closed, diff-size scaling plus the semantic security trigger, the mutant-kill gate and the surface gates. These are deterministic or evidence-shaped and stronger than anything gsd has for those cases.
- Keep the tournament as an optional `mode: tournament` in `build.js` (parallel N + judge); it is not on the default path.
- Not adopted: gsd cross-AI lanes (Codex is frozen; external CLIs) and full UAT. gsd `human_needed` items go to the single attended merge stop, using `templates/UAT.md` as the format only.
- Native option: the built-in `/code-review` as an extra correctness seat. Not default.
- Weight: review runs inside `build.js`, so 0 extra main turns. Per-wave subagent spawns go from 1–2 to 2–3 (reviewer, security when triggered, verifier once per run rather than per wave).

## 5. Receipts and evidence

**muster.**
- A signed Ed25519 evidence broker (M:src/sprint-evidence-broker.js; M:src/sprint-waves.js is 1,158 lines). It needs a separately privileged host service.
- go-backlog itself says production process dispatch "is currently report-only because trusted broker bootstrap is unavailable" (M:plugin/commands/go-backlog.md:118), and "If that service/callback integration is unavailable, use the sequential fallback" (:127).
- `receipt-verify` only checks that a SHA exists in git (M:src/cli.js:901-918).
- STATE is free-form model prose.
- The memory note "Receipt count-accuracy pattern" records that 4 of 5 review blockers in one run were fabricated counts.
- `backlog-receipts` (170 lines) checks that a backlog tick's merge SHA is release-reachable. It is small, deterministic and useful.

**gsd.**
- Atomic per-task commits.
- SUMMARY.md with frontmatter, a typed deviation ledger and a mechanical Self-Check (G:agents/gsd-executor.md:645-766).
- VERIFICATION.md with a machine status (`passed | gaps_found | human_needed`) and a self-check of the written status (G:agents/gsd-verifier.md:828).
- `.planning/` committed (`commit_docs`).

**Verdict: REPLACE with native + ADOPT gsd artifacts.**
- Receipts become:
  - the Workflow `journal.jsonl` (native, records each agent's actual return);
  - `schema`-validated returns, whose *counts are re-derived by the agent from git or a test exit*, not narrated;
  - gsd atomic commits plus SUMMARY self-check plus VERIFICATION.md, committed on the work branch.
- Retire the signed broker, sprint-evidence-*, sprint-broker-state, kimi/orca receipts and `receipt-verify`.
- Keep `backlog-receipts`.
- Caveat (fact 1): a schema validates shape, not truth. Truth comes from the executor/verifier running the self-check commands. The script can cross-check *consistency*, for example that the `commits[]` an executor claims equal the commits the verifier saw via `git log`. That is plain JS over two agent returns.

## 6. State and continuity

**muster.**
- `.muster/STATE.md`, appended prose. `.muster/*` is gitignored except backlog.md (M:.gitignore:2-3), so state does not travel with the work branch or across machines.
- `muster next` only returns ready manifest tasks (M:src/cli.js:843-848).
- No resume verb exists. `/muster:resume` is a Stage 2 TODO (revival doc:85).
- 10+ `STATE-archive-*.md` files accumulate.

**gsd.**
- `.planning/STATE.md` has schema-generated frontmatter (G:gsd-core/templates/state.md:13-26).
- Progress is **derived from disk**: "Recalculates progress bar from SUMMARY.md counts on disk" (G:agents/gsd-executor.md:812).
- `next` routes purely on artifact presence: no CONTEXT → discuss; CONTEXT, no PLAN → plan; PLAN without SUMMARY → execute; all SUMMARY → verify; paused → resume (G:gsd-core/workflows/next.md:234-270).
- resume detects interrupted bootstrap and interrupted agents (resume-project.md:35-41).
- The robustness comes from a 7,919-line `src/state.cts`: locks, TOCTOU fixes, pid-liveness steal (:453-600). This is runtime, not adoptable.
- PROJECT/ROADMAP/REQUIREMENTS/milestones is a full PM layer.

**Verdict: MERGE, plus native.**
- From gsd: the *derive-don't-narrate* principle and `next.md`'s routing table, ported as a ~150-line `muster next --run <id>` that reads artifact presence.
- From gsd: `continue-here.md` (78 lines) as the pause handoff format.
- Commit run artifacts on the work branch.
- Native: Workflow `resumeFromRunId` for mid-build interruption, `/goal` for in-session persistence, and background sessions for long runs.
- Not adopted: state.cts locking (single-writer by construction: only the main thread writes run STATE), PROJECT/ROADMAP/REQUIREMENTS/milestones (muster's unit is a run plus a backlog), the statusline, and the context-monitor hooks.

## 7. Backlog and capture

**muster.**
- capture (M:plugin/commands/capture.md, 7 KB): conversation-to-backlog with a traced quote per item, extract/validate/dedupe and an AskUserQuestion approval.
- plan-backlog (16 KB) and go-backlog (33.8 KB): `sprint-waves` dependency waves, claim/receipt coordination, the broker.

**gsd.**
- capture: one item at a time, routed to todo/note/backlog/seed (G:commands/gsd/capture.md).
- add-backlog: ROADMAP 999.x numbering via `gsd_run phase.next-decimal`.
- review-backlog: promote/remove.
- quick and quick-batch: ad-hoc tasks with planner+executor and optional `--validate` (plan-check max 2 plus verify).
- workstreams.

**Verdict: KEEP muster capture** (it is stronger: multi-item extraction, traceability, dedupe, approval gate). **REPLACE go-backlog's broker machinery with native Workflow** (`backlog.js`: `pipeline(items, plan, build, review)` with per-item worktrees and ordered integration in the main thread). Adopt gsd's `quick --validate` semantics as muster's fast path: a small task still gets plan-check (max 2) and verification. Drop coordination and the claim protocol unless multi-runner use is confirmed (evidence of current use: not determined). Weight: go-backlog goes from 33.8 KB to a ≤6 KB command plus a script.

## 8. Context-rot defenses

**muster.** Return contracts ≤2000 chars and "no accumulation between waves" (orchestrator SKILL.md:121-133). STATE as the record. The orchestrator is over the re-attach budget, so its rules are lost after compaction (revival doc:61-62).

**gsd.**
- Context-budget rules: never read agent defs, never inline large files, frontmatter-only reads under 500k windows, degradation tiers (G:gsd-core/references/context-budget.md:13-39).
- `context_guard_mode` is explicitly heuristic: "no programmatic context-percentage API exists" (execute-phase-context-guard.md).
- context-monitor is always-on PostToolUse/Stop/PreCompact hooks (rejected).
- Fresh-context subagents per plan.

**Verdict: REPLACE with native + adopt gsd's rules as text.** Workflow returns are the only thing entering main context. Each phase is a separate Workflow call with an on-disk handoff, and `muster next` re-derives position after compaction. That removes the need for a heuristic guard. Put 6 lines of gsd context-budget.md rules (1, 2, 4 plus the read-depth table) into the orchestrator skill's first 5k tokens.

## 9. Target architecture

### Commands (user-invocable; listed every session, so one-line descriptions)

| Command | Body budget | Role |
|---|---|---|
| `/muster:plan` | ≤8 KB | preflight CLI → interview (if unclear) → `plan.js` → show PLAN + checker verdict → AskUserQuestion approve |
| `/muster:go` | ≤8 KB | plan (if no approved plan) → `build.js` → present merge + human_needed list; backlog scope delegates to `backlog.js` |
| `/muster:next` | ≤3 KB | `muster next --run` → route (resume build via `resumeFromRunId`, re-plan, verify, done) |
| `/muster:capture` | ≤7 KB (as is) | unchanged |

`plan-backlog` and `go-backlog` fold into plan/go via scope detection (already present in go.md:36-37). `runner` moves to cloud scheduled tasks (revival doc:87). diagnose/audit/design/init are outside lifecycle scope and not assessed here.

### Skills (model-invoked, `user-invocable: false`)

| Skill | Budget | Contents |
|---|---|---|
| `orchestrator` | ≤18 KB chars (~4.5k tok) | must-hold rules: dispatch never inline, advancement only on recorded PASS, human stops between workflows, context-budget rules, prose fallback when Workflow is unavailable |
| `interview` | ≤6 KB | muster AskUserQuestion UI + gsd gray-area → D-NN + prohibition-probe recall question |

Delete as skills: router, domain-router (keep for non-software pipelines only), review-gate (becomes `build.js` plus reviewer briefs), tournament (becomes a `build.js` mode), coordination, and the sp-plan, sp-subagents and gsd-* builtins.

### Agents (descriptions one line each)

| Agent | Source | Budget | Adaptation |
|---|---|---|---|
| `planner` | gsd-planner | ≤20 KB | heavy: drop gsd_run, .planning, research/patterns/UI/MVP branches; keep tracer-first, reversibility, precondition, must_haves, D-NN fidelity, scope-reduction prohibition |
| `plan-checker` | gsd-plan-checker + muster spec-gate probe | ≤20 KB | heavy: keep Dims 1–7b, 8f, 10, verify-command sanity, issue schema; consume `muster plan-lint` JSON instead of `gsd_run check` |
| `executor` | gsd-executor + muster-builder | ≤18 KB | heavy: drop state.* gsd_run calls (orchestrator owns state), keep deviation rules, commit protocol, destructive-git ban, SUMMARY + self-check, worktree-branch-check |
| `verifier` | gsd-verifier + honest-verifier + evidence-gate | ≤20 KB | heavy: keep goal-backward steps 2–9, abstain, convergence gate |
| `reviewer` | gsd-code-reviewer + muster-reviewer verdict line | ≤16 KB | medium: keep stance, depth, pre-scans, CR/WR/IN mapped to blocker/risk/nit |
| `strategist`, `investigator` | muster | as is | unchanged |

### Workflow scripts (`plugin/workflows/`)

- `plan.js` (~250 lines): planner → lint agent (`muster plan-lint`) → checker → loop (cap 3, issue-count stall, REVISION_CONFLICT) → `{plan_path, verdict, issues}`.
- `build.js` (~400 lines): per wave, `pipeline(tasks, executor[worktree], reviewer(s), fix-loop)`; tally fail-closed; verifier once at end; consistency cross-checks over schema returns.
- `backlog.js` (~200 lines): `pipeline(items, workflow('plan'), workflow('build'))`. Nesting is one level only, so this works only while `plan.js` and `build.js` never call `workflow()` themselves. Whether `workflow()` can resolve a plugin-shipped script by name from inside a stage, and whether per-item concurrency fits the shared cap, is not determined. Fallback: inline the scripts.

### CLI kept and added

- Add: `preflight` (scope + fast-path + detect + role→model in one call), `plan-lint` (ported gsd gates), `next --run`.
- Keep: tally, gate-cadence diff scaling, citation-check, backlog-receipts, capture's validate/dedupe.

### State files surviving

- `.muster/backlog.md` (committed).
- `.muster/runs/<id>/` **committed on the work branch**: `CONTEXT.md` (D-NN decisions), `PLAN.md` (gsd task format, frontmatter waves), `SUMMARY-<task>.md`, `VERIFICATION.md`, `STATE.md` (derived, ≤40 lines), `continue-here.md` on pause.
- Gone: manifest.json, capabilities.json, gate-cadence.json, verdicts.json (moved into the journal), wave-active, STATE-archive-*.
- `run-active` and `forbidden-actions` stay for the action fence.

### Main-session round trips for `/muster:go`, attended, N tasks

| Step | Round trips |
|---|---|
| preflight | 1 |
| interview | 0–k |
| `plan.js` | 1 |
| approve | 1 |
| `build.js` | 1 |
| merge stop | 1 |
| **Total** | **~5 + k** |

Today: ~14 + 2N before the first builder.

## 10. Sync model

The root cause of the old drift was overwriting. `muster vendor` regenerates over local adaptations (revival doc:19). Its own drift test is broken (`toAgent` uses `claudeProfileForAgentId`, while test/agents.generated.test.js uses `modelForRoles`; revival doc:93). Hand ports kept no base. Proposal:

1. **Pin:** `vendor/manifest.yaml` gsd source gets `ref: 9385f46` and `tag: v1.20.1`. Each item records `from` (upstream path), `to` (muster path), `mode: adapted|verbatim|watch`, `base_blob` (upstream git blob SHA at pin) and `mechanisms: [#3172, #2517, ...]` (gsd issue ids the item carries).
2. **Base copies:** `vendor/upstream/gsd/<from>` holds byte-exact upstream at pin. They are never edited; they are the merge base.
3. **Update is a 3-way merge, never a regen:** `muster vendor update gsd --to <tag>` runs `git merge-file <to> <base> <new>` per adapted item, writes conflicts with markers, and refreshes base and `base_blob` only after a clean or resolved merge. `verbatim` items may still regenerate. The overwrite path is deleted for `adapted`.
4. **Machine report:** `vendor/reports/gsd-<tag>.md` lists, per item, the upstream commit list and diff `pin..tag -- <from>`, plus every commit whose message cites one of the item's `mechanisms` ids. `watch` items (execute-phase.md, plan-phase.md, verify-work.md, code-review.md, revision-loop changes in spines) appear in the report only. They are never merged and are read for mechanism changes.
5. **CI (network):** a weekly cron job takes `gh api repos/open-gsd/gsd-core/releases/latest`. If the tag is newer than the pin, it builds `compare/<pin>...<tag>` files ∩ tracked paths. Non-empty means it opens an issue with the report and fails a non-blocking check.
6. **Doctor (offline):** verifies each `base_blob` matches the file under vendor/upstream, that every adapted file exists, and reports "N releases behind" from the cached last CI report. No network by default (doctor tests use `noNetworkExec`).
7. **SLO:** adopted items at most one minor release behind. Expected triage load is small: references change 0–2 times per 3 months, agents 10–24 times (fact 7). Spines are not merged.

## 11. Top risks

1. **Workflow has never run live in muster** (fact 3), and scripts cannot run git or CLI (fact 1). Every deterministic gate needs an agent hop, which is a cost and a trust boundary. Mitigation: a live smoke test of `build.js` on a 2-task wave before deleting the prose path. Keep the prose fallback in the orchestrator skill for Desktop until Workflow availability in Claude Desktop is confirmed (**not determined**).
2. **Heavy adaptation can destroy measured behaviour.** The honest-verifier's 100%→17% figure depends on exact protocol text. Cutting 48 KB to ≤20 KB must keep load-bearing sections verbatim. Mitigation: mark protected regions in the base diff, plus a prompt-eval regression set.
3. **Porting the gsd deterministic gates (~1.3k TS lines) to JS** is real work. Skipping it means the checker hand-reasons them, which gsd explicitly forbids (failing-direction.md:32).
4. **Worktree races and cwd drift under Workflow isolation** (gsd #48, `.git/config.lock`): whether these occur under Workflow isolation is not determined. Base-SHA asserts in the executor plus a concurrency cap.
5. **Per-spawn token cost rises** (agents at 16–20 KB vs 1.6–4 KB today) even as main-session round trips fall from ~14+2N to ~5. Model round trips per run fall; subagent tokens rise.
6. **Losing breadth:** wsh specialists reachable only via `agent_hint`. Planner hint quality is unmeasured.
7. **One-level workflow nesting** constrains `backlog.js`: `plan.js` and `build.js` must never nest. Name resolution of plugin-shipped workflows is not determined. Fallback: inline the scripts.
