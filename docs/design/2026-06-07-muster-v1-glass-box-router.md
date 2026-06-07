# Muster v1 — Glass-Box Router (slice 1)

- Status: draft for review
- Date: 2026-06-07
- Slice: 1 of the router-first sequence (software domain, Claude Code)

## 1. What Muster is

Muster is a portable, multi-runtime, multi-domain agentic **orchestrator**. Its novel core is a
**router** that, given a stated *outcome*, detects the work context, discovers what specialist
capabilities are available in the user's environment, assembles the right crew with **visible
rationale**, runs an outcome-anchored lifecycle, and persists a traceable run record.

Muster owns the **spine** (router, lifecycle, fan-out, memory interface, portable distribution) and
**composes the leaves** — it discovers and dispatches whatever skills/plugins/MCP servers the user
already has, and never reimplements a specialist capability that exists. When an external provider is
absent, it falls back to a bundled best-of-breed built-in, and only works inline as a last resort.

Inspiration (credited, not forked): atomic-claude (lifecycle discipline — agent-roster archetypes,
scratchpad working-memory, spec-as-current-truth, checkpoint/verify gates), gsd-core (cross-runtime
install + parallel waves), superpowers (brainstorm/plan/review skills + cross-CLI sync pattern),
book-genesis (non-code phased pipeline + adversarial quality gates). Design DNA from ForceVue
(Adnova Group): outcome alignment, Glass-Box traceability, compounding memory. Memory follows
Karpathy's LLM Wiki pattern (tool-agnostic markdown knowledge base, no MCP/vector DB required).

### Full-system decomposition (context only — most is out of scope for this slice)

| # | Subsystem | Status |
|---|---|---|
| S1 | Foundation / portable distribution | future |
| **S2** | **Capability + domain router** | **this slice = the keystone** |
| S3 | Lifecycle orchestration + parallel fan-out + adversarial review | slice 2 |
| S4 | Domain pipelines (PM / business / book / marketing / ops — first-class) | future |
| S5 | Remote control (the Claude Cowork gap) | future |

Audience: OSS day-one. Primary user is a product/business operator (PM, fractional CPO, founder),
so business/PM outcomes are first-class peers to software. **Software is this slice's proving ground
because it is the cheapest domain to validate routing, not because Muster is a dev tool.**

## 2. Slice 1 goals / non-goals

**Goals**
1. Deterministically detect project context → `ProjectProfile`.
2. Deterministically discover available capabilities by intersecting a curated catalog with the
   user's actual runtime installation → `AvailableCapabilities` (+ dynamic fallback for unknowns).
3. Assemble a **Crew Manifest** with per-role choice, rationale, evidence, and fallback — the Glass
   Box.
4. Anchor every run to a stated outcome + explicit success criteria.
5. Persist a **Run Record** to a pluggable memory backend (local default).
6. Run the lifecycle **sequentially** for now (or simply emit the annotated plan) — enough to prove
   the router end to end.

Slice 1 targets **existing projects** and runs **interactive** only — see Non-goals.

**Non-goals (deferred to later slices)**
- Parallel fan-out, tournaments, adversarial review gate (slice 2).
- Autopilot run mode (§16) — deferred; it has nothing real to drive until the slice-2 execution
  layer exists.
- Greenfield bootstrap (§16) — empty-dir → brainstorm → plan → project-setup. Designed (§16) as
  roadmap; not built in slice 1. Slice 1 assumes an existing project/repo.
- Domains other than software (S4).
- Runtime adapters other than Claude Code — but source stays portable (S1).
- ForceVue connector — the *DNA* is mandatory here; the *integration* is not (S4/S5).
- Remote control (S5).
- Memory backends beyond the local default (brain/ForceVue adapters later).

## 3. Design principles (load-bearing)

- **Outcome-anchored.** No run without a stated outcome + success criteria. The router refuses to
  proceed on "go do stuff."
