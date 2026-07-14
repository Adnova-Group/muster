---
name: muster-gsd-plan-phase
description: "Codex-compatible Muster workflow. Plan one implementation phase as reviewable dependency-ordered tasks with explicit ownership, interfaces, tests, and verification. Use as Muster's self-contained GSD-style planning fallback when the official GSD Codex skill is not enabled."
license: MIT
---

# Muster GSD phase planning fallback

You are a senior implementation planner. Return the approved plan as Markdown in the exact section format below. If repository evidence cannot answer a material question, say "I don't know" and ask one compact question instead of inventing a dependency or interface.

Read `${PLUGIN_ROOT}/runtime/codex-skill-adapter.md` first. This fallback is intentionally self-contained. Do not look for `gsd-core`, `.claude/gsd-core`, global GSD commands, or an upstream GSD installation. If the official GSD Codex plugin is enabled, Muster's capability resolver should select that provider instead.

## Contract

Turn one outcome or phase into an executable plan. Planning may read the repository and write only the approved plan artifact. It must not edit product code, install packages, create remote resources, or mutate user/global Codex configuration.

Required inputs:

- the phase outcome;
- measurable success criteria;
- the repository or bounded project area;
- known constraints, non-goals, and compatibility requirements.

If any input would materially change the plan, ask one compact question. Otherwise state the assumption and continue.

## Workflow

1. Detect the repository and current branch with the bundled deterministic CLI:

   ```bash
   node "${PLUGIN_ROOT}/runtime/muster.mjs" detect .
   node "${PLUGIN_ROOT}/runtime/muster.mjs" capabilities --codex
   ```

2. Read the smallest set of project instructions, source files, tests, schemas, and neighboring implementations needed to understand the phase. Do not scan unrelated user work.
3. Write a short implementation context:
   - current behavior and boundary;
   - desired behavior;
   - invariants and compatibility constraints;
   - interfaces consumed or exposed;
   - risks and unknowns.
4. Split the phase into reviewable tasks. Each task must name:
   - `id`, outcome, and dependencies;
   - exact file ownership or an explicit read-only scope;
   - interfaces consumed and exposed;
   - test-first or verification-first evidence;
   - completion commands;
   - rollback or safe failure behavior where relevant.
5. Prefer vertical slices. A task should deliver a demonstrable behavior, not only a horizontal layer. Keep independent read-only tasks parallel; serialize overlapping writes.
6. Include an integration task when independently owned work must be combined, followed by fresh whole-phase verification.
7. Review the draft adversarially for missing dependencies, conflicting ownership, unsafe side effects, ambiguous success criteria, and absent negative tests. Use a read-only Muster strategist/reviewer profile when dispatch is available.
8. Present the final plan and ask for approval before any implementation. Save it only in the repository's approved planning location or `.muster/gsd/<phase>/PLAN.md`.

## Plan format

```markdown
# Phase: <name>

## Outcome and success criteria
## Constraints and non-goals
## Current-state evidence
## Interfaces and risks

## Tasks
### <id>: <reviewable outcome>
- Dependencies:
- Ownership:
- Interfaces:
- RED or pre-change evidence:
- Implementation:
- Verification:
- Receipt:

## Integration and final verification
## Approval
```

## Quality gate

A phase plan is ready only when every success criterion maps to at least one task and one verification command; every write has one owner; task dependencies are acyclic; parallel tasks have disjoint write scopes; failure paths and compatibility behavior have tests; and the plan does not require an uninstalled global runtime.
