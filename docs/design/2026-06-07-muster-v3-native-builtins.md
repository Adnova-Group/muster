# Muster slice 3 — Native built-ins via a vendoring pipeline

- Status: draft for review
- Date: 2026-06-07
- Builds on: slice 1 (router/catalog) + slice 2 (fan-out/review)

## 1. What slice 3 adds

Slices 1–2 made the resolution ladder `installed → builtin → inline`, but the catalog's `builtin`
entries are **provenance stubs** — there is no shipped content behind them. Slice 3 makes the
`builtin` tier real via a re-runnable **vendoring pipeline**: a manifest declares what to import from
upstream sources, an importer adapts those items into in-repo built-in skills with generated
attribution, and the catalog's builtin entries are auto-generated from what was imported.

Decision recap: comprehensive *mechanism* (manifest-driven, re-runnable) + **curated-broad** initial
import (all ~14 superpowers skills + gsd loop + a curated slice of wshobson/agents that maps to
Muster's roles — NOT all 687 wshobson files). Sources verified reachable 2026-06-07.

## 2. Goals / non-goals

**Goals**
1. `vendor/manifest.yaml` — sources + per-item import mappings (`id`, `roles`, `from`, license).
2. `src/vendor.js` + `muster vendor` — deterministic transform (source item → built-in SKILL.md with
   provenance frontmatter + catalog entry) and `generateNotice`; plus the I/O fetch (local read / git).
3. Vendored output **committed**: `plugin/skills/builtins/<id>/SKILL.md`, `catalog/builtins.generated.yaml`,
   and an aggregated `NOTICE`.
4. Catalog wiring: `software.yaml` keeps only **external** providers; built-ins come from the
   generated file (auto-picked-up by the slice-1 `loadCatalog`).
5. Run the pipeline → commit the curated-broad import.
6. Idempotent re-runs (regenerating produces identical output).

**Non-goals (deferred)**
- Autopilot + greenfield run modes (slice 4 — they consume these built-ins).
- Importing all 687 wshobson files.
- Expanding Muster's 11-role taxonomy (curated items map to existing roles; specialist-pool expansion
  is a later consideration).
- Changing the slice-1 resolution-ladder logic (it already consumes whatever builtins exist).

## 3. Vendor manifest (`vendor/manifest.yaml`)

```yaml
sources:
  - id: superpowers
    kind: local                     # resolved under ~/.claude/plugins/cache/**/superpowers/*/skills
    license: MIT
    repo: obra/superpowers          # for attribution text
    items:
      - { from: brainstorming/SKILL.md,            id: sp-brainstorm,   roles: [brainstorm] }
      - { from: writing-plans/SKILL.md,            id: sp-plan,         roles: [plan] }
      - { from: test-driven-development/SKILL.md,  id: sp-tdd,          roles: [test-author] }
      - { from: requesting-code-review/SKILL.md,   id: sp-review,       roles: [code-review] }
      - { from: systematic-debugging/SKILL.md,     id: sp-debug,        roles: [implement] }
      # ... remaining superpowers skills
  - id: wshobson
    kind: github
    repo: wshobson/agents
    ref: main
    license: MIT
    items:                          # CURATED-BROAD (~20-40), authored by inspecting the repo tree
      - { from: <path>/security-auditor.md, id: wsh-security, roles: [security-review] }
      - { from: <path>/code-reviewer.md,    id: wsh-review,   roles: [code-review] }
      # ... curated specialists mapped to roles
  - id: gsd
    kind: github
    repo: open-gsd/gsd-core
    ref: main
    license: MIT
    items:
      - { from: <path>, id: gsd-loop, roles: [plan] }
```

`manifest.yaml` is the single curation surface. Adding more later = add items + re-run `muster vendor`.

## 4. Importer (`src/vendor.js`)

Two layers, mirroring the project's code/judgment split:

