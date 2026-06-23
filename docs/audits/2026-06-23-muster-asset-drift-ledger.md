# Muster Asset Drift Ledger — drift vs source material + new GitHub inspiration

_2026-06-23 · base `main` · **single canonical ledger** (consolidates the earlier `upstream-drift-ledger` + `cleanroom-drift-addendum`, now removed)._

Covers **all ~38 muster-authored assets** + the vendored set. Two questions per asset: (1) has its declared source drifted? (2) what *additional* GitHub repos could improve it? All external repos below were fetched live by research agents; paper/benchmark-only items are flagged.

**Provenance correction (own it):** the first pass under-scoped to vendored files and wrongly dismissed atomic-claude. atomic-claude is a published methodology (`atomic.alonso.network`, Apache-2.0), not a vendored repo — it is the *concept* source for the 5 `muster-*` agents. The pipelines and the self-improvement gap surfaced only on the full sweep.

## Scope

| Group | n | Source posture |
|---|---|---|
| Vendored builtins (`sp-/wsh-/gsd-`) | 44 | textual copies of MIT upstreams |
| Clean-room agents (`muster-*`) | 5 | inspired by atomic-claude |
| Clean-room workflow skills (`plugin/skills`) | 9 | inspired by superpowers/gsd |
| Built-in skills (`plugin/builtins/muster-*`) | 5 | mixed external + self-authored |
| Document pipelines (`pipelines/`) | 19 | framework-cited, mostly no external repo |

---

## A. Vendored drift (textual)

| Source | Pin → HEAD | Verdict |
|---|---|---|
| `obra/superpowers` (local) | → `896224c` | **sp-subagents +132L / sp-plan +2 sections** — portable (see C) |
| `wshobson/agents` | `cf6059d` → `cc37bfd` (+5) | no vendored item changed — **skip** |
| `open-gsd/gsd-core` | `85cfa5d` → `c28cccb` (+462) | all 3 workflows changed but gsd-internal (RUNTIME_DIR/AI-SPEC/coverage gates) — **skip**, one adapt-later idea (coverage-aware verify) |

**Process fix:** superpowers is `kind: local` (no pin) → drift invisible to `muster vendor`. Pin it + switch to `kind: github`.

## B. Clean-room agents vs atomic-claude

atomic-claude (`atomic.alonso.network`, concept source) defines roles muster's 5 agents mostly cover:

| atomic-claude role | muster equivalent | Status |
|---|---|---|
| Implementer/Builder (isolates in `.worktrees/`) | `muster-builder` + `muster-surgeon` | partial — no worktree isolation (CR-3) |
| Reviewer ("never grades own homework", fix every finding) | `muster-reviewer` + `review-gate` | aligned (maker≠checker, loop-until-clean) |
| Strategist (read-only, dispatched when "stuck twice") | `muster-strategist` | partial — no auto-escalation (CR-2) |
| Improve-Agent (retrospective, self-sharpening) | — | **missing entirely (CR-1)** |
| (n/a) | `muster-investigator` | muster addition, no upstream |

Gaps:

