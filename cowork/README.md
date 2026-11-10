# Muster on Claude Desktop (Chat, Cowork, and the Code tab)

Claude Desktop has two ways to run muster. The primary route is muster's plugin, added from Customize > Plugins. The plugin-less fallback is this directory's local MCP server. Research and quotes for every claim below: [`docs/research/claude-cowork.md`](../docs/research/claude-cowork.md).

- **Plugin (primary).** Chat and Cowork load plugins from your claude.ai account. Per the [platform-support table](https://claude.com/docs/plugins/platform-support), Cowork loads a plugin's skills, commands, agents and hooks, and Chat loads its skills and commands. An account install also syncs to Claude Code. muster's plugin has no top-level `bin/`, so neither surface refuses it.
- **MCP server (plugin-less fallback).** `cowork/mcp-server.mjs` is the Cowork adapter over the neutral MCP core `mcp/server.mjs` (the other adapters are `mcp/codex-server.mjs` and `mcp/chatgpt-work-server.mjs`; `cowork/chatgpt-work-server.mjs` remains a compatibility shim for existing Work/source-checkout configurations). It exposes 30 deterministic tools. When the plugin's `/muster:*` skills are present, its instructions tell the agent to use them and treat the tools as their deterministic backend; without them, the instructions carry the fallback protocol.

Where each surface stands:

- **Code tab**: full Claude Code. Use it for software outcomes: branches, worktrees, `merge-wave` and the Workflow tool all need a local checkout. **Desktop WSL sessions load no plugins** ("Plugins: not available in WSL sessions"), so muster is absent there; use a local or SSH session, or the CLI inside WSL.
- **Cowork**: plugin skills, commands, agents and hooks load. New tasks on Pro, Max and Ultra run in the cloud since 2026-10-06, and "Local MCP servers don't run in sessions in the cloud". Good for non-code pipelines; whether `npx` and git resolve in the Cowork sandbox is not documented.
- **Chat**: plugin skills and commands (as skills) load; agents and hooks are ignored.

Dispatch evidence for the fallback protocol, split by primitive. Parallel subagents are documented in Cowork, so dependency-free wave members may fan out without a probe. A per-call model override is documented nowhere for Cowork, so it still requires a successful phase-3 probe on the active Cowork build; this repository verifies only phases 1 and 2 and carries no live phase-3 receipt. Sequential `muster_next` stays the default driver when no subagent tool is available.

## Mode support

| Mode | Plugin route | MCP-only fallback |
| --- | --- | --- |
| Plan | `/muster:plan` | MCP protocol |
| Go | `/muster:go` | MCP protocol |
| Plan-backlog | `/muster:plan` with a backlog | MCP protocol |
| Go-backlog | `/muster:go` with a backlog | MCP protocol; load `muster_sprint_protocol` |
| Diagnose | `/muster:diagnose` | MCP protocol |
| Audit | `/muster:audit` | MCP protocol |
| Design | `/muster:design` | `muster_design` |
| Runner | Code tab or CLI | Not provided |
| Capture | `/muster:capture` | Not provided |
| Init | `/muster:init` | CLI-only: `npx -y @adnova-group/muster@0.7.1 init [dir]` |

In Chat a command loads as a skill that Claude applies when it fits; in Cowork and the Code tab you run it as `/muster:<command>`. The MCP-only column is the seven-mode MCP protocol subset (Plan, Go, Plan-backlog, Go-backlog, Diagnose, Audit, and Design).

## Install the plugin (primary)

1. In Claude Desktop (or claude.ai), open **Customize > Plugins**.
2. Click **Add**, then **Add marketplace**, and enter `Adnova-Group/muster`.
3. Install **muster** from that marketplace.
4. Check it: in a Cowork task, type `/` and look for the `/muster:*` commands.

The install is attached to your account, so it also appears in Claude Code as a synced plugin at the next session start (Claude Code v2.1.273 or later). From a terminal you can install it the Claude Code way instead: `/plugin marketplace add Adnova-Group/muster`, then `/plugin install muster@muster`.

Run `muster doctor --desktop` to confirm what Desktop sees: the config dirs (including the Windows MSIX copy, found from WSL through `/mnt/c`), any muster `mcpServers` entry with its checkout version and git state, whether muster is in the account plugin list, Code-tab sessions that run in WSL, and the log dir `%LOCALAPPDATA%\Claude\Logs`. It is read-only and never edits Desktop config.

## What the MCP server gives you

Thirty deterministic tools, plus an execution protocol in the server's MCP `instructions`. The tools perform routing, validation, scoring, scheduling, design-context gating, receipt reconciliation, and bounded backlog publication without model calls; the agent still performs the judgment and execution work.

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
| `muster_design` | Resolve or initialize canonical design context, inspect bounded evidence/provider state, gate human-facing writes, and dispatch a pinned workflow |
| `muster_manifest_validate` / `muster_wave` | Validate a crew manifest and compute its execution waves |
| `muster_sprint_waves` | Compute dependency-ordered waves from a sprint backlog's `{id}`/`{deps}` annotations (`annotated:false` means the backlog is unannotated/sequential) |
| `muster_sprint_reconcile` | Drain completion receipts into deterministic sprint states and the next eligible implementation/review/integration actions |
| `muster_backlog_publish` | Bounded compare-and-swap publication for complete, contained backlog content; concurrent writers must reread and reapply |
| `muster_sprint_protocol` | Return the Cowork-adapted sprint playbook (no args) -- see below |
| `muster_next` | Single-agent driver: next runnable task given the ids completed so far |
| `muster_gate_cadence` | Compute review-gate cadence (spec-gate rounds, batched review passes, reviewer count) from a manifest's waves |
| `muster_score` / `muster_prioritize` | Score against a gate / rank a backlog |
| `muster_pick` / `muster_tally` | Tournament winner / review-verdict tally |
| `muster_fuse` | Fusion decision engine -- apply the agreement gate, select top-K for synthesis (mode fuse) or fall back to single best (mode fallback). Deterministic, no LLM. |
| `muster_advise` | Validate an advice-request and resolve the advisor model (apex degrades to prime). Deterministic, no LLM. |
| `muster_scope` | Deterministic backlog-vs-item scope detection for the plan/go verb family |
| `muster_fast_path` | Score an outcome for the pre-router fast path; with `capabilities` (the `_roles` shape), also emits the minimal builder+one-reviewer manifest |
| `muster_plan_checklist` | Render a crew manifest's `plan` array as a markdown checklist |


The instructions carry muster's principles, routing policy, and the per-mode fallback protocol (the core loop plus the Plan/Go/Plan-backlog/Go-backlog/Diagnose/Audit/Design lifecycles). Instructions provide session context, but they do not reproduce hook enforcement: the MCP-only route has no lifecycle-hook enforcement. On the plugin route, Cowork loads the plugin's hooks; which hook events Cowork fires is not documented.

### Sprint on Cowork

`muster_sprint_protocol` is a protocol-content tool, not an MCP wrapper for a same-name CLI command. With no arguments, it returns `cowork/sprint-protocol.md` verbatim -- a condensed, Cowork-native port of the Claude Code plugin's backlog lifecycle (`/muster:go` on a backlog): backlog resolution against `.muster/backlog.md`, calling `muster_sprint_waves` for dependency order, the per-item go lifecycle, and claim/receipt discipline for shared backlogs. Call it at the start of a sprint the same way you'd load the slash command's protocol on Claude Code.

Be honest about what does not port on the MCP-only route: it has no lifecycle hooks (no wave-guard, no scale-gate, no action-class fence), no slash verbs, and no native isolated per-item worktree runner. Without a proven native per-subagent worktree primitive, the orchestrator creates a dedicated isolated Git worktree for each write-capable item and executes those implementations sequentially in their assigned worktrees. The main tree is only the coordination and ordered-integration surface. And with no wave-guard hook bounding a direct-to-base merge, a `merge-local`/`merge-push` disposition executes with no structural safety net beyond the session's own diligence -- prefer `pr`/`keep` when authoring a backlog for a Cowork sprint. The full caveats live in the protocol file itself.

## Fallback: the local MCP server (plugin-less)

Use this when you cannot install the plugin, or alongside it as the deterministic backend in the Code tab, Chat, and local Cowork sessions. A server in `claude_desktop_config.json` "is available in both the Desktop chat surface and local Code tab sessions"; it does not run in Cowork cloud sessions.

### Prerequisites

- **Node 20 or newer, on the host PATH.** Desktop runs the server with the host's Node, not a Node inside WSL or a container. Check in a host terminal (PowerShell on Windows, Terminal on macOS): `node -v`.
- **A muster checkout on disk.** The server resolves the CLI at `../src/cli.js` relative to itself, so the `cowork/` directory must stay inside the repo. Clone the repo somewhere stable, for example `C:\Users\you\dev\muster` or `~/dev/muster`, and keep it current: `muster doctor --desktop` flags a stale, behind, or dirty checkout.

### 1. Find the config file

| OS | Path |
| --- | --- |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Linux (beta) | `~/.config/Claude/claude_desktop_config.json` |

Create the file if it does not exist. Windows installs are an MSIX package; a virtualized copy can exist under `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\`. Where that LocalCache copy is absent, the app reads `%APPDATA%\Claude`. `muster doctor --desktop` reports which one is active.

### 2. Add the muster server

Merge this into `mcpServers` (keep any servers you already have). Use the absolute path to the Cowork adapter in your checkout, with doubled backslashes on Windows:

```json
{
  "mcpServers": {
    "muster": {
      "command": "node",
      "args": ["C:\\Users\\you\\dev\\muster\\cowork\\mcp-server.mjs"],
      "env": {
        "MUSTER_COWORK_CONNECTORS": "",
        "MUSTER_ENABLE_APEX": "",
        "MUSTER_MAX_TIER": "",
        "MUSTER_LIFECYCLE_RECEIPT_PUBLIC_KEY": "<Ed25519 public PEM>",
        "MUSTER_INTEGRATION_APPROVAL_PUBLIC_KEY": "<Ed25519 public PEM>",
        "MUSTER_RUN_ID": "<adapter-owned sprint UUID>"
      }
    }
  }
}
```

macOS/Linux use a normal path, for example `"/Users/you/dev/muster/cowork/mcp-server.mjs"`. The `env` block is optional. See Configuration below.

### 3. Restart Claude fully

Quit from the system tray or menu bar, not just the window. The config is read only on a real launch.

### 4. Verify

Prompt:

> List your `muster_*` tools, then call `muster_detect` on `&lt;path to a project&gt;`.

You should see the thirty tools and a project profile (language, package manager, VCS, and so on). If nothing appears, see Troubleshooting.

## Route B (MCPB) is retired

The development MCPB descriptor (`cowork/manifest.json`) is gone. Plugins replace it, and Cowork does not prompt for `${user_config}` values, which the descriptor's settings depended on. Configure the fallback server through its `env` block instead.

## Configuration

All supported configuration is environment variables, set in the fallback server's `env` block or in the environment of a CLI call.

| Variable | Effect |
| --- | --- |
| `MUSTER_ENABLE_APEX` | `1`/`true` routes peak-judgment roles to Apex. Empty or `false` degrades Apex to Prime (the default, since the tier can be disabled platform-wide). The retired `MUSTER_ENABLE_FABLE` variable is still honored as a legacy alias. |
| `MUSTER_MAX_TIER` | `prime` or `core` caps the dispatch tier for budget control (legacy `opus`/`sonnet` values still normalize). Empty means no cap. |
| `MUSTER_COWORK_CONNECTORS` | Comma-separated remote-connector names to treat as available (see below). |
| `MUSTER_COWORK_NATIVE_PLUGIN` | Overrides plugin detection for `muster_capabilities`: `1`/`true` declares that muster's plugin is loaded, `0`/`false`/`no`/`off` declares a plugin-less install. Empty or unset lets the server read the account plugin list (see "How capabilities resolve"). The CLI equivalents are `--native-plugin` and `--plugin-less`. |
| `MUSTER_COWORK_MAX_INFLIGHT` | Maximum concurrent MCP tool executions (default `4`, hard ceiling `64`). Implemented by the neutral core through the Cowork adapter. |
| `MUSTER_COWORK_MAX_QUEUE` | Maximum queued MCP tool executions before overload rejection (default `16`, hard ceiling `1024`). Implemented by the neutral core through the Cowork adapter. |
| `MUSTER_LIFECYCLE_RECEIPT_PUBLIC_KEY` | Ed25519 public key used by model-callable reconciliation to verify broker-issued receipts. It cannot mint evidence. |
| `MUSTER_INTEGRATION_APPROVAL_PUBLIC_KEY` | Ed25519 public key used by model-callable reconciliation to verify broker-issued approvals. It cannot mint evidence. |
| `MUSTER_RUN_ID` | Stable adapter-owned UUID for one sprint run. Provision the identical value to verifier and privileged callbacks; rotate it for a new run. |

For sprint lifecycle evidence, generate two Ed25519 keypairs and a fresh run UUID. Run `scripts/sprint-evidence-broker.mjs <protected-config.json>` as a separately privileged host service account; its owner-only config points to owner-only private-key files, adapter-owned assignment state, and a private socket or Windows named pipe. The Cowork MCP process receives only the public keys. A host mailbox or authenticated-human callback invokes `scripts/sprint-evidence-callback.mjs` with that socket and its actor-specific `MUSTER_EVIDENCE_CALLBACK_TOKEN`. The broker hashes the token into the adapter-owned principal map, verifies the assigned worktree/repository/branch/phase and prior approval action, and signs with its private key. Do not place private keys, callback tokens, or assignment state in the Cowork server environment, MCP arguments, or model-readable files. If the host cannot run the privileged service and callbacks, use the sequential fallback; authenticated parallel sprint lifecycle is unavailable rather than silently weakened.

The protected broker config schema is:

```json
{
  "socketPath": "/run/user/1000/muster-evidence.sock",
  "statePath": "/var/lib/muster/run-uuid/state.json",
  "checkpointPath": "/var/lib/muster/run-uuid/checkpoint.json",
  "lockPath": "/var/lib/muster/run-uuid/state.lock",
  "receiptPrivateKeyPath": "/var/lib/muster/run-uuid/receipt-private.pem",
  "approvalPrivateKeyPath": "/var/lib/muster/run-uuid/approval-private.pem",
  "approvalPublicKeyPath": "/var/lib/muster/run-uuid/approval-public.pem"
}
```

The owner-only state file is versioned. `callbackPrincipals` keys are SHA-256 digests of independent high-entropy callback tokens; each principal's `purposes` may contain only its authenticated phases. Every item records its exact assigned worktree, common Git directory, branch, phase actors, current integration target, and—only after reconciliation emits it—the current `approvalActionDigest`:

```json
{
  "version": 2,
  "runId": "run-uuid",
  "callbackPrincipals": {
    "<sha256-runner-token>": { "actorId": "runner-a", "purposes": ["implementation"] },
    "<sha256-reviewer-token>": { "actorId": "reviewer-a", "purposes": ["review"] },
    "<sha256-human-token>": {
      "actorId": "human-a",
      "purposes": ["approval"],
      "oneTimeApproval": {
        "runId": "run-uuid",
        "actorId": "human-a",
        "itemId": "a",
        "approvalActionDigest": "<64-hex-from-reconcile>",
        "humanEventAt": "2026-08-01T12:00:00.000Z",
        "expiresAt": "2026-08-01T12:15:00.000Z"
      }
    }
  },
  "items": {
    "a": {
      "worktreePath": "/srv/muster/.worktrees/a",
      "gitCommonDir": "/srv/muster/.git",
      "branch": "muster/a",
      "actors": { "implementation": "runner-a", "review": "reviewer-a", "integration": "integrator-a", "approval": "human-a" },
      "integrationTarget": { "baseBranch": "main", "baseHeadSha": "<40-or-64-hex>", "operation": "merge-local" },
      "approvalActionDigest": "<64-hex-from-reconcile>"
    }
  }
}
```

Initialize under the broker service account with `umask 077`, generate each key with `openssl genpkey -algorithm Ed25519`, derive the public PEM with `openssl pkey -pubout`, write config/state mode `0600`, and start `node scripts/sprint-evidence-broker.mjs /protected/config.json`. The broker initializes the owner-only monotonic checkpoint on its first protected read.

Every later state writer, including the host adapter that admits an item, rotates a callback, or records a newly emitted approval action, must use the same transactional publisher as the broker consumer. First run `node scripts/sprint-evidence-state.mjs read /protected/config.json` and retain its exact `version` and `contentHash`. Prepare the complete desired state in another owner-only file, then run `node scripts/sprint-evidence-state.mjs publish /protected/config.json /protected/next-state.json <version> <contentHash>`. Do not increment `version` in the desired document; the publisher does that while holding the shared lock. On a conflict, reread, reapply the intended change to the new state, and retry. Never rename a state file directly: doing so bypasses the shared compare-and-swap protocol.

Consumption and publication both lock `lockPath`, compare the expected `{version, contentHash}`, advance the durable checkpoint, and atomically replace the state. Consequently neither ordering of a publisher/consumer race can restore a consumed capability. The checkpoint survives broker restarts and rejects rollback or same-version replacement; if the service fails after advancing the checkpoint but before replacing state, it fails closed and an operator must reconcile the protected files rather than lowering the checkpoint. Rotate a run by stopping the service and starting a new protected config/state/checkpoint/key set with a new `runId`; never reuse callback tokens across runs.

Receipt callback tokens are canonical 64-character lowercase hex values representing at least 32 random bytes. Human approval uses a distinct one-time token whose principal embeds the exact run, actor, item, emitted action digest, trusted human-event timestamp, and expiry. The broker preserves that human timestamp, atomically removes the capability and increments state version before returning the signature, so duplicate/replayed approval calls fail; a crash after consumption requires a new human event rather than recreating freshness. The service requires a service-owned `0700` state/config directory, owner-owned `0600` files, and creates the Unix socket as `0600`; Windows currently fails closed until an ACL-hardened named-pipe adapter exists.

### How capabilities resolve

`muster_capabilities` runs `capabilities --cowork`, resolving providers from what Desktop can actually invoke:

- **Plugin load.** A declaration wins (`MUSTER_COWORK_NATIVE_PLUGIN`, `--native-plugin`, `--plugin-less`). Undeclared, the server reads the account plugin list Desktop keeps at `<config dir>/plugin-list/<org>/<account>/plugins.json` (observed on Windows; the file is undocumented). muster present and enabled: its builtin skills and agents resolve exactly as on Claude Code. List readable but muster absent or disabled: the plugin-less fallback, where a role resolves to a registered MCP server or `inline`. No readable list: the plugin route is assumed, since it is the documented Desktop route.
- **Local MCP servers** are read from `claude_desktop_config.json` (`mcpServers` keys). On Windows the MSIX-virtualized path is tried before `%APPDATA%\Claude`.
- **MCPB extensions** are discovered by enumerating the `Claude Extensions/` directory and reading each `manifest.json` (there is no index file).
- **`~/.claude` never counts.** Cowork "doesn't read the Claude Code CLI's `~/.claude` directory", so skills and agents installed there are not advertised.
- **Remote connectors** (Slack, Drive, GitHub, and so on) live in your cloud account, not on disk, so they cannot be auto-discovered. Declare the ones you want muster to treat as available via `MUSTER_COWORK_CONNECTORS=slack,drive`. The output marks `connectorsDiscoverable: false` so the gap stays visible.

The output's `dispatch` block records the evidence: `pluginLoad` (state and source), `parallelSubagents: "documented"`, and `perCallModelOverride`, which stays unverified until a phase-3 probe receipt exists. Until then each role's `claudeModel` is advisory in Cowork.

### Operating on a repo

The MCP tools run regardless, but for Cowork to actually read and edit a project, add that project's folder as a connected/trusted folder. Point `muster_detect` at its path and pass the same path as the required `dir` argument to `muster_audit`; the server never infers an audit target from its own working directory.

Tool execution is bounded to four active calls and sixteen queued calls by default. Calls beyond the queue limit return an overload error. Cancellation notifications cancel queued work immediately, terminate an active CLI child, and remove that request's temporary input directory before the response completes.

## Verifying a per-call model override

Parallel subagents need no probe in Cowork; they are documented. A per-call model override is not, so run the probe before relying on one:

```bash
# phases 1 and 2 self-verify the CLI and the dispatch contract; emits a phase-3 spec
node scripts/cowork-probe.mjs

# the runtime executes cowork-dispatch-spec.json, writes results.json, then:
node scripts/cowork-probe.mjs --dispatch-results results.json
```

Phase 3 passing means the active Cowork build honored the per-call model override. Require that receipt before dispatching roles on their `claudeModel`. If it fails or has not been run, muster still dispatches subagents and keeps every routing, scoring, and gate decision deterministic; the model is whatever Cowork picks.

## ChatGPT Work is a separate lane

This directory is the Claude Desktop MCP package; it is not ChatGPT Work's plugin. ChatGPT Work is available on the web and in the ChatGPT desktop app with Work selected, and uses the universal Plugins Directory plus a registered MCP connection. Work does not inherit this Cowork package or Codex Desktop configuration. Follow [`website/guides/chatgpt-work.md`](../website/guides/chatgpt-work.md) for the private/local Work lane.

The recommended Work profile (`pro-safe`) is exactly one titled, read-only `muster_prioritize` tool after a successful native Scan Tools gate; the installer requires an explicit `--profile`. Its `full` profile is the existing 30-tool deterministic surface, not write support, and requires a full-MCP workspace entitlement and both installer/server opt-ins. Secure MCP Tunnel is outbound-only private transport and is not a public plugin-submission path.

## Troubleshooting

- **Start with `muster doctor --desktop`.** It reports the active config dir, the muster checkout the server runs, the account plugin list, WSL Code-tab sessions, and the log dir.
- **No `/muster:*` commands in a Code-tab session.** If the session runs in WSL, that is expected: Desktop WSL sessions load no plugins. Use a local or SSH session, or the CLI inside WSL.
- **No `/muster:*` commands in Cowork or Chat.** Check Customize > Plugins for muster. Remember Chat ignores agents and hooks by design.
- **No `muster_*` tools after restart.** Usually Node is not on the host PATH (`command: node` cannot resolve), the path in `args` is wrong, or Claude was not fully quit. Confirm `node -v` in a host terminal, check the absolute path, and quit from the tray/menu bar. The server log is `%LOCALAPPDATA%\Claude\Logs\mcp-server-muster.log` on Windows.
- **No `muster_*` tools in a Cowork task.** New Cowork tasks run in the cloud, where local MCP servers do not run. Use the plugin.
- **Edits to the config seem ignored (Windows MSIX).** The app may be reading the `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\` copy. `muster doctor --desktop` shows which dir is active.
- **Peak-judgment roles route to Prime, not Apex.** That is the default (Apex degrades to Prime). Set `MUSTER_ENABLE_APEX=1` to opt back in; a pre-rename `MUSTER_ENABLE_FABLE=1` still works as a legacy alias.
