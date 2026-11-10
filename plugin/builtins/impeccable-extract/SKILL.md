---
name: impeccable-extract
description: "Impeccable's extract reference (vendored): Pull reusable tokens and components into the design system."
muster_builtin: true
license: Apache-2.0
upstream:
  - repo: pbakaus/impeccable
    ref: b856e5010f2dd86bd97f9b2d5e38e33f3d5bd992
    path: plugin/skills/impeccable/reference/extract.md
    license: Apache-2.0
    relation: adapted
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001, ANTH-POS-001, GUARD-IDK-001, GUARD-CITE-002: pinned upstream Impeccable playbook, loaded by a muster design-workflow packet that supplies the role, output format and evidence rules; the upstream text stays unedited so `muster vendor update` can 3-way merge it. -->

> **Muster adaptation.** Vendored from [pbakaus/impeccable](https://github.com/pbakaus/impeccable) `plugin/skills/impeccable/reference/extract.md` at `b856e5010f2dd86bd97f9b2d5e38e33f3d5bd992` (skill-v4.8.2), Apache-2.0, Copyright 2025 Paul Bakaus. The upstream text below is unchanged except that links to references muster vendors point at their `impeccable-*` builtins. In muster, run it through the design workflow (`muster design run <workflow>`; read `/impeccable <command>` as that). The DESIGN.md that `design run` resolves is the canonical context, and DESIGN.md is written only through muster's confirmed `design init --content-file` flow. Muster does not ship Impeccable's launcher binary, live browser or hooks: skip any step that runs them (`context`, `detect`, `critique-storage`, `live-server`, `concept-seed`, `surface-brief`, `build-phase`, `pin`, `hooks`, `doctor`) and continue as upstream's "launcher unavailable" path describes. Links to references muster does not vendor (init, new-work, live, generate, the native-platform references for iOS and Android, and the other engine references) name upstream files for context only.

# Extract Flow

Identify reusable patterns, components, and design tokens, then extract and consolidate them into the design system for systematic reuse.

## Step 1: Discover the Design System

Find the design system, component library, or shared UI directory. Understand its structure: component organization, naming conventions, design token structure, import/export conventions.

If no design system exists, do not create one yet. Ask with the AskUserQuestion tool and wait for the answer before continuing. Understand the preferred location and structure first.

## Step 2: Identify Patterns

Look for extraction opportunities in the target area:

- **Repeated components**: Similar UI patterns used 3+ times (buttons, cards, inputs)
- **Hard-coded values**: Colors, spacing, typography, shadows that should be tokens
- **Inconsistent variations**: Multiple implementations of the same concept
- **Composition patterns**: Layout or interaction patterns that repeat (form rows, toolbar groups, empty states)
- **Type styles**: Repeated font-size + weight + line-height combinations
- **Animation patterns**: Repeated easing, duration, or keyframe combinations

Assess value: only extract things used 3+ times with the same intent. Premature abstraction is worse than duplication.

## Step 3: Plan Extraction

Create a systematic plan:

- **Components to extract**: Which UI elements become reusable components?
- **Tokens to create**: Which hard-coded values become design tokens?
- **Variants to support**: What variations does each component need?
- **Naming conventions**: Component names, token names, prop names that match existing patterns
- **Migration path**: How to refactor existing uses to consume the new shared versions

Design systems grow incrementally. Extract what is clearly reusable now, not everything that might someday be reusable.

## Step 4: Extract & Enrich

Build improved, reusable versions:

- **Components**: Clear props API with sensible defaults, proper variants for different use cases, accessibility built in (ARIA, keyboard navigation, focus management), documentation and usage examples
- **Design tokens**: Clear naming (primitive vs semantic), proper hierarchy and organization, documentation of when to use each token
- **Patterns**: When to use this pattern, code examples, variations and combinations

## Step 5: Migrate

Replace existing uses with the new shared versions:

- **Find all instances**: Search for the patterns you extracted
- **Replace systematically**: Update each use to consume the shared version
- **Test thoroughly**: Ensure visual and functional parity
- **Delete dead code**: Remove the old implementations

## Step 6: Document

Update design system documentation:

- Add new components to the component library
- Document token usage and values
- Add examples and guidelines
- Update any Storybook or component catalog

**Avoid**:
- Extract one-off, context-specific implementations without generalization
- Create components so generic they are useless
- Extract without considering existing design system conventions
- Skip proper TypeScript types or prop documentation
- Create tokens for every single value (tokens should have semantic meaning)
- Extract things that differ in intent (two buttons that look similar but serve different purposes should stay separate)

