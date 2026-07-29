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

## Choose a guide

- [Codex](/guides/codex) covers scoped profiles, hooks, trust, and receipts.
- [Kimi](/guides/kimi) covers native agents, skills, permission rules, and model lanes.
- [Cowork](/guides/cowork) covers the local MCP server, its 28-tool surface, and the verified degradation path.
- [ChatGPT Work](/guides/chatgpt-work) covers the private/local universal plugin, Secure MCP Tunnel, profile opt-ins, and the native proof contract.
- [Install](/guides/install) covers Claude Code.

Configuration shared by all lanes lives in [Configuration](/reference/configuration). Harness-specific settings are grouped there instead of being repeated as unofficial knobs.
