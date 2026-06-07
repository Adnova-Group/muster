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

Inspiration (credited, not forked): atomic-claude (lifecycle discipline), gsd-core (cross-runtime
install + parallel waves), superpowers (brainstorm/plan/review skills + cross-CLI sync pattern),
book-genesis (non-code phased pipeline + adversarial quality gates). Design DNA from ForceVue
(Adnova Group): outcome alignment, Glass-Box traceability, compounding memory.

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

**Non-goals (deferred to later slices)**
- Parallel fan-out, tournaments, adversarial review gate (slice 2).
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

Language: Node (aligns with the gsd-style npm distribution path and the user's runtime). Each
subcommand is a pure-ish function over the filesystem + harness state, emitting JSON.

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
/muster "<outcome>"
 → muster detect          → ProjectProfile
 → muster capabilities    → AvailableCapabilities  (catalog ∩ installed, + fallbacks, + dynamic)
 → router skill           → CREW MANIFEST  [glass box]
 → (sequential lifecycle execution — or emit annotated plan)
 → muster memory write    → RUN RECORD
```

## 7. ProjectProfile (output of `detect`)

Deterministic, derived only from files + git. Example fields:

- `languages` / `frameworks` (from manifests, lockfiles, config files)
- `shape`: e.g. `frontend` | `backend` | `fullstack` | `mobile` | `library` | `monorepo`
- `package_manager`, `test_runner` (detected, not assumed)
- `vcs`: branch, dirty/clean, remote present
- `signals`: notable markers found (e.g. react-native, expo, next, prisma) — descriptive, not
  prescriptive

No model involvement. Unknowns are reported as `unknown`, never guessed.

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

## 11. Memory (compounding) — interface + local default

- Abstract interface: `read(query) -> RunRecord[]`, `write(RunRecord)`. RunRecord = manifest +
  decisions + outcome status + lineage refs + timestamp.
- v1 default backend: local files under `.muster/memory/` (JSON + a human-readable index).
- Future backends (deferred): the user's brain MCP servers; ForceVue. The interface is designed so
  these are drop-in adapters.
- Each run reads relevant prior records (same repo/outcome lineage) and threads them into the router
  as context, then writes its own.

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

## 14. Open questions (to resolve in the spec or with the user)

1. CLI distribution for v1: `npx muster …` vs a plugin-bundled binary vs both. (Leaning npx, gsd-style.)
2. `ProjectProfile.shape` taxonomy — exact enum + how monorepo composition is represented.
3. Crew Manifest: is it shown inline in the session, written to `.muster/`, or both? (Leaning both.)
4. Memory record granularity and the local index format.
5. Exact lifecycle stages enumerated in v1 (sequential), given fan-out/review land in slice 2.
6. **License verification per bundled built-in (blocker).** Each repo we adapt built-in defaults
   from (gsd-core, superpowers, book-genesis, wshobson/agents, knowledge-work) must have its license
   confirmed compatible with Muster's chosen OSS license before its content is bundled, with
   attribution recorded in provenance + NOTICE. Which built-ins ship in v1 depends on this.
7. Muster's own OSS license choice (drives #6).

## 15. Future slices (so this slice's boundaries are legible)

- **Slice 2:** heterogeneous concurrent fan-out — per-task `single` vs `tournament`, executed in one
  wave (tournaments nested inside the parent wave), then a composed adversarial review gate, then
  next wave. Consumes the slice-1 plan annotations unchanged.
- **S4:** domain pipelines — PM/business/marketing/ops/book as registered phased pipelines the
  router can target; book-genesis-style adversarial scoring gates.
- **S5:** remote control — trigger / steer / monitor runs remotely (the Cowork gap).
- **S1:** additional CLI adapters (opencode/codex/gemini) over the same portable source.
- **ForceVue:** optional connector — push PM artifacts with lineage; ForceVue/brain as memory backend.

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
