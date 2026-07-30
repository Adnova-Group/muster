# Harness support

Muster keeps routing, scoring, manifests, waves, and gates in one deterministic Node CLI. The model-facing controls depend on the active harness. Model work uses that harness's account or subscription; Muster does not ask for a separate model API key.

## Support matrix

| Harness | Entry points | Parallel dispatch | Write isolation | Policy enforcement | Init handoff |
| --- | --- | --- | --- | --- | --- |
| Claude Code | Nine `/muster:*` commands | Native agents; optional Workflow fan-out | Native agent worktrees | Plugin hooks plus review gates | Native `/init`, expecting `CLAUDE.md` |
| Codex | Nine `$muster-*` skills | `spawn_agent` or isolated `codex exec` processes | Muster-created worktrees and receipts | Advisory hooks plus review gates | Native `/init`, expecting `AGENTS.md` |
| Kimi | Nine `/muster-*` skills | Native subprocess dispatch | Muster-created worktrees and receipts | Native permission rules plus review gates | Unavailable; explicit acknowledgement required |
| Cowork | MCP instructions and tools | Probe phase 3 required; sequential path is verified | No proven per-subagent worktree primitive | Review gates; native plugin enforcement is unverified | No proven callable native adapter |
| ChatGPT Work | Universal plugin + registered MCP connection | Pro-safe `muster_prioritize` only after native Scan Tools; full profile requires entitlement + double opt-in | Host-controlled; no Muster worktree claim | ChatGPT approvals/admin controls plus native proof gate | No Codex-config inheritance |

The matrix separates verified behavior from declared capability. A file present on disk does not prove that a harness loaded it. Codex and Kimi installers can inspect their owned files; Cowork's native plugin lane remains opt-in through `MUSTER_COWORK_NATIVE_PLUGIN` because the local MCP server cannot probe the host's plugin loader.

For ChatGPT Work, the local/repo Plugins Directory source is documented for the desktop proof lane: restart or refresh ChatGPT Desktop, select the source, and install the plugin. Do not infer that the same local source is ingested by Work web; use web only with an independently supported source. Work remains separate from Codex configuration and inheritance.

## ChatGPT Desktop surface detection

ChatGPT Desktop is a host shell, while Codex Desktop and ChatGPT Work (also
called GPT Work) are selected experiences with different capabilities. A
deterministic process cannot inspect the app's current mode, so Muster requires
an explicit declaration and fails closed:

- `muster desktop-harness chatgpt-desktop` reports that an experience must be
  selected. It exposes no capability lane and no native init command.
- `muster desktop-harness codex-desktop` selects `capabilities --codex`.
  `muster init` uses a HUMAN-HOLD for Codex's native `/init`, expecting
  `AGENTS.md`; the invocation alone is not completion evidence.
- `muster desktop-harness gpt-work` selects `capabilities --work`, whose
  dispatch floor is registered MCP tools or inline execution. Work has no
  proven native instruction initializer and does not inherit Codex `/init` or
  `AGENTS.md`, so `muster init` records an unavailable HUMAN-HOLD with no
  expected artifact until the user explicitly acknowledges it.

## Choose a guide

- [Codex](/guides/codex) covers scoped profiles, hooks, trust, and receipts.
- [Kimi](/guides/kimi) covers native agents, skills, permission rules, and model lanes.
- [Cowork](/guides/cowork) covers the local MCP server, its 28-tool surface, and the verified degradation path.
- [ChatGPT Work](/guides/chatgpt-work) covers the private/local universal plugin, Secure MCP Tunnel, profile opt-ins, and the native proof contract.
- [Install](/guides/install) covers Claude Code.

Configuration shared by all lanes lives in [Configuration](/reference/configuration). Harness-specific settings are grouped there instead of being repeated as unofficial knobs.
