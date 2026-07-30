# Documentation

This index maps the maintained documentation and states which source wins when
two descriptions disagree.

## Authority and precedence

Use this order, from highest to lowest authority:

1. **Code, schemas, and executable prompts.** Runtime behavior and machine-checked
   contracts are authoritative.
2. **Website user contract.** The published user-facing behavior follows the
   executable sources and is the public compatibility promise.
3. **Architecture rationale.** Architecture documents explain why the current
   behavior exists; they do not override the executable or public contracts.
4. **Research and history.** Research notes, decisions, plans, and retired
   designs preserve evidence and context rather than current behavior.

When sources conflict, follow the higher item and correct the lower one. Root
agent instructions follow the same one-authority rule: `AGENTS.md` is
authoritative and `CLAUDE.md` only imports it.

## Architecture

- [Architecture](architecture.md): shared system structure and explicitly
  scoped harness bindings.
- [Binding interface](binding-interface.md): adapter primitives and runtime
  mappings.
- [Native workflow dispatch](native-workflow-dispatch.md): dispatch capability
  boundaries.

## Binding

- [Skill thinning](skill-thinning.md): prompt ownership and progressive
  disclosure.
- [Anti-patterns](anti-patterns.md): failure classes and their current guards.

## Operations

- [Configuration reference](https://adnova-group.github.io/muster/reference/configuration):
  supported environment variables and runtime controls.
- [Commands reference](https://adnova-group.github.io/muster/reference/commands):
  CLI and mode command details.
- [Security policy](../SECURITY.md): private reporting, support, and disclosure
  expectations.
- [QA runbook](qa/RUNBOOK.md): verification procedures.
- [Ship checklist](ship-checklist.md): release checks.
- [Performance pass](performance-pass.md): performance measurement.

## Research

Current investigations live under [`research/`](research/). They are evidence
inputs, not runtime contracts.

## Historical

Decision records, superseded plans, and prior design work live under
[`decisions/`](decisions/) and [`superpowers/`](superpowers/). Read them as
history unless a current executable source links to them as an active contract.
