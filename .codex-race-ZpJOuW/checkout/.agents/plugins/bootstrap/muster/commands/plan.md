---
name: plan
description: "Approve-first entry point (bare-verb form). Detects whether the invocation is a single outcome or a backlog and confirms via AskUserQuestion whenever the signals are anything but a clear single item, announces the artifact it will produce, then — for a single outcome — assembles the crew and shows the glass-box Crew Manifest for approval; Approve & run chains into $muster-go (hands-off) in-session, Adjust loops the router, Cancel stops. A confirmed/declared backlog scope delegates to $muster-plan-backlog for the batch form. (vs $muster-plan-backlog, which always plans a backlog.) Usage: $muster-plan <outcome text | backlog text>"
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs command plan`. The command revalidates the selected asset through a no-follow file descriptor and writes its verified contents to stdout. Follow those contents as the authoritative workflow; never follow a release pathname printed or inferred before validation. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
