# Muster on Claude Cowork

Muster's deterministic brain, packaged as a local MCP server for [Claude Cowork](https://support.claude.com/en/articles/14479288-claude-cowork-desktop-architecture-overview). The canonical implementation is `mcp/server.mjs`, with explicit adapters in `mcp/codex-server.mjs`, `mcp/chatgpt-work-server.mjs`, and `cowork/mcp-server.mjs`. The public Cowork setup path below uses the Cowork adapter; `cowork/chatgpt-work-server.mjs` remains a compatibility shim for existing Work/source-checkout configurations.

Cowork extends through MCP and MCPB desktop extensions -- the port this directory targets -- and, as of ~May 2026, its own plugin system bundling skills, connectors, hooks, and sub-agents in the Claude Code plugin format (see `docs/research/claude-cowork.md` section 3d for the primary sources; this corrects an earlier version of this file that claimed Cowork "has no plugin, skill, slash-command, or hook primitives," which was true in January 2026 but is stale now). Whether muster's Claude Code plugin (`plugin/`) actually loads under Cowork's plugin loader is **unverified**: no live Cowork session was reachable to test it hands-on, and Cowork exposes no on-disk or protocol signal this MCP server (or the CLI it wraps) can inspect to auto-detect a native load. So `muster_capabilities` carries a DECLARED capability check instead of a probe -- `--native-plugin` / `MUSTER_COWORK_NATIVE_PLUGIN` (see Configuration below), the same declare-not-discover shape as remote connectors. Declare it true once a native load is confirmed on your Cowork build and muster's builtin skills/agents resolve exactly as they do on Claude Code, instead of collapsing to MCP-only; the default (false) keeps today's verified-working ride. Until a native load is confirmed, this MCP server is the whole ride: project detection, capability and domain routing, gate scoring, RICE prioritization, and wave planning, riding plain Node with no model calls. Cowork runs the local MCP server natively on the device (the agent loop), and its verbs are exposed here as MCP tools.

