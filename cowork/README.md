# Muster on Claude Cowork

Muster's deterministic brain, packaged as a local MCP server for [Claude Cowork](https://support.claude.com/en/articles/14479288-claude-cowork-desktop-architecture-overview).

Cowork extends only through MCP and MCPB desktop extensions. It has no plugin, skill, slash-command, or hook primitives, so the Claude Code plugin does not load there. What ports cleanly is muster's deterministic core: project detection, capability and domain routing, gate scoring, RICE prioritization, and wave planning. That core is plain Node with no model calls, it runs in Cowork's Linux VM, and its verbs are exposed here as MCP tools.

## What you get

Sixteen tools, the routing and analysis half of muster:

| Tool | Does |
| --- | --- |
| `muster_detect` | Project profile (languages, frameworks, VCS, test runner) |
| `muster_capabilities` | Resolve every role to its best provider, fallback chain, and model tier |
| `muster_match` | Rank providers against a free-text task |
| `muster_domain` / `muster_route` | Classify an outcome and route it to a pipeline |
| `muster_pipeline` | Load a pipeline definition |
| `muster_assess` | Gap-check an outcome before running |
| `muster_steer` | Classify a mid-run steer message |
| `muster_diagnose` / `muster_audit` | Build the diagnose / whole-codebase audit manifest |
| `muster_manifest_validate` / `muster_wave` | Validate a crew manifest and compute its execution waves |
| `muster_score` / `muster_prioritize` | Score against a gate / rank a backlog |
| `muster_pick` / `muster_tally` | Tournament winner / review-gate decision |

muster's principles, routing policy, and a Cowork execution protocol (how to drive these tools, including the sequential fallback when the runtime cannot fan out) ride in the server's MCP `instructions`. That replaces the SessionStart and UserPromptSubmit hooks the Claude Code plugin uses.

## Install

Requires Node 20+ in the runtime.

As a local MCP server, point Cowork at:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/muster/cowork/mcp-server.mjs"]
}
```

As an MCPB desktop extension, `manifest.json` in this directory is the descriptor; `${__dirname}` resolves to the bundle root.

The server reads the muster checkout next to it (`../src/cli.js`), so keep `cowork/` inside the repo or bundle the whole package.

## Settle the dispatch question first

The deterministic half ports cleanly. The orchestration half (parallel waves, tournaments, the adversarial review gate) depends on one thing Cowork's docs do not disclose: can its agent loop fan out parallel subagents with a per-call model override? Run the probe inside Cowork to find out.

```bash
# phases 1 and 2 self-verify the CLI and the dispatch contract; emits a phase-3 spec
node scripts/cowork-probe.mjs

# Cowork executes cowork-dispatch-spec.json, writes results.json, then:
node scripts/cowork-probe.mjs --dispatch-results results.json
```

If phase 3 passes, the full orchestration half is buildable on Cowork. If it does not, muster runs as a router plus single-agent executor: the agent walks each wave sequentially per the execution protocol, and every routing, scoring, and gate decision is still deterministic.

## Tier notes

Fable degrades to opus by default (the tier can be disabled platform-wide). Set `MUSTER_ENABLE_FABLE=1` to opt back in once it returns. `MUSTER_MAX_TIER=opus|sonnet` caps dispatch for budget control.
