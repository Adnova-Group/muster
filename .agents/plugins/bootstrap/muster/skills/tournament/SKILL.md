---
name: tournament
description: "Codex-compatible Muster workflow. Run a competing-solutions tournament for one high-uncertainty task -- N approach agents, a judge scoring each against the run's success criteria and producing a fusion map, then deterministic fusion via `muster fuse` (synthesized result) or winner-take-all fallback when candidates agree."
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs skill tournament` and read the absolute path it prints. Follow that selected, validated immutable release file as the authoritative workflow. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