- **Glass Box.** Every routing decision is visible and recorded: which provider, *why*, on what
  evidence, and what it fell back from. The router is never a black box.
- **Compounding memory.** Each run reads prior run records and writes a new one, so context builds
  over time. Interface is abstract; default backend is local.
- **Compose, never assume.** The catalog is provider *knowledge*, not a dependency list and not a
  snapshot of any user's install. Muster assumes **no** optional provider is present and runs fully
  on bare Claude Code.
- **Best-of-breed built-ins, not naive inline.** Where it makes sense, Muster ships its own bundled
  best-of-breed capability for a role — adapted and **credited** from the ecosystem repos
  (superpowers, gsd-core, book-genesis, wshobson/agents, knowledge-work, atomic patterns). The
  normal fallback for a missing installed provider is a real **built-in default**, not a naive inline
  attempt. We bundle as many built-in defaults as sensibly maintainable.
- **Recommend, don't require.** When a role would be served better by a specialized external
  provider the user lacks, Muster emits a **non-blocking recommendation** to install it, while
  proceeding with the best available tier. Advisory, never a hard dependency.
- **Resolution ladder:** `installed provider → Muster built-in default → inline` (true last resort),
  with a **recommendation overlay** that fires when the chosen tier sits below the best-known
  provider for that role.
- **Code for the deterministic, model for the judgment.** Detection, catalog intersection, and
  memory I/O are deterministic code (the `muster` CLI). Crew assembly judgment is a model skill that
  consumes deterministic inputs. Dynamic introspection of uncatalogued skills is the explicitly
  named model-safeguard exception.

## 4. Architecture — two layers

### A. `muster` CLI (deterministic engine, owned "code" layer)

Language: Node. **Distributed as an npm package** (gsd-core style): the Claude Code plugin and every
future CLI adapter shell out to the same `npx muster …` binary, so the CLI is the portable core and
adapters stay thin. Each subcommand is a pure-ish function over the filesystem + harness state,
emitting JSON.

- `muster detect` → inspects the repo and emits `ProjectProfile`.
- `muster capabilities` → emits `AvailableCapabilities` (catalog ∩ installed + fallbacks + dynamic).
- `muster memory <read|write>` → run-record persistence via the memory interface.
- `muster manifest validate` → schema-validates a Crew Manifest produced by the router skill.

The CLI never makes routing *judgments*; it supplies deterministic *inputs* and validates *outputs*.

### B. Muster skills / commands (model-facing spine)

- `/muster <outcome>` — the entrypoint command; orchestrates the slice-1 sequence.
- **router skill** — consumes `ProjectProfile` + `AvailableCapabilities` + the outcome → emits the
  **Crew Manifest**.
- Minimal owned fallback behaviors used only when a role has no installed provider.

Authoring note (portability): logic that is model-facing lives in markdown skills/commands; logic
that is deterministic lives in the CLI. The Claude Code plugin is a thin adapter wiring the two. A
future opencode/codex/gemini adapter reuses the same CLI + markdown, so portability is additive, not
a rewrite. We do **not** build other adapters now (YAGNI) — we only avoid locking them out.

## 5. The catalog (`catalog/*.yaml`)

Ecosystem-wide, community-extendable **provider knowledge** keyed by role. Two kinds of entry:

1. **External providers** — a known third-party/installed capability: which role(s) it fills, how to
   **detect** it (plugin id / skill name / MCP server name), how to **invoke** it, a preference
   `rank`, and whether it is `recommended` (Muster should suggest installing it when absent).
2. **Built-in defaults** — a capability Muster itself ships for a role, with `provenance` (which
   ecosystem repo it was adapted from + license) so attribution is enforced.

**No external provider is assumed present.** Resolution per role: highest-ranked **installed**
external provider → Muster **built-in default** → **inline** (true last resort, only where no
built-in exists).

Catalog entry shapes (illustrative):

