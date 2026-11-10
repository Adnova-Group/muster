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

## Binding

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

## Research

Current investigations live under [`research/`](research/). They are evidence
inputs, not runtime contracts.

Claude Code, current as of 2026-11-10:

- [Claude Code CLI](research/claude-code-cli.md): harness internals; §13 covers
  the changelog through 2.1.322.
- [Claude Code Desktop and web](research/claude-code-desktop.md): §12 covers the
  Code tab through Desktop v4.23118.1 (bundled 2.1.321).
- [Live probes, 2026-11](research/claude-code-live-probes-2026-11.md): frontmatter
  hooks and plugin Workflow scripts on 2.1.319.
- [2026-11 Claude Code findings](research/2026-11-claude-code-findings.md): what
  muster's current design should adopt, fix or stop doing.

## Strategy

- [2026-11 revival review](strategy/2026-11-revival-review.md): owner decisions
  and the staged revival plan.
- [Stage 2 contracts](strategy/stage-2-contracts.md): the Workflow-based core's
  agents, scripts, run directory and CLI steps.

## Historical

Decision records, superseded plans, and prior design work live under
[`decisions/`](decisions/) and [`superpowers/`](superpowers/). Read them as
history unless a current executable source links to them as an active contract.

The pre-revival lifecycle design notes are history too, superseded by revival
stage 2b: [native workflow dispatch](native-workflow-dispatch.md),
[skill thinning](skill-thinning.md), [performance pass](performance-pass.md),
[speed tuning](speed-tuning.md), [weight reduction](weight-reduction.md) and
[fast-path token gap](fast-path-token-gap.md).
