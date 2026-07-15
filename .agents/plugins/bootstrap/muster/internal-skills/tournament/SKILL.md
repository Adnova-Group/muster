---
name: tournament
description: "Codex-compatible Muster workflow. Run a competing-solutions tournament for one high-uncertainty task -- N approach agents, a judge scoring each against the run's success criteria and producing a fusion map, then deterministic fusion via `muster fuse` (synthesized result) or winner-take-all fallback when candidates agree."
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs internal-skill tournament`. The command revalidates the selected asset through a no-follow file descriptor and writes its verified contents to stdout. Follow those contents as the authoritative workflow; never follow a release pathname printed or inferred before validation. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