**Deterministic (unit-tested):**
- `toBuiltin(sourceText, item, source)` → `{ path, content, catalogEntry }`.
  - `path` = `plugin/skills/builtins/${item.id}/SKILL.md`.
  - `content` = the source markdown with a Muster provenance block merged into frontmatter:
    `muster_builtin: true`, `adapted_from: "<source.repo> <item.from>"`, `license: <source.license>`,
    and the original `name`/`description` preserved (or derived from `item.id` if absent).
  - `catalogEntry` = `{ id, kind: "builtin", roles: item.roles, rank: 50, provenance: { adapted_from, license } }`.
- `generateNotice(entries)` → NOTICE text: header + one attribution stanza per source repo+license.
- `validateManifest(doc)` → checks sources have `id`/`license`/`kind`, items have `from`/`id`/`roles`.

**I/O (not unit-tested; run at vendor time, output committed):**
- `muster vendor [--source <id>]`: for each source, fetch (local: read resolved cache dir; github:
  shallow `git clone --depth 1` to a temp dir), read each item's `from`, apply `toBuiltin`, write the
  built-in file, accumulate catalog entries + provenance.
- Write `catalog/builtins.generated.yaml` (all builtin entries) and regenerate `NOTICE`.
- Graceful: a source that fails to fetch is skipped with a stderr warning; the run continues with the
  rest (superpowers is local, so always succeeds). A missing item `from` warns + skips that item.

## 5. Catalog wiring

- `catalog/software.yaml`: remove the 6 stub `builtin` entries; keep the external providers.
- `catalog/builtins.generated.yaml`: produced by `muster vendor`; auto-loaded by slice-1 `loadCatalog`
  (it already globs `catalog/*.yaml`).
- `validateCatalog` (slice 1) already requires `provenance.license` on builtins — generated entries
  satisfy it. No validator change needed.
- Slice-1 capabilities tests use inline catalogs, so they are unaffected by removing the stubs.

## 6. Provenance & attribution

- Every built-in file carries `adapted_from` + `license` in frontmatter.
- `NOTICE` aggregates: for each source repo, its license + a line that Muster bundles adapted content
  from it. This is the Apache-2.0 NOTICE obligation made concrete (all sources MIT/Apache).

## 7. Glass Box / DNA fidelity

`muster capabilities` now resolves builtin-tier roles to **real shipped ids** (e.g. `code-review →
wsh-review (builtin)`), and the manifest surfaces *why* each built-in exists (its provenance). The
recommendation overlay still fires for recommendable externals (serena/context7) over the built-ins.

## 8. Testing strategy

- **`toBuiltin`** (TDD): fixture source markdown → assert provenance frontmatter present + correct,
  original body preserved, catalog entry shape correct.
- **`validateManifest`**: missing source license / item roles rejected.
- **`generateNotice`**: from a provenance list → contains each source repo + license.
- **Catalog integration:** with a sample `builtins.generated.yaml`, `loadCatalog` returns externals +
  builtins and validates.
- **Idempotency:** `toBuiltin` twice on the same input → identical output.
- **Not unit-tested (I/O):** the fetch + full vendor run; verified instead by the committed output and
  a `muster capabilities` check that a role resolves to a vendored builtin id.

## 9. Open questions
1. Exact wshobson curated list — enumerated in the manifest at build time by inspecting the repo tree
   (target the agents matching Muster's roles + a few high-value generalists, ~20-40).
2. Rank policy for vendored builtins (default 50; externals like serena still win when installed, and
   still get recommended when absent).
3. Whether unmapped specialists later warrant a `specialist` role / description-search path (deferred).

## Change log

### 2026-06-07 — Initial slice-3 draft
- **What changed:** First design for native built-ins via a manifest-driven vendoring pipeline.
  Decisions: comprehensive mechanism + curated-broad initial import (all superpowers skills + gsd +
  ~20-40 wshobson agents, not all 687); deterministic `toBuiltin`/`generateNotice`/`validateManifest`
  (tested) + I/O fetch (committed output); built-ins live in `plugin/skills/builtins/` with generated
  `catalog/builtins.generated.yaml` + aggregated `NOTICE`; `software.yaml` reduced to externals.
- **Why:** make the `builtin` resolution tier real so Muster is strong out-of-the-box and slice 4
  (autopilot/greenfield) has genuine capabilities to drive, without forking an 687-file marketplace.