```yaml
# external provider
- id: serena
  kind: external
  detect: { kind: mcp_server, match: "serena" }
  roles: [code-navigation]
  invoke: "dispatch serena symbol tools"
  rank: 90
  recommended: true            # suggest installing when no equal-or-better provider is present
  notes: "LSP-grade navigation"

# built-in default Muster ships
- id: muster-planner
  kind: builtin
  roles: [plan]
  provenance: { adapted_from: "superpowers writing-plans", license: "TBD-verify" }
  rank: 50
```

Roles for the software domain in v1, with **examples** of external providers the catalog *may*
recognize (all optional, detected at runtime) and the built-in/inline fallback:

| Role | Example optional external providers → fallback |
|---|---|
| code-navigation | LSP/symbol MCP servers (e.g. serena) → ast-grep/grep (built-in) |
| docs-research | docs MCP servers (e.g. context7) → WebFetch (built-in) |
| brainstorm / plan | planning skills (e.g. superpowers) → Muster built-in planner |
| implement | installed builders → Muster built-in builder |
| code-review | review plugins (e.g. pr-review-toolkit) → Muster built-in reviewer |
| security-review | security plugins (e.g. security-guidance, wshobson) → Muster built-in / recommend |
| test-author | TDD skills (e.g. superpowers TDD) → Muster built-in TDD |
| refactor / simplify | simplifier plugins → Muster built-in / inline |
| frontend | frontend design plugins → recommend / inline |
| tech-debt analysis | analysis agents (e.g. wshobson) → recommend / inline |

The external provider names above are **examples of what the catalog can recognize, not
requirements**. A user on bare Claude Code with zero plugins gets a fully functional Muster running
on built-in defaults, with recommendations surfaced where a specialist provider would do better.

**Dynamic fallback.** For skills/plugins/MCP servers that are installed but **not** in the catalog,
`muster capabilities` lists them with their self-described metadata; the router skill may match them
to roles by description (the model-safeguard path). Such picks are flagged `source: dynamic` in the
manifest so their rationale is auditable.

### Built-in defaults & provenance

Built-in defaults are how Muster is good out of the box. They are adapted from the ecosystem repos
and **must** carry provenance + a verified-compatible license before bundling (see Open Questions).
v1 ships a small starter set (e.g. a built-in planner and built-in reviewer); the set grows per
slice. Each built-in declares `provenance: { adapted_from, license }`, surfaced in the manifest and
in NOTICE/attribution files. Bundling adapted content under an incompatible license is a blocker, not
a nicety.

**Bakeable vs recommendable — the rule for which tier a capability belongs to:**

- **Bakeable → built-in default.** Capabilities that are essentially prompt/skill/agent *content*:
  GSD loop discipline, superpowers planning/TDD/review skills, wshobson specialist agents. Muster
  adapts and ships these, so a user with nothing installed still gets specialist-grade behavior.
- **Recommendable → external provider.** Capabilities that need a runtime or live service Muster
  cannot bundle: an LSP server (serena), a live docs index (context7). The built-in fallback (grep,
  WebFetch) is genuinely weaker, so Muster recommends the external provider when it is absent and
  would help — without depending on it.

## 6. Data flow (one slice-1 run)

```
/muster "<outcome>"               (slice 1: existing project, interactive)
 → muster detect          → ProjectProfile
     ├─ greenfield? ──────→ bootstrap: brainstorm → plan → project setup → re-detect   (§16, LATER SLICE)
     └─ existing project ─┐
 → muster capabilities    → AvailableCapabilities  (catalog ∩ installed, + fallbacks, + dynamic)
 → router skill           → CREW MANIFEST  [glass box]
 → (sequential lifecycle execution — or emit annotated plan)
 → muster memory write    → RUN RECORD
```

Run modes (interactive / autopilot) and the greenfield bootstrap branch are detailed in §16.

## 7. ProjectProfile (output of `detect`)

Deterministic, derived only from files + git. Example fields:

