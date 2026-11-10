# Claude Desktop (Chat and Cowork)

Muster reaches Claude Desktop two ways. The primary route is the plugin, added from Customize > Plugins. The plugin-less fallback is a local MCP server: the Cowork adapter `cowork/mcp-server.mjs` over the neutral core `mcp/server.mjs` (`mcp/codex-server.mjs` and `mcp/chatgpt-work-server.mjs` are the other host adapters; the old `cowork/chatgpt-work-server.mjs` path remains a compatibility shim). Model work uses the active Claude account or subscription.

Since September 2026 Chat and Cowork are one experience in Desktop ("Unified Claude"). The Code tab is unchanged and runs Claude Code; see the [Claude Code quickstart](/guides/quickstart) for it.

## Install the plugin

1. Open **Customize > Plugins** in Claude Desktop or claude.ai.
2. Click **Add**, then **Add marketplace**, and enter `Adnova-Group/muster`.
3. Install **muster**.

The install belongs to your account, so it also reaches Claude Code as a synced plugin (Claude Code v2.1.273 or later). Run `muster doctor --desktop` to check what Desktop sees. It is read-only.

## Support matrix

| Capability | Code tab | Cowork | Chat |
| --- | --- | --- | --- |
| `/muster:*` skills | Yes | Yes | Yes |
| `/muster:*` commands | Yes | Yes | Loaded as skills |
| muster agents | Yes | Yes | Ignored |
| muster hooks | Yes | Yes (events not documented) | Ignored |
| Workflow tool (`muster:make-plan`, `muster:build`) | Yes | Not documented | Not documented |
| Parallel subagents | Yes | Documented | No |
| Per-call model override | Yes | Not documented; probe phase 3 | No |
| Local MCP fallback server | Yes | Local sessions only, not cloud | Yes |
| Plan mode | Plan mode and the Plan pane | No; AskUserQuestion approval | No |

**Desktop WSL sessions load no plugins**, so muster is absent from a Code-tab session that runs inside WSL. Use a local or SSH session, or the CLI inside WSL. `muster doctor --desktop` warns when it finds WSL sessions.

Software outcomes (branches, worktrees, merge, Workflow fan-out) belong in the Code tab. New Cowork tasks run in the cloud, where local MCP servers do not run and the sandbox toolchain is not documented, so Cowork suits non-code pipelines.

## The MCP-only fallback

The server exposes 30 tools in total: 29 CLI-wrapper tools plus `muster_sprint_protocol`. The protocol returns the Cowork-adapted backlog playbook. It is a protocol tool, not a CLI wrapper. When the plugin's `/muster:*` skills are present, the server's instructions tell the agent to use them and treat the tools as their deterministic backend.

Backlog writes use `muster_backlog_publish`, a compare-and-swap publication tool. Pass the complete next content plus the lowercase SHA-256 of the version you read (or `absent` for creation). A concurrent-writer mismatch fails closed; reread, reapply your change, and retry instead of overwriting another runner's update.

Dispatch evidence is split. Parallel subagents are documented in Cowork, so wave members may fan out without a probe, and sequential `muster_next` stays the default when no subagent tool is available. A per-call model override is not documented: the repository tests verify probe phases 1 and 2 only and contain no live phase-3 receipt. Run `node scripts/cowork-probe.mjs`, execute its phase-3 spec in the active Cowork build, and grade the results before relying on per-call model override.

Add a `muster` entry to Desktop's MCP configuration (`%APPDATA%\Claude\claude_desktop_config.json` on Windows, `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "muster": {
      "command": "node",
      "args": ["/absolute/path/to/muster/cowork/mcp-server.mjs"]
    }
  }
}
```

Use Node 20 or newer on the host path, then fully restart Claude. Connect or trust the project folder before asking Claude to read it. Verify by listing `muster_*` tools and calling `muster_detect` with the project directory.

## Backlog runs

Call `muster_sprint_protocol` before a Cowork backlog clear. It names backlog resolution, dependency waves, per-item lifecycle, and claim receipts. After each worker wake, use `muster_sprint_reconcile` to drain all receipts and dispatch every newly eligible action before waiting again. Without a proven native per-subagent worktree primitive, the orchestrator creates a dedicated isolated Git worktree for each write-capable wave item and executes those items sequentially in their assigned worktrees. The connected project is the coordination and ordered-integration surface, not the fallback implementation workspace. Prefer `pr` or `keep` dispositions over direct base-branch merges.

## Plugin detection

`muster_capabilities` decides whether muster's plugin is loaded: a declaration wins (`MUSTER_COWORK_NATIVE_PLUGIN=1` or `0`), then the account plugin list Desktop keeps on disk, then the plugin route as the default. With the plugin, muster's builtin skills and agents resolve as on Claude Code; plugin-less, roles resolve to MCP servers or inline.

See [Configuration](/reference/configuration) for connector declarations, the plugin declaration, concurrency, and queue limits.
