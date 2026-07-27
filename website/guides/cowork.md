# Cowork

Muster runs in Claude Cowork through a local MCP server. The server wraps the deterministic CLI and supplies execution instructions to the active Cowork agent. Model work uses the active Cowork account or subscription.

## Support matrix

| Capability | Cowork support |
| --- | --- |
| Routing, manifests, waves, and gates | Native MCP tools |
| Tool inventory | 27 CLI-wrapper tools plus `muster_sprint_protocol` |
| Parallel subagents | Confirmed, with per-call model override |
| Sequential execution | `muster_next` fallback |
| Per-agent worktree isolation | No proven native primitive |
| Hooks and action fence | MCP-only lane has none |
| Native Muster plugin | Unverified; declared through `MUSTER_COWORK_NATIVE_PLUGIN` |
| Remote connectors | Declared through `MUSTER_COWORK_CONNECTORS` |

The server exposes 28 tools in total: 27 wrappers around CLI operations, plus `muster_sprint_protocol`. The protocol returns the Cowork-adapted backlog playbook. It is a protocol tool, not a CLI wrapper.

## Configure the local server

Add a `muster` entry to Cowork's MCP configuration and point it at the checkout's `cowork/mcp-server.mjs`:

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

Use Node 20 or newer on the host path, then fully restart Cowork. Connect or trust the project folder before asking Cowork to read it. Verify by listing `muster_*` tools and calling `muster_detect` with the project directory.

## Backlog runs

Call `muster_sprint_protocol` before a Cowork backlog clear. It names backlog resolution, dependency waves, per-item lifecycle, and claim receipts. Without a proven per-subagent worktree primitive, write-capable wave items must run sequentially in the connected project. Prefer `pr` or `keep` dispositions over direct base-branch merges.

Cowork's native plugin loader may eventually carry Muster's skills, hooks, and agents. That path is not auto-detected. Leave `MUSTER_COWORK_NATIVE_PLUGIN` unset unless a live Cowork session has loaded the plugin and exposed those capabilities.

See [Configuration](/reference/configuration) for connector declarations, native-plugin declaration, concurrency, and queue limits.
