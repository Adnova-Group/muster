# Harness support

Muster keeps routing, scoring, manifests, waves, and gates in one deterministic Node CLI. The model-facing controls depend on the active harness. Native Claude Code, Codex, and Cowork lanes use that harness's account or subscription; Muster does not ask those lanes for a separate model API key. ChatGPT Work is a private/local, proof-gated exception that uses Secure MCP Tunnel and a separately billed OpenAI Platform API key.

Claude Code and Codex expose all seven modes, including Design and Init. Cowork and ChatGPT
Work use narrower MCP surfaces whose verified boundaries are listed below.

## Support matrix

<div class="harness-table-wrap" tabindex="0" role="region" aria-label="Harness support comparison; scroll horizontally on narrow screens">

| Harness | Entry points | Parallel dispatch | Write isolation | Policy enforcement | Init handoff |
| --- | --- | --- | --- | --- | --- |
| Claude Code | Seven `/muster:*` modes, including Design | Workflow scripts (`muster:make-plan`, `muster:build`, `muster:backlog`); prose Agent fallback | Workflow agent worktrees, merged by `muster merge-wave` | Run-scoped action fence plus reviewer and merge-wave evidence checks | Native `/init`, canonical instruction pair |
| Codex | Seven `$muster-*` modes, including Design (frozen lane) | Production waves use process-only `codex-wave` / `codex exec -C` | Authenticated pristine registered worktrees | Advisory hooks plus review gates | Native `/init`, canonical instruction pair |
| Cowork | MCP instructions and tools | Probe phase 3 required; sequential path is verified | No proven per-subagent worktree primitive | Review gates; native plugin enforcement is unverified | No proven callable native adapter |
| ChatGPT Work (private/local; proof-gated) | Universal plugin + registered MCP connection | Pro-safe `muster_prioritize` only after native Scan Tools; full profile requires entitlement + double opt-in | Host-controlled; no Muster worktree claim | ChatGPT approvals/admin controls plus nonce-bound native proof gate | No callable Init adapter; no Codex-config inheritance |

</div>

On a narrow screen, focus the comparison and scroll sideways; the harness name stays pinned. Prefer a
harness guide below when you need the full contract without horizontal comparison.

The matrix separates verified behavior from declared capability. A file present on disk does not prove that a harness loaded it. The Codex installer can inspect its owned files; Cowork's native plugin lane remains opt-in through `MUSTER_COWORK_NATIVE_PLUGIN` because the local MCP server cannot probe the host's plugin loader.

For Claude Code and Codex Init, `AGENTS.md` is authoritative, and `CLAUDE.md` contains exactly:

```md
# Claude Code

@AGENTS.md
```

If conflicting instruction files existed at the preparation baseline, Init leaves a HUMAN-HOLD instead of overwriting or merging them.

For ChatGPT Work, the local/repo Plugins Directory source is documented for the desktop proof lane: restart or refresh ChatGPT Desktop, select the source, and install the plugin. Do not infer that the same local source is ingested by Work web; use web only with an independently supported source. Work remains separate from Codex configuration and inheritance. A configured connection or successful tool scan does not prove native invocation; the active host must produce the completed Muster card and matching nonce-bound server evidence.

Codex Desktop on native Windows is also distinct from both ChatGPT Work and a Codex installation inside WSL. Native Windows and WSL normally resolve different homes, Node runtimes, plugin caches, and `CODEX_HOME` directories. Install and diagnose Muster in the same host that launches Codex.

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
- [Cowork](/guides/cowork) covers the local MCP server, its 30-tool surface, and the verified degradation path.
- [ChatGPT Work](/guides/chatgpt-work) covers the private/local universal plugin, Secure MCP Tunnel, profile opt-ins, and the native proof contract.
- [Install](/guides/install) covers Claude Code.

Configuration shared by all lanes lives in [Configuration](/reference/configuration). Harness-specific settings are grouped there instead of being repeated as unofficial knobs.
