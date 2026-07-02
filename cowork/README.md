# Muster on Claude Cowork

Muster's deterministic brain, packaged as a local MCP server for [Claude Cowork](https://support.claude.com/en/articles/14479288-claude-cowork-desktop-architecture-overview).

Cowork extends only through MCP and MCPB desktop extensions. It has no plugin, skill, slash-command, or hook primitives, so the Claude Code plugin does not load there. What ports is muster's deterministic core: project detection, capability and domain routing, gate scoring, RICE prioritization, and wave planning. That core is plain Node with no model calls. Cowork runs the local MCP server natively on the device (the agent loop), and its verbs are exposed here as MCP tools.

Dispatch is confirmed working: Cowork can fan out parallel subagents with a per-call model override, so the full orchestration lifecycle (autopilot, audit, diagnose) runs here, not just the router.

## What you get

Nineteen tools, plus an execution protocol that teaches the agent how to drive them:

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
| `muster_next` | Single-agent driver: next runnable task given the ids completed so far |
| `muster_score` / `muster_prioritize` | Score against a gate / rank a backlog |
| `muster_pick` / `muster_tally` | Tournament winner / review-gate decision |
| `muster_fuse` | Fusion decision engine -- apply the agreement gate, select top-K for synthesis (mode fuse) or fall back to single best (mode fallback). Deterministic, no LLM. |
| `muster_advise` | Validate an advice-request and resolve the advisor model (fable->opus). Deterministic, no LLM. |

muster's principles, routing policy, and a per-mode execution protocol (the core loop plus the autopilot/audit/diagnose/run lifecycles) ride in the server's MCP `instructions`. That replaces the SessionStart and UserPromptSubmit hooks the Claude Code plugin uses.

## Prerequisites

- **Node 20 or newer, on the host PATH.** Cowork runs the server with the host's Node, not a Node inside WSL or a container. Check in a host terminal (PowerShell on Windows, Terminal on macOS): `node -v`.
- **A muster checkout on disk.** The server resolves the CLI at `../src/cli.js` relative to itself, so the `cowork/` directory must stay inside the repo (or the whole package must be bundled). Clone or copy the repo somewhere stable, for example `C:\Users\you\dev\muster` or `~/dev/muster`.

## Install (Route A): local MCP server

This is the fastest route and needs no packaging. You add one entry to Claude's MCP config file.

### 1. Find the config file

| OS | Path |
| --- | --- |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Linux (community builds) | `~/.config/Claude/claude_desktop_config.json` |

