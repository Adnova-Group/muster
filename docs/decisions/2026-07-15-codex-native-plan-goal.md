# Codex native Plan and Goal integration

Status: adopted, Codex-only generation adapter

## Decision

Generated Codex Superpowers planning workflows use `update_plan`, with one active step and Plan-mode-only structured input. Generated `go` and `go-backlog` commands carry a bounded Goal lifecycle, but create a durable goal only when the user explicitly requests goal tracking. Claude source workflows and runtime behavior remain unchanged.

## Prototype results

| Measure | Plan prototype | Goal prototype |
|---|---|---|
| Orchestration quality | One native checklist, exactly one active step | One lifecycle spans dependency waves and final verification |
| Isolation | Generated Codex skills only | Generated Codex commands only |
| Persistence | Plan state survives ordinary turns | Goal state survives turns until complete or repeated-blocker escalation |
| Compatibility | Source Superpowers workflow is unchanged | Source Claude `go`/`go-backlog` text is unchanged |
| Token cost | Replaces repeated prose checklists with one compact tool state | Adds one preflight and one check per completed wave; no implicit token budget |
| Failure recovery | Material state changes update the plan; blocked input remains explicit | `blocked` requires the same condition for three consecutive goal turns |

The regression contract checks three generated Plan surfaces (adapter plus two Superpowers skills), two Goal commands, the non-Goal planning command, and the absence of legacy `TodoWrite` in the adapted workflows. Existing Claude parity and mode suites remain the compatibility gate.

## Rejected alternative

Automatically creating a Goal for every `go` invocation was rejected because it would mutate durable user state without an explicit request and would make nested/backlog executions compete for one global goal.