- `languages` / `frameworks` (from manifests, lockfiles, config files)
- `shape`: e.g. `frontend` | `backend` | `fullstack` | `mobile` | `library` | `monorepo`
- `package_manager`, `test_runner` (detected, not assumed)
- `vcs`: branch, dirty/clean, remote present
- `greenfield`: true when no project/repo exists (empty dir, no VCS, no manifest) — triggers the
  bootstrap branch (§16)
- `signals`: notable markers found (e.g. react-native, expo, next, prisma) — descriptive, not
  prescriptive

No model involvement. Unknowns are reported as `unknown`, never guessed. The profile is Muster's
**signals** layer (atomic-signals-inferrer analog): deterministic repo-shape awareness without
hallucination, persisted under `.muster/` and refreshed when the repo changes.

## 8. AvailableCapabilities (output of `capabilities`)

For each role: the chosen provider (highest available tier — installed external match → built-in),
the ordered fallback chain, and a `source` of `installed` | `builtin` | `dynamic` | `inline`
(`installed` = catalog-matched installed provider; `dynamic` = installed but matched via
introspection). Also a raw list of all installed skills/plugins/MCP servers for the dynamic path and
for the manifest's audit trail.

Detection reads (Claude Code adapter): `~/.claude/plugins/installed_plugins.json`, the available
skills listing, and MCP server configuration. If any source is unreadable, that source degrades to
empty + a logged warning; routing still proceeds (toward `builtin`, then `inline`).

## 9. Crew Manifest (the Glass Box) — output of the router skill

Human-readable (markdown) **and** machine-readable (JSON), schema-validated by
`muster manifest validate`. Contents:

- **Outcome** + **success criteria** (explicit, testable).
- **Crew**: per lifecycle stage → chosen provider, `source` (`installed` | `builtin` | `dynamic` |
  `inline`), one-line **rationale**, the **evidence** it rests on (which `ProjectProfile`/capability
  facts), and the **fallback** that would apply if the provider were absent.