The six-mode MCP protocol subset (Plan, Go, Plan-backlog, Go-backlog, Diagnose, and Audit) has a verified sequential path through `muster_next`. Parallel subagents and per-call model override require a successful phase-3 probe on the active Cowork build; this repository verifies only phases 1 and 2 and carries no live phase-3 receipt. Muster has nine canonical product modes overall; Runner, Capture, and Init have different support status on the MCP-only route, shown below. (Claude Code's legacy aliases -- `/muster:run`, `/muster:autopilot`, `/muster:sprint` -- still work there too, mapping to `/muster:plan`, `/muster:go`, `/muster:go-backlog` respectively; noted once since this file uses the new names throughout.)

## Mode support

This matrix describes the verified MCP-only distribution in this directory. It does not claim that the conditional native plugin ride is active.

| Mode | MCP-only support | How to use it |
| --- | --- | --- |
| Plan | MCP protocol | Drive the Plan lifecycle from the server instructions and deterministic tools. |
| Go | MCP protocol | Drive the Go lifecycle from the server instructions and deterministic tools. |
| Plan-backlog | MCP protocol | Drive the batch planning lifecycle from the server instructions and deterministic tools. |
| Go-backlog | MCP protocol | Drive the batch clearing lifecycle; load `muster_sprint_protocol` for the Cowork-specific playbook. |
| Diagnose | MCP protocol | Drive the failure-first lifecycle from the server instructions and deterministic tools. |
| Audit | MCP protocol | Drive the whole-codebase lifecycle from the server instructions and deterministic tools. |
| Runner | Not provided | There is no Runner-mode MCP protocol or tool in this distribution. |
| Capture | Not provided | There is no Capture-mode MCP protocol or tool in this distribution. |
| Init | CLI-only | Run `npx -y @adnova-group/muster@0.5.0 init [dir]`; Init is not one of the 29 MCP tools. |

## What you get

Twenty-nine deterministic tools, plus an execution protocol that teaches the agent how to drive them. The tools perform routing, validation, scoring, and scheduling operations without model calls; the Cowork agent still performs the judgment and execution work.

| Tool | Does |
| --- | --- |
| `muster_detect` | Project profile (languages, frameworks, VCS, test runner) |
| `muster_capabilities` / `muster_capabilities_roles` | Resolve every role to its best provider, fallback chain, and model tier -- the `_roles` variant returns only the lighter `{roles}` capture |
| `muster_match` / `muster_match_skills` | Rank providers, or the live skills inventory, against a free-text task |
| `muster_domain` / `muster_route` | Classify an outcome and route it to a pipeline |
| `muster_pipeline` | Load a pipeline definition |
| `muster_assess` | Gap-check an outcome before running |
| `muster_steer` | Classify a mid-run steer message |
| `muster_diagnose` / `muster_audit` | Build the diagnose / whole-codebase audit manifest |
| `muster_manifest_validate` / `muster_wave` | Validate a crew manifest and compute its execution waves |
| `muster_sprint_waves` | Compute dependency-ordered waves from a sprint backlog's `{id}`/`{deps}` annotations (`annotated:false` means the backlog is unannotated/sequential) |
| `muster_backlog_publish` | Bounded CAS publication for complete backlog content under an explicit project root |
| `muster_sprint_protocol` | Return the Cowork-adapted sprint playbook (no args) -- see below |
| `muster_next` | Single-agent driver: next runnable task given the ids completed so far |
| `muster_gate_cadence` | Compute review-gate cadence (spec-gate rounds, batched review passes, reviewer count) from a manifest's waves |
| `muster_score` / `muster_prioritize` | Score against a gate / rank a backlog |
| `muster_pick` / `muster_tally` | Tournament winner / review-gate decision |
| `muster_fuse` | Fusion decision engine -- apply the agreement gate, select top-K for synthesis (mode fuse) or fall back to single best (mode fallback). Deterministic, no LLM. |
| `muster_advise` | Validate an advice-request and resolve the advisor model (apex degrades to prime). Deterministic, no LLM. |
| `muster_receipt_verify` | Verify a base-SHA is a real, resolvable git commit object in an explicit repo |
| `muster_scope` | Deterministic backlog-vs-item scope detection for the plan/go verb family |
| `muster_fast_path` | Score an outcome for the pre-router fast path; with `capabilities` (the `_roles` shape), also emits the minimal builder+one-reviewer manifest |
| `muster_plan_checklist` | Render a crew manifest's `plan` array as a markdown checklist |

muster's principles, routing policy, and a per-mode execution protocol (the core loop plus the Plan/Go/Plan-backlog/Go-backlog/Diagnose/Audit lifecycles) ride in the server's MCP `instructions`. Instructions provide session context, but they do not reproduce hook enforcement: the MCP-only route has no lifecycle-hook enforcement. The native plugin ride remains conditional and unverified; if a Cowork build loads `plugin/` natively, its hooks may be available through that separate loader, but this MCP server neither proves nor activates them.

### Sprint on Cowork

`muster_sprint_protocol` is a protocol-content tool, not an MCP wrapper for a same-name CLI command. With no arguments, it returns `cowork/sprint-protocol.md` verbatim -- a condensed, Cowork-native port of the Claude Code plugin's `/muster:go-backlog` lifecycle: backlog resolution against `.muster/backlog.md`, calling `muster_sprint_waves` for dependency order, the per-item go lifecycle, and claim/receipt discipline for shared backlogs. Call it at the start of a sprint the same way you'd load the slash command's protocol on Claude Code.

Be honest about what does not port on the verified MCP-only route: it has no lifecycle hooks (no wave-guard, no scale-gate, no action-class fence), no slash verbs, and no isolated per-item worktree runners, so sprint's parallel wave-mode dispatch has no safe equivalent -- every wave runs sequentially, one item at a time, in the main tree; that degradation path *is* the path here, not a fallback. And with no wave-guard hook bounding a direct-to-base merge, a `merge-local`/`merge-push` disposition executes with no structural safety net beyond the session's own diligence -- prefer `pr`/`keep` when authoring a backlog for a Cowork sprint. The full caveats live in the protocol file itself. A declared native plugin load may change those capabilities, but it remains conditional and unverified until tested on the specific Cowork build.

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

Merge this into `mcpServers` (keep any servers you already have). Use the absolute path to the compatibility entrypoint in your checkout, with doubled backslashes on Windows:

```json
{
  "mcpServers": {
    "muster": {
      "command": "node",
      "args": ["C:\\Users\\you\\dev\\muster\\cowork\\mcp-server.mjs"],
      "env": {
        "MUSTER_COWORK_CONNECTORS": "",
        "MUSTER_ENABLE_APEX": "",
        "MUSTER_MAX_TIER": ""
      }
    }
  }
}
```

macOS/Linux use a normal path, for example `"/Users/you/dev/muster/cowork/mcp-server.mjs"`. This Cowork adapter imports the canonical `mcp/server.mjs`; the `env` block is optional. See Configuration below.

### 3. Restart Cowork fully

Quit from the system tray or menu bar, not just the window. The config is read only on a real launch.

### 4. Verify

In Cowork, prompt:

> List your `muster_*` tools, then call `muster_detect` on `&lt;path to a project&gt;`.

You should see all twenty-eight tools and a project profile (language, package manager, VCS, and so on). If nothing appears, see Troubleshooting.

## Route B status: MCPB descriptor, not installable

`manifest.json` is a development MCPB descriptor (`manifest_version` 0.3), not a supported installation route. The current archive is not self-contained: `mcp-server.mjs` still needs the repository's CLI runtime, package metadata, shared guidance, and sprint protocol. `validate` checks the descriptor schema, and `pack` creates an archive, but neither proves that an extracted extension can initialize.

```bash
npx -y @anthropic-ai/mcpb@2.1.2 validate cowork
npx -y @anthropic-ai/mcpb@2.1.2 pack cowork muster.mcpb
```

Those development checks were reviewed with MCPB CLI `@anthropic-ai/mcpb@2.1.2` against Muster package `@adnova-group/muster@0.5.0`; the pins make tool provenance explicit. They do not produce a runnable standalone extension.

Do not install `muster.mcpb`. Use the verified Route A local MCP configuration above. Making Route B installable requires a bundled runtime plus an unpack-and-initialize test; Windows MSIX virtualized paths must also be covered before this status can change.

## Configuration

All supported configuration is environment variables set in the Route A `env` block. The Route B `user_config` fields document the intended future settings UI, but are not currently an install path.

| Variable | user_config field | Effect |
| --- | --- | --- |
| `MUSTER_ENABLE_APEX` | `enable_apex` | `1`/`true` routes peak-judgment roles to Apex. Empty or `false` degrades Apex to Prime (the default, since the tier can be disabled platform-wide). The retired `enable_fable` field / `MUSTER_ENABLE_FABLE` variable is still honored as a legacy alias (the new key is preferred; the server merges a legacy `true` so an upgrade never silently revokes an existing opt-in). |
| `MUSTER_MAX_TIER` | `max_tier` | `prime` or `core` caps the dispatch tier for budget control (legacy `opus`/`sonnet` values still normalize). Empty means no cap. |
| `MUSTER_COWORK_CONNECTORS` | `connectors` | Comma-separated remote-connector names to treat as available (see below). |
| `MUSTER_COWORK_NATIVE_PLUGIN` | — | `1`/`true` DECLARES that Cowork's own plugin loader has natively loaded muster's `plugin/` tree (skills, hooks, sub-agents), so `muster_capabilities` resolves builtin skills/agents the same way it does on Claude Code instead of collapsing to MCP-only. Empty or `false` (the default) keeps the verified MCP-only ride. This is a DECLARED capability check, not a probe -- Cowork exposes no on-disk or protocol signal to auto-detect a native load, so only set this once you've confirmed one on your build (see "How capabilities resolve" below). |
| `MUSTER_COWORK_MAX_INFLIGHT` | — | Maximum concurrent MCP tool executions (default `4`, hard ceiling `64`). Route A only; implemented by the neutral core through the Cowork adapter. |
| `MUSTER_COWORK_MAX_QUEUE` | — | Maximum queued MCP tool executions before overload rejection (default `16`, hard ceiling `1024`). Route A only; implemented by the neutral core through the Cowork adapter. |

### How capabilities resolve

`muster_capabilities` runs with `--cowork`, resolving providers from Cowork's own invocable surface. By default a chosen provider is either an MCP server registered with Cowork or `inline` execution by the current Cowork agent; Claude Code agents, skills, and plugin-shipped MCP definitions merely present under `~/.claude/plugins` are not advertised because Cowork's classic MCP-only registry does not load them.

- **Local MCP servers** are read from `claude_desktop_config.json` (`mcpServers` keys). On Windows the MSIX-virtualized path is tried before `%APPDATA%\Claude`.
- **MCPB extensions** are discovered by enumerating the `Claude Extensions/` directory and reading each `manifest.json` (there is no index file).
- **Claude Code plugins on the classic `~/.claude/plugins` path** do not count as installed Cowork providers. Register a plugin's MCP server in Cowork before expecting it to resolve; agent- and skill-only providers fall back to `inline`.
- **Cowork's own plugin loader** (a separate, later surface -- see the note at the top of this file) is where muster's own `plugin/` could ride instead of the MCP-only path, IF it loads there; that is unverified without a live session, so it is gated behind the DECLARED `MUSTER_COWORK_NATIVE_PLUGIN` flag above, not auto-discovered. Declared true, muster's builtin skills/agents resolve like they do on Claude Code; declared false (the default), they stay filtered to MCP-only, same as before this flag existed.
- **Remote connectors** (Slack, Drive, GitHub, and so on) live in your cloud account, not on disk, so they cannot be auto-discovered. Declare the ones you want muster to treat as available via `MUSTER_COWORK_CONNECTORS=slack,drive`. The output marks `connectorsDiscoverable: false` so the gap stays visible.

### Operating on a repo

The MCP tools run regardless, but for Cowork to actually read and edit a project, add that project's folder as a connected/trusted folder in Cowork. Point `muster_detect` at its path and pass the same path as the required `dir` argument to `muster_audit`; the server never infers an audit target from its own working directory.

Tool execution is bounded to four active calls and sixteen queued calls by default. Calls beyond the queue limit return an overload error. Cowork cancellation notifications cancel queued work immediately, terminate an active CLI child, and remove that request's temporary input directory before the response completes.

## Verifying dispatch on a new runtime

Run the probe before relying on parallel dispatch for a Cowork runtime or build:

```bash
# phases 1 and 2 self-verify the CLI and the dispatch contract; emits a phase-3 spec
node scripts/cowork-probe.mjs

# the runtime executes cowork-dispatch-spec.json, writes results.json, then:
node scripts/cowork-probe.mjs --dispatch-results results.json
```

Phase 3 passing means parallel fan-out plus per-call model override work, so the six-mode MCP protocol lifecycle can use parallel dispatch. Require that receipt before enabling the parallel path. If it fails or has not been run, Muster still runs as a router plus single-agent executor: the agent walks each wave one task at a time via `muster_next`, and every routing, scoring, and gate decision stays deterministic.

## ChatGPT Work is a separate lane

This directory is the Claude Cowork MCP package; it is not ChatGPT Work's plugin. ChatGPT Work is available on the web and in the ChatGPT desktop app with Work selected, and uses the universal Plugins Directory plus a registered MCP connection. Work does not inherit this Cowork package or Codex Desktop configuration. Follow [`website/guides/chatgpt-work.md`](../website/guides/chatgpt-work.md) for the private/local Work lane.

The recommended Work profile (`pro-safe`) is exactly one titled, read-only `muster_prioritize` tool after a successful native Scan Tools gate; the installer requires an explicit `--profile`. Its `full` profile is the existing 28-tool deterministic surface, not write support, and requires a full-MCP workspace entitlement and both installer/server opt-ins. Secure MCP Tunnel is outbound-only private transport and is not a public plugin-submission path.

## Troubleshooting

- **No `muster_*` tools after restart.** Usually Node is not on the host PATH (Route A `command: node` cannot resolve), the path in `args` is wrong, or Cowork was not fully quit. Confirm `node -v` in a host terminal, check the absolute path, and quit from the tray/menu bar.
- **Edits to the config seem ignored (Windows MSIX).** The app may be reading the `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\` copy. Edit that one instead of `%APPDATA%`.
- **Packed extension will not start but Route A works.** The MSIX virtualized-spawn issue; use Route A.
- **Peak-judgment roles route to Prime, not Apex.** That is the default (Apex degrades to Prime). Set `MUSTER_ENABLE_APEX=1` to opt back in; a pre-rename `MUSTER_ENABLE_FABLE=1` (or a stored `enable_fable` extension setting) still works as a legacy alias.