- **CR-1 ADOPT (high/med)** — no **self-improvement/retrospective agent** (atomic's "Improve-Agent" self-sharpening loop). Muster has `memory/` but nothing mines run STATE/escalations to propose skill/rule edits. → add `muster-improver` (read-only, user-gated). **Biggest clean-room gap.**
- **CR-2 ADOPT (med/low)** — no **"stuck twice → dispatch strategist"** auto-escalation; orchestrator jumps fix-loop-cap straight to human. → add root-cause dispatch of `muster-strategist` before human escalation.
- **CR-3 ADAPT (med/med)** — parallel wave builders aren't **worktree-isolated** (atomic isolates each implementer in `.worktrees/`); concurrent same-wave tasks can collide. → per-task `isolation:"worktree"`.
- **CR-4 NOTE (low)** — atomic's "fix every finding, blocking or not, in-iteration" vs muster's loop-until-clean (likely defers non-blocking). Posture decision, not a defect.

## C. Clean-room workflow skills vs superpowers/gsd

- **#1 ADAPT (high/low)** — sp-subagents "explicit model per dispatch" rationale (*"omitted model inherits your session's model — often the most capable and most expensive"*). Validates muster's manifest model rule; adopt prose into `orchestrator`. 
- **#2 ADAPT (high/med)** — sp-subagents **Pre-Flight Plan Review**: scan plan for conflicts, batch to human as ONE question, before wave 1. Muster's orchestrator has no pre-flight conflict scan. → new pre-wave step.
- **#3 ADAPT (med/low)** — sp-plan **Task Right-Sizing + Global Constraints**: router decomposes tasks but gives no sizing/constraints guidance. → port into `router`.
- **#4 ADAPT (med/low)** — sp-subagents diff-file handoff + ⚠️-triage → tighten `review-gate`.

---

## D. Built-in skills (`plugin/builtins/muster-*`)

### muster-humanizer (declared: blader/humanizer + StealthHumanizer) — **thin (26L), biggest enrichment opportunity**
Declared-source drift: missing **two-pass self-audit loop**, **hard em-dash/en-dash/curly-quote verify step**, **cluster-over-isolated false-positive guard**, an explicit **"preserve these" list**, **~33 named tell categories** (copula avoidance, negative parallelism, false ranges, signposting, sycophancy…), **formatting tells**, and **per-author voice calibration**.

| repo | distinctive | portable idea |
|---|---|---|
| [conorbronsdon/avoid-ai-writing](https://github.com/conorbronsdon/avoid-ai-writing) | deterministic 0–100 score, 44 categories, CI-enforced | scored, CI-checked engine so humanizer is measurable + can't drift from its spec |
| (same, vocab model) | 109-entry **3-tier** vocab (always/clustered/density) | replace flat banned-word list with tiered/density-gated flagging |
| [jalaalrd/anti-ai-slop-writing](https://github.com/jalaalrd/anti-ai-slop-writing) | 16 banned openers, structural patterns, fabrication checks | add opener + structural + invented-stat detection |
| [aaaronmiller/humanize-writing](https://github.com/aaaronmiller/humanize-writing) | quantified thresholds, per-content-type sets | numeric acceptance targets + per-artifact tuning |
| [linexjlin/GPTs Humanizer Pro](https://github.com/linexjlin/GPTs/blob/main/prompts/Humanizer%20Pro.md) | style-mimicry + ask-on-ambiguity | voice calibration + "ask before rewriting" guard |

### muster-prompt-smith (declared: Anthropic + lintlang + promptfoo)
Drift: missing lintlang detectors **H3 schema-intent, H4 context-boundary, H5 implicit-instruction, H6 format-contract, H7 role-confusion**; missing promptfoo assertion families — **tool-call validity, agent-trajectory asserts, RAG grading, g-eval, similar/factuality/moderation, cost/latency budgets**.

| repo | portable idea |
|---|---|
| [gepa-ai/gepa](https://github.com/gepa-ai/gepa) | feed lint+eval failure reasons back as "actionable side info" into the optimize loop |
| [microsoft/PromptWizard](https://github.com/microsoft/PromptWizard) | co-optimize few-shot examples alongside the prompt |
| [microsoft/sammo](https://github.com/microsoft/sammo) | treat prompt as structured DAG → segment-targeted transforms |
| [stanfordnlp/dspy](https://github.com/stanfordnlp/dspy) | MIPRO-style instruction+demo search over the eval set |
| [zou-group/textgrad](https://github.com/zou-group/textgrad) | "textual gradient" per failing case (gate for cost) |

### muster-research (self-authored)
| repo | portable idea |
|---|---|
| [assafelovic/gpt-researcher](https://github.com/assafelovic/gpt-researcher) (~27k★) | cross-source corroboration count → fact vs assumption |
| [langchain-ai/open_deep_research](https://github.com/langchain-ai/open_deep_research) | per-subtopic compression + "is this adequately sourced?" reflection gate |
| [tarun7r/deep-research-agent](https://github.com/tarun7r/deep-research-agent) | quantified source-credibility score + threshold filter |
| [mbzuai-nlp/qraft](https://github.com/mbzuai-nlp/qraft) | adversarial editorial review of the evidence brief |
| LLM-Cite (paper, no repo) | entailment-check fetched citations against the claim |

### muster-author (self-authored; frameworks current)
| repo | portable idea |
|---|---|
| [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) (34.7k★) | shared positioning/ICP preflight all content reads |
| [boraoztunc/skills](https://github.com/boraoztunc/skills) | dedicated de-slop pass + named master-voice presets |
| [WynterJones/CoppieGPT](https://github.com/WynterJones/CoppieGPT) | multi-framework variant fan-out → muster tournament |
| [datacrystals/AIStoryWriter](https://github.com/datacrystals/AIStoryWriter) | outline-first + continuity check for long-form |

Framework currency: AIDA/PAS/BAB/QUEST + E-E-A-T still canonical; add **PASTOR** and **Schwartz awareness×sophistication** router.

### muster-scorer (self-authored)
| repo | portable idea |
|---|---|
| [promptfoo/promptfoo](https://github.com/promptfoo/promptfoo) | declarative `threshold` gate + structured pass/fail object for CI |
| [confident-ai/deepeval](https://github.com/confident-ai/deepeval) | G-Eval: cache explicit eval-steps per criterion |
| [microsoft/LLM-Rubric](https://github.com/microsoft/LLM-Rubric) | per-judge calibration offset table (cross-provider comparability) |
| [CSHaitao/Awesome-LLMs-as-Judges](https://github.com/CSHaitao/Awesome-LLMs-as-Judges) | judge-bias guardrail checklist (position/verbosity/range) |
| [llm-as-a-judge/Awesome-LLM-as-a-judge](https://github.com/llm-as-a-judge/Awesome-LLM-as-a-judge) | distribution-based scoring vs single greedy 0–3 |

---

## E. Document pipelines (19)

### Content/marketing (blog-post, newsletter, social-post, lead-magnet, case-study, launch-plan, competitive-battlecard)
**Drift:** blog-post/lead-magnet miss the real 2025–26 shift — **GEO / answer-first** (first ~200 words answer the query; FAQ/structured-data for AI-Overview citation) and **named-author accountability** in the updated E-E-A-T guidance. Other frameworks stable.

| repo | portable idea |
|---|---|
| [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) | shared positioning foundation + lift `ai-seo`/GEO as a phase |
| [kostja94/marketing-skills](https://github.com/kostja94/marketing-skills) | reusable `project-context` intake artifact across the cluster |
| [ericosiu/ai-marketing-skills](https://github.com/ericosiu/ai-marketing-skills) | real significance stats in the score/judge gate |
| [VoltAgent/awesome-agent-skills](https://github.com/VoltAgent/awesome-agent-skills) · [alirezarezvani/claude-skills](https://github.com/alirezarezvani/claude-skills) | coverage-gap checklists |

### Product/PM (prd, epic, user-story, roadmap, okrs, business-case)
**Drift:** methods stable (JTBD, Lawrence story-splitting 9-pattern set, INVEST, RICE, OKR). Minor: pin canonical **RICE scales** (Impact 3/2/1/0.5/0.25, Confidence 100/80/50) and the Humanizing-Work meta-pattern into phase descs.

| repo | portable idea |
|---|---|
| [deanpeters/Product-Manager-Skills](https://github.com/deanpeters/Product-Manager-Skills) (~5.3k★) | "Adaptive Decision Ladder" structured clarification in intake |
| [mohitagw15856/pm-claude-skills](https://github.com/mohitagw15856/pm-claude-skills) | eval-gated quality + per-phase canonical-source citations |
| [cdeust/ai-prd-generator](https://github.com/cdeust/ai-prd-generator) | confidence-threshold clarification + claim-by-claim verification |
| [Wirasm/PRPs-agentic-eng](https://github.com/Wirasm/PRPs-agentic-eng) | append implementation-context layer to PRD (feeds coding agents) |

### Engineering/ops (ai-implementation-spec, ai-test-plan, runbook, release-notes)
**Drift:** ADR → **MADR 4.0.0** (add Decision Drivers, Options w/ pros-cons, **status lifecycle** proposed→accepted→superseded). Test plan → **IEEE 829 withdrawn, use ISO/IEC/IEEE 29119-3**; add deliverables/environment/schedule/staffing sections. Runbook → add **triage decision-tree** + incident-comms phase (Google SRE). Release-notes → current (Keep a Changelog 1.1.0).

| repo | portable idea |
|---|---|
| [joelparkerhenderson/architecture-decision-record](https://github.com/joelparkerhenderson/architecture-decision-record) (16.2k★) | ADR `style:` selector by decision significance |
| [thomvaill/log4brains](https://github.com/thomvaill/log4brains) | required `status` state machine + `Superseded-by` chaining |
| [Scoutflo/Scoutflo-SRE-Playbooks](https://github.com/Scoutflo/Scoutflo-SRE-Playbooks) | events-first triage step; key runbooks off failure-signature |
| [orhun/git-cliff](https://github.com/orhun/git-cliff) · [googleapis/release-please](https://github.com/googleapis/release-please) | commit-parser→section taxonomy + semver release-type gate |

### Long-form (book, executive-summary) — **strongest pipeline drift**
**Drift:** `book.yaml` vs book-genesis-v4 + autonovel misses: **Premise Forge** (5 scored variants, 8.0 floor), **per-chapter scored loop** (≥8.5 advance thresholds), **separate evaluator agent** (7-dim + anti-AI + 4-reader sim), whole-manuscript **CVI gate**, and a **continuity-propagation ledger** (track edits as "propagation debts" in state). No dedicated continuity/coherence audit pass.

| repo | portable idea |
|---|---|
| [KazKozDev/NovelGenerator](https://github.com/KazKozDev/NovelGenerator) | per-character knowledge-state register |
| [datacrystals/AIStoryWriter](https://github.com/datacrystals/AIStoryWriter) | per-phase model routing (fits muster router) |
| [raestrada/storycraftr](https://github.com/raestrada/storycraftr) | persisted story-bible manifest + phase-scoped re-run commands |
| [gcamilo/management-consulting](https://github.com/gcamilo/management-consulting) | evidence labeling (Fact/Inference/Assumption) for executive-summary |
| [life-itself/issuetrees](https://github.com/life-itself/issuetrees) | issue-tree MECE decomposition before BLUF |
| ConStory-Bench (paper) | continuity-audit taxonomy (5 categories/19 subtypes) |

---

## Top adoptions across everything (impact × effort × fit)

1. **CR-1** new `muster-improver` self-sharpening agent — the standout capability gap.
2. **#2** orchestrator pre-flight plan-conflict review.
3. **muster-humanizer** enrichment (it's 26 lines; the cited repos make it real) + CI-scored detection.
4. **book.yaml** premise-forge + per-chapter scored loop + continuity ledger.
5. **muster-prompt-smith** lintlang H3–H7 + promptfoo trajectory/tool-call asserts (aligns with the planned prompt-eval capability).
6. **CR-2 / CR-3** stuck-escalation + per-task worktree isolation.
7. **blog-post GEO/answer-first** + **ADR→MADR status lifecycle** + **test-plan→29119-3** — concrete, low-effort doc-correctness fixes.

Each adoption is a separate implementation run; this audit ranks, it does not apply.