- **Recommendations**: non-blocking suggestions to install a better external provider, fired when the
  chosen tier sits below the best-known provider for a role (e.g. "install serena for symbol-accurate
  navigation — better than the grep built-in").
- **Degradations**: any role that fell to a lower tier, and from what.
- **Plan**: the outcome decomposed into tasks, each tagged with a future execution mode
  (`single` | `tournament`) so slice 2 can consume it unchanged.

Example (abridged):

```
Outcome: Add rate-limiting to the public API.
Success criteria: 429 past N req/min/key; unit + integration tests green; no hot-path perf regression.
Crew:
  navigate   → grep (builtin)             (no LSP server installed)
  research   → context7 (installed)       (external lib docs needed; evidence: express in deps)
  plan       → muster-planner (builtin)   (adapted from superpowers; no planning plugin installed)
  implement  → muster-builder (builtin)
Recommendations:
  - install an LSP server (e.g. serena) for symbol-accurate navigation — better than the grep built-in
Plan:
  - middleware skeleton            [single]
  - token-bucket store             [tournament]   (uncertain: in-mem vs redis tradeoff)
  - tests                          [single]
```

## 10. Outcome-anchoring

`/muster` requires an outcome argument. If success criteria are not derivable, the router elicits
them (via an installed brainstorming skill if present, else inline) **before** producing a manifest.
No manifest, no run. This is both ForceVue DNA and the user's own goal-driven principle.

## 11. Memory (compounding) — interface + LLM-Wiki default

Abstract, pluggable interface: `read(query) -> Entry[]`, `write(Entry)`. Entries include Run Records
(manifest + decisions + outcome status + lineage refs + timestamp) and distilled knowledge
(conventions, decisions, gotchas).

**Default backend: an LLM-Wiki-style markdown store** (Karpathy's LLM Wiki pattern) — **zero
infrastructure, no MCP, no vector DB**. A folder under `.muster/memory/` of human-readable,
interlinked markdown files with a central `INDEX.md` table-of-contents: the router reads the index
first to orient, then pulls only the relevant topic files. **The agent that uses the wiki maintains
it** — adding entries, merging duplicates, pruning stale content — so memory compounds as Muster
works. It is git-committable and reviewable, which directly serves the Glass-Box principle. This is
the same shape as the BRIEF/STATE/FOLLOWUPS run records and the manifests — they become wiki entries.

**Tool-agnostic — independent of Obsidian (or any app).** Karpathy pairs the wiki with Obsidian as a
viewer; Muster does not. The store is plain markdown readable in any editor or directly by the agent,
with **no dependency on Obsidian, its vault format, or its plugins**. Cross-links are plain relative
markdown links resolved by Muster itself (a `[[name]]` convention is allowed, but Muster resolves it
— it does not require an Obsidian backlink engine). Obsidian stays a fine *optional* viewer, never a
requirement.

**Optional backends (adapters, deferred):** MCP "brain" servers (e.g. openbrain / agent-brain) and
ForceVue, for users who run them. The default requires **none** of these — important for OSS, where
most users have no MCP memory configured (the brain pattern needs a server set up; the wiki does not).

Each run reads relevant prior entries (same repo/outcome lineage), threads them into the router as
context, then writes its own.

## 12. Graceful degradation & error handling

- Resolution ladder `installed → builtin → inline`; a missing external provider never hard-fails —
  it falls to the next tier, the manifest records the degradation, and a recommendation may fire.
  **Fail loud only for real failures, not for absent optional tools.**
- Unreadable harness state (plugins file, skills list) → that source degrades to empty + warning;
  routing proceeds.
- Invalid Crew Manifest (schema) → `muster manifest validate` rejects; router must repair before the
  run proceeds (no silent acceptance).
- Missing/unclear outcome → elicit, do not guess.

## 13. Testing strategy

- **Deterministic CLI (highest value):** unit tests for `detect`, `capabilities`, catalog
  intersection, and memory I/O against fixture project trees + fixture `installed_plugins.json` /
  skills listings. Pure functions, fully assertable.
- **Schema tests:** catalog schema; Crew Manifest schema.
- **Degradation matrix:** enumerate present/absent combinations for key roles; assert no hard
  failure and the correct fallback + recorded degradation. Tests encode *intent* ("no LSP server ⇒
  grep in manifest, degradation logged").
- **Router skill (model-facing):** scripted scenario fixtures asserting manifest/run-record *shape
  and routing choices given a capability set*, not LLM prose.

## 14. Open questions

**Resolved**
- **CLI distribution:** npm package; the Claude Code plugin + future adapters shell out to
  `npx muster …`. (decided 2026-06-07)
- **Source licenses verified (2026-06-07):** superpowers, gsd-core, book-genesis, wshobson/agents =
  **MIT**; knowledge-work-plugins = **Apache-2.0**. All permissive — every planned built-in is
  bundleable with attribution; none must be demoted to recommend-only on license grounds.

**Still open**
1. **Muster's OSS license** — pending user. Apache-2.0 recommended: cleanly absorbs the MIT sources
   (with attribution) and the one Apache-2.0 source, and its NOTICE file is the natural attribution
   surface. MIT is the lighter alternative.
2. `ProjectProfile.shape` taxonomy — exact enum + how monorepo composition is represented.
3. Crew Manifest: shown inline in the session, written to `.muster/`, or both? (Leaning both.)
4. Memory: wiki entry granularity, `INDEX.md` format, and `[[name]]` link-resolution rules
   (Muster-resolved, Obsidian-independent).
5. Exact lifecycle stages enumerated in v1 (sequential), given fan-out/review land in slice 2.
6. Per-built-in attribution mechanics: provenance fields → `NOTICE`/attribution file generation
   (now unblocked — all sources permissive).

## 15. Future slices (so this slice's boundaries are legible)

- **Slice 2:** heterogeneous concurrent fan-out — per-task `single` vs `tournament`, executed in one
  wave (tournaments nested inside the parent wave), then a composed adversarial review gate, then
  next wave. Consumes the slice-1 plan annotations unchanged.
- **S4:** domain pipelines — PM/business/marketing/ops/book as registered phased pipelines the
  router can target; book-genesis-style adversarial scoring gates.
- **S5:** remote control — trigger / steer / monitor runs remotely (the Cowork gap).
- **S1:** additional CLI adapters (opencode/codex/gemini) over the same portable source.
- **ForceVue:** optional connector — push PM artifacts with lineage; ForceVue/brain as memory backend.

## 16. Run modes & atomic orchestration heritage

Muster's orchestration spine adapts proven patterns from atomic-claude. This section records what is
adopted and how it maps onto Muster, with slice-1 scope flagged.

### Run modes

- **Interactive (default).** `/muster <outcome>` runs detect → route → manifest → (sequential
  lifecycle), pausing for human approval at gates. **This is the only slice-1 mode.**
- **Autopilot (deferred — slice 2+).** `muster autopilot <outcome|issue>` runs the whole lifecycle
  hands-off — plan → execute → ship — with one human decision (how to merge), mirroring atomic's
  `/autopilot`. Deferred because it has nothing real to drive until the slice-2 execution layer
  exists. The router keeps the plan/manifest currency-clean (spec-as-current-truth) so fanned-out
  agents can't be diverted once autopilot lands.

### Greenfield vs existing — bootstrap when no project exists (deferred — later slice)

Slice 1 assumes an existing project. The greenfield branch below is designed here as roadmap; it is
not built in slice 1. `detect` first answers: does a project/repo exist here?

- **Existing project** → normal flow (detect shape → route crew → execute).
- **Greenfield** (empty dir / no repo / no manifest) → **bootstrap branch** before routing:
  1. Define the project with the brainstorm/plan roles — prefer an installed superpowers
     brainstorming/writing-plans provider; else the Muster built-in planner. **No code before a
     design + plan exist** (same gate as superpowers/atomic).
  2. Project setup (atomic-setup analog): `git init`, docs/ layout, `.gitignore`, initial structure,
     a CLAUDE.md/AGENTS.md seed — only what is missing, never overwrite.
  3. Re-run detect on the now-existing project and continue into the normal flow.

This is why "use superpowers if a project/repo does not exist yet" is first-class: greenfield routes
to brainstorm → plan → setup, not straight to implementation.

### Signals (repo-shape awareness)

`detect`/ProjectProfile is Muster's signals layer — the atomic-signals-inferrer analog: deterministic
repo-shape awareness without hallucination, persisted under `.muster/` and threaded into the router +
compounding memory, refreshed when the repo changes.

### Agent-roster archetypes → roles + built-in defaults

Atomic's tight agent roster maps onto Muster roles; the built-in defaults for these roles are adapted
(with credit) from atomic's agent definitions:

| Atomic agent | Muster role | Notes |
|---|---|---|
| investigator (ro locator) | code-navigation / investigate | file:line locator; built-in below serena |
| builder (cohesion-bounded, TDD) | implement | feature-slice builder |
| surgeon (1–2 files) | implement (small scope) | router picks builder vs surgeon by task scope |
| strategist (ro heavyweight reasoning) | plan / analyze | "is this the right approach"; tournament judge (slice 2) |
| reviewer (PASS / CHANGES_REQUESTED) | code-review | re-runs quality signals; review gate (slice 2) |

### Working memory (scratchpad) → Run Record structure

Atomic's implement→review scratchpad becomes the shape of Muster's run working-memory + Run Record:

- **BRIEF** = the Crew Manifest (outcome + scope + crew + plan) — the fanned-out agents' single source.
- **STATE** = append-only checkpoint log of each step/decision (the glass-box trail at execution
  granularity; satisfies "checkpoint after every significant step").
- **FOLLOWUPS** = ledger of non-blocking findings deferred during a run, dispositioned at finalize.

These persist via the memory interface (local default in v1) and are what makes memory *compound*.

### Quality gates

Adopted as lifecycle invariants:
- **Spec-as-current-truth.** Muster-generated plans/specs keep the body as current truth + a change
  log for history, so fresh-context fanned-out agents are never misled.
- **Checkpoint discipline.** Every significant step appends to STATE.
- **Verify-before-claim.** No "done/passing" without a fresh verification run in the same step
  (atomic-verify / TDD analog). TDD-in-loop enforcement is slice 2; the invariant is set now.

## Change log

### 2026-06-07 — Initial draft
- **What changed:** First design for slice 1 (glass-box router). Captures decisions from the
  brainstorming session: name (Muster), OSS day-one, own-the-spine/compose-the-leaves posture,
  hybrid catalog model, outcome-anchored + glass-box + compounding-memory DNA (mandatory; ForceVue
  integration deferred), heterogeneous concurrent fan-out model (specified for slice 2), and the
  router-first slice-1 scope.
- **Resolution ladder + built-ins:** catalog distinguishes external providers from bundled built-in
  defaults; resolution is `installed → builtin → inline` with a non-blocking recommendation overlay.
  Bakeable capabilities (GSD/superpowers/wshobson skills+agents) ship as built-in defaults;
  capabilities needing a runtime/service (serena LSP, context7 docs) are recommended, not bundled.
  Built-ins carry provenance + verified license; license verification is a bundling blocker.
- **Why:** Establish the keystone subsystem before the rest of the platform plugs into it, and make
  Muster strong out-of-the-box without depending on any optional tool.

### 2026-06-07 — Atomic orchestration heritage (§16)
- **What changed:** Added run modes (interactive + autopilot), the greenfield-vs-existing branch
  (greenfield → superpowers/built-in brainstorm → plan → project setup before implementation),
  signals as the persisted detect layer, atomic agent-roster archetypes mapped to roles + built-in
  defaults, the scratchpad BRIEF/STATE/FOLLOWUPS structure as the Run Record shape, and the
  spec-as-current-truth / checkpoint / verify-before-claim quality gates. Added greenfield handling
  to slice-1 goals.
- **Why:** atomic's orchestration shell (autopilot, signals, project setup, greenfield bootstrap via
  superpowers) is half of Muster's heritage and was underweighted in the initial draft.

### 2026-06-07 — Memory default = LLM Wiki (Obsidian-independent)
- **What changed:** §11 default memory backend is now an LLM-Wiki-style **plain-markdown** store
  (Karpathy's LLM Wiki pattern): `INDEX.md` + interlinked topic files, agent-maintained, zero infra
  (no MCP, no vector DB). Explicitly **tool-agnostic and independent of Obsidian** — `[[name]]` links
  are resolved by Muster, not an Obsidian backlink engine. MCP brain servers and ForceVue demoted to
  optional adapters.
- **Why:** most OSS users have no MCP memory server; the wiki gives compounding memory with no setup,
  stays git-committable (serves Glass Box), and must not depend on any specific app.

### 2026-06-07 — Distribution, scope tightening, license verification
- **What changed:** (1) CLI distribution decided — npm package, adapters shell out to `npx muster`.
  (2) Slice 1 tightened to **existing projects, interactive only**: autopilot and greenfield
  bootstrap moved from slice-1 goals to deferred roadmap (§16 retained as design). (3) Source
  licenses verified — superpowers/gsd-core/book-genesis/wshobson = MIT, knowledge-work = Apache-2.0;
  all permissive, so all planned built-ins are bundleable with attribution. (4) Open Questions
  reorganized into resolved vs open; Muster's own license is the remaining call (Apache-2.0
  recommended).
- **Why:** lock the portable-core distribution model, keep slice 1 minimal to prove the glass-box
  router, and unblock the built-in bundling plan with verified-permissive sources.
