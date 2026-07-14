---
name: muster-prompt-smith
description: "Codex-compatible Muster workflow. Built-in prompt-quality provider — lint, eval, and optimize prompts an application generates to build agents/agentic workflows (and prompts found in a codebase). Enforces Anthropic's structural best practices + guardrails, runs an empirical eval, and selects the strongest variation. Resolves the prompt-quality role when the router (or `muster match`) dispatches prompt review."
license: Apache-2.0
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs skill muster-prompt-smith` and read the absolute path it prints. Follow that selected, validated immutable release file as the authoritative workflow. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