Create the file if it does not exist. On Windows MSIX (Microsoft Store) installs there can also be a virtualized copy under `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\`. The app reads `%APPDATA%` unless that LocalCache copy exists, so edit `%APPDATA%` first and only fall back to the LocalCache path if your changes do not take effect.

### 2. Add the muster server

Merge this into `mcpServers` (keep any servers you already have). Use the absolute path to your checkout, with doubled backslashes on Windows:

```json
{
  "mcpServers": {
    "muster": {
      "command": "node",
      "args": ["C:\\Users\\you\\dev\\muster\\cowork\\mcp-server.mjs"],
      "env": {
        "MUSTER_COWORK_CONNECTORS": "",
        "MUSTER_ENABLE_FABLE": "",
        "MUSTER_MAX_TIER": ""
      }
    }
  }
}
```

macOS/Linux use a normal path, for example `"/Users/you/dev/muster/cowork/mcp-server.mjs"`. The `env` block is optional; see Configuration below.

### 3. Restart Cowork fully

Quit from the system tray or menu bar, not just the window. The config is read only on a real launch.

### 4. Verify

In Cowork, prompt:

> List your `muster_*` tools, then call `muster_detect` on `&lt;path to a project&gt;`.

You should see all nineteen tools and a project profile (language, package manager, VCS, and so on). If nothing appears, see Troubleshooting.

## Install (Route B): MCPB desktop extension

For a packaged, one-click install instead of hand-edited config. `manifest.json` in this directory is the MCPB descriptor (`manifest_version` 0.3).

```bash
npx @anthropic-ai/mcpb validate cowork
npx @anthropic-ai/mcpb pack cowork muster.mcpb
# optional: npx @anthropic-ai/mcpb sign muster.mcpb
```

Then in Cowork: Settings → Extensions → install `muster.mcpb`. The extension's `user_config` (Fable toggle, max tier, declared connectors) appears as fields in the extension's settings and is passed to the server as environment variables.

Caveat: on Windows MSIX installs, the extension's `${__dirname}` is virtualized, and the server spawns the muster CLI as a child process from that path. If the tools work via Route A but the packed extension cannot start, that is the virtualized-spawn issue; use Route A, or file it so the server can be switched to importing the CLI in-process. The probe (below) flags this.

## Configuration

All configuration is environment variables, set either in the Route A `env` block or via the Route B `user_config` fields.

| Variable | user_config field | Effect |
| --- | --- | --- |
| `MUSTER_ENABLE_FABLE` | `enable_fable` | `1`/`true` routes peak-judgment roles to Fable. Empty or `false` degrades Fable to Opus (the default, since the tier can be disabled platform-wide). |
| `MUSTER_MAX_TIER` | `max_tier` | `opus` or `sonnet` caps the dispatch tier for budget control. Empty means no cap. |
| `MUSTER_COWORK_CONNECTORS` | `connectors` | Comma-separated remote-connector names to treat as available (see below). |

### How capabilities resolve

`muster_capabilities` runs with `--cowork`, resolving providers from Cowork's MCP registry rather than `~/.claude`:

- **Local MCP servers** are read from `claude_desktop_config.json` (`mcpServers` keys). On Windows the MSIX-virtualized path is tried before `%APPDATA%\Claude`.
- **MCPB extensions** are discovered by enumerating the `Claude Extensions/` directory and reading each `manifest.json` (there is no index file).
- **Remote connectors** (Slack, Drive, GitHub, and so on) live in your cloud account, not on disk, so they cannot be auto-discovered. Declare the ones you want muster to treat as available via `MUSTER_COWORK_CONNECTORS=slack,drive`. The output marks `connectorsDiscoverable: false` so the gap stays visible.

### Operating on a repo

The MCP tools run regardless, but for Cowork to actually read and edit a project, add that project's folder as a connected/trusted folder in Cowork. Point `muster_detect` and the rest at its path.

## Verifying dispatch on a new runtime

Dispatch is already confirmed on Cowork. To re-check it on a different runtime or build, use the probe:

```bash
# phases 1 and 2 self-verify the CLI and the dispatch contract; emits a phase-3 spec
node scripts/cowork-probe.mjs

# the runtime executes cowork-dispatch-spec.json, writes results.json, then:
node scripts/cowork-probe.mjs --dispatch-results results.json
```

Phase 3 passing means parallel fan-out plus per-call model override work, so the full orchestration lifecycle is available. If it fails, muster still runs as a router plus single-agent executor: the agent walks each wave one task at a time via `muster_next`, and every routing, scoring, and gate decision stays deterministic.

## Troubleshooting

- **No `muster_*` tools after restart.** Usually Node is not on the host PATH (Route A `command: node` cannot resolve), the path in `args` is wrong, or Cowork was not fully quit. Confirm `node -v` in a host terminal, check the absolute path, and quit from the tray/menu bar.
- **Edits to the config seem ignored (Windows MSIX).** The app may be reading the `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\` copy. Edit that one instead of `%APPDATA%`.
- **Packed extension will not start but Route A works.** The MSIX virtualized-spawn issue; use Route A.
- **Peak-judgment roles route to Opus, not Fable.** That is the default (Fable degrades to Opus). Set `MUSTER_ENABLE_FABLE=1` to opt back in.
