# Executor-provided skills pilot

Status: local contract and fixture only. Production activation is off.

## Decision

Muster recognizes one neutral executor-skills contract for a future active-host
adapter:

- `capabilityRoot` is the filesystem-resolved Agent Plugin package root.
- `skills.list` returns bounded direct-child skills from
  `<capabilityRoot>/skills/<id>/SKILL.md`. Skills selected by the dispatcher are
  marked `explicit`; the remaining valid direct children are marked
  `discoverable`.
- `skills.read` accepts a listed skill id and a path relative to that skill
  directory. It may read `SKILL.md`, `references/`, `scripts/`, or `assets/`
  resources, but the canonical target must stay inside both the skill and
  capability roots.
- Discovery is capped at 128 skills and resource reads at 256 KiB by default.
  Invalid ids, traversal, symlink escapes, non-regular files, and oversized
  resources fail closed.

`src/executor-skills.js` implements a bounded local fixture for this contract.
The fixture always reports `productionActive: false`; it is proof of package
layout and read semantics, not proof that a product host exposed an executor.

## Host bindings

Codex Desktop already exposes its native skill registry through the Codex
app-server's `skills/list` method and explicit `skill` turn input. That is
evidence for a future adapter, but a configured plugin, an app-server response
obtained outside the active turn, or files in `CODEX_HOME` do not prove the
active Desktop executor delegated `skills.list` and `skills.read`.

ChatGPT Work has a plugin and registered-MCP lane, but it does not inherit the
Codex configuration plane. A successful tool scan or Muster MCP card therefore
does not prove executor-provided skill authority.

Production code may activate this pilot only from an authority receipt emitted
by the same active host, for the exact capability root, contract version, and
method pair. No current CLI, MCP adapter, installer, or capability resolver
constructs that receipt. Static configuration and ambient environment variables
are deliberately insufficient.

## Evidence

- OpenAI Codex app-server: `skills/list`, explicit `skill` input, and additional
  standalone skill roots:
  https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- OpenAI Agents SDK sandbox `Skills`: skills are mounted into a Codex
  auto-discovery root and lazy sources materialize package resources:
  https://openai.github.io/openai-agents-python/ref/sandbox/capabilities/skills/
- Agent Plugins 1.0: direct-child `skills/` discovery and canonical package-root
  containment:
  https://agent-plugins.org/specification
