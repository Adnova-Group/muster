# Research: ChatGPT / Codex Desktop — base loop and divergence from the Codex CLI

Wave-1 input for `harness-internals-research`. Target: the desktop/IDE Codex surface — the
ChatGPT desktop app and the Codex IDE extension — versus the Codex CLI, with emphasis on
install/config/cache boundaries. Reconciliation target: muster's `codex-desktop-install`
backlog item (74 skills / 27 agent profiles / 21 MCP tools, WSL-vs-Windows split state)
[src: backlog] and the retriage record that re-verified it live [src: retriage].

Evidence tags used throughout:

- `[DOCUMENTED]` — stated in official OpenAI Codex/ChatGPT docs (developers.openai.com/codex/*).
- `[LIVE-VERIFIED-DECISION-RECORD]` — recorded in `docs/decisions/retriage-install-items.md`,
  which re-ran installs, doctor, and a live MCP handshake against this machine's real Codex
  install on 2026-07-16 [src: retriage].
- `[INFERRED]` — a reasoned bridge between documented facts; each one states its basis.

## 1. What "Codex Desktop" is now

The desktop surface is the ChatGPT desktop app, not a separate "Codex app": OpenAI's docs
list five Codex surfaces — ChatGPT desktop app, ChatGPT on the web, Codex CLI, Codex IDE
extension, and Codex cloud — and the desktop app's macOS download artifact is literally
`Codex.dmg` served from a `codex-app-prod` bucket [DOCUMENTED] [src: app]. Inside the app the
composer offers three modes — Chat, Work, or Codex — and the Codex mode is the local coding
agent with projects, worktrees, Git tooling, and an integrated terminal [DOCUMENTED]
[src: app] [src: localenv].

The IDE extension (`openai.chatgpt` on the VS Code marketplace; Cursor/Windsurf compatible;
Xcode and JetBrains ship their own integrations) is the third local surface [DOCUMENTED]
[src: ide]. The three local surfaces — desktop app, CLI, IDE extension — are repeatedly and
explicitly documented as one "Codex host" sharing configuration; ChatGPT web is the odd one
out ("ChatGPT web doesn't read local Codex configuration files") [DOCUMENTED] [src: mcp].

## 2. Process architecture: shared core, app-server protocol

- The Codex CLI and the Codex App Server are open source in `openai/codex` (the app-server
  lives at `codex-rs/app-server` — a Rust crate); the IDE extension and Codex cloud are
  explicitly "Not open source", and the desktop app does not appear in the open-source
  component table at all [DOCUMENTED] [src: opensource].
- "Codex app-server is the interface Codex uses to power rich clients (for example, the
  Codex VS Code extension)" — JSON-RPC 2.0 over stdio (default), WebSocket (experimental),
  or Unix socket, with auth, conversation history, approvals, and streamed agent events
  [DOCUMENTED] [src: appserver]. The CLI itself can run as a detached UI against a remote
  app-server (`codex app-server --listen ws://…` + `codex --remote ws://…`) [DOCUMENTED]
  [src: appserver].
- The desktop app's use of the same core is [INFERRED] but tightly constrained by
  documentation: `CODEX_HOME` is documented as "Used by CLI, IDE extension, app-server,
  installers" and holds "config, auth, logs, sessions, skills" for all of them
  [src: envvars]; the desktop app stores plugin on/off state in `~/.codex/config.toml`
  [src: build-plugins]; and desktop/CLI/IDE share MCP config, custom agents, and hook layers
  (sections 5-7). The economical explanation is one Rust core (`codex-rs`) driven through
  app-server by both the extension and the desktop shell; no public doc states the desktop's
  internal process layout, which is a real documentation boundary (section 12).
- Diagnostics confirm the Rust core for CLI and app-server: `RUST_LOG` filters like
  `codex_core=debug,codex_tui=debug` are the documented log knobs [DOCUMENTED] [src: envvars].

## 3. Install topology

### 3.1 Binaries and homes

- CLI install: `curl -fsSL https://chatgpt.com/codex/install.sh | sh` (or `install.ps1`);
  the visible `codex` command goes to `CODEX_INSTALL_DIR` (default `~/.local/bin` on
  macOS/Linux, `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` on Windows) while "the standalone
  package cache still lives under `CODEX_HOME/packages/standalone`" [DOCUMENTED] [src: envvars].
- Desktop install: `Codex.dmg` on macOS [src: app]; on Windows, the Microsoft Store package
  `9PLM9XGG6VKS` (`winget install --id 9PLM9XGG6VKS -s msstore`) [DOCUMENTED] [src: winapp].
- `CODEX_HOME` (default `~/.codex`) is the single state root — config, auth, logs, sessions,
  skills, package metadata — for CLI, IDE extension, app-server, and installers; if you set
  it, the directory must already exist [DOCUMENTED] [src: envvars]. Under it live
  `config.toml`, `auth.json` (or OS keychain), `history.jsonl`, and per-user logs/caches
  [DOCUMENTED] [src: cfg-adv]. muster's installer mirrors this exactly:
  `process.env.CODEX_HOME || join(home, ".codex")` at `src/codex-install.js:23`
  [src: codex-install].

### 3.2 Plugin marketplaces — how one install reaches both surfaces

A plugin is a bundle with a required `.codex-plugin/plugin.json` manifest plus optional
`skills/`, `hooks/hooks.json`, `.mcp.json` (MCP servers), `.app.json` (connectors), and
assets [DOCUMENTED] [src: build-plugins]. A marketplace is a JSON catalog of plugins. The
ChatGPT desktop app reads marketplace files from four places [DOCUMENTED] [src: build-plugins]:

- the curated marketplace behind the official Plugins Directory [src: build-plugins];
- a repo marketplace at `$REPO_ROOT/.agents/plugins/marketplace.json` [src: build-plugins];
- a legacy-compatible marketplace at `$REPO_ROOT/.claude-plugin/marketplace.json` [src: build-plugins];
- a personal marketplace at `~/.agents/plugins/marketplace.json` [src: build-plugins].

Install cache: "The app installs plugins into
`~/.codex/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME/$VERSION/`. For local plugins,
`$VERSION` is `local`, and the app loads the installed copy from that cache path rather than
directly from the marketplace entry." Per-plugin on/off state is stored in
`~/.codex/config.toml` [DOCUMENTED] [src: build-plugins].

The CLI reaches the same catalog: `codex plugin marketplace add <owner/repo | git-url |
./local-root>` (with `--ref`/`--sparse`), plus `list`/`upgrade`/`remove`, and `/plugins`
opens the in-TUI browser grouped by marketplace [DOCUMENTED] [src: build-plugins]
[src: plugins]. The IDE extension browses/installs "for the connected Codex host" via
Settings > Plugins [DOCUMENTED] [src: plugins].

This is precisely the topology muster's installer targets [LIVE-VERIFIED-DECISION-RECORD]
[src: retriage]:

- `scripts/build-codex.mjs` generates the full plugin (skills, commands, agents, bundled
  CLI + MCP runtime) into `<distributionRoot>/.agents/plugins/` — the documented repo
  marketplace root — writing `.codex-plugin/plugin.json` and `.mcp.json` in the documented
  shapes, and a `marketplace.json` whose entry uses `source: {source: "local", path:
  "./plugin"}` with `policy.installation`/`policy.authentication`/`category` exactly as the
  marketplace metadata spec requires [src: build-codex] [src: build-plugins].
- `src/codex-install.js` registers it with the live CLI: `codex plugin marketplace add
  <repoRoot>` then `codex plugin add muster@muster`, with rollback on failure
  (`registerPlugin`, `src/codex-install.js:620-638`) and a conflict remediation message that
  names `codex plugin marketplace remove muster` (`:615`) [src: codex-install].
- Restart semantics match the item's "after clean restarts" success criterion: docs require
  restarting the ChatGPT desktop app after marketplace changes, starting a new CLI session,
  and starting a new IDE chat before bundled skills/tools appear [DOCUMENTED] [src: plugins]
  [src: build-plugins] [src: backlog].

### 3.3 Freshness caveat

Marketplace edits are not hot-reloaded: "After you change the plugin, update the plugin
directory that your marketplace entry points to and restart the ChatGPT desktop app so the
local install picks up the new files" [DOCUMENTED] [src: build-plugins]. muster's build is
idempotent-by-version (`buildCodexPlugin` skips regeneration when the published
`packageVersion` matches; `MUSTER_BUILD_FORCE=1` overrides), so a source edit without a
version bump does not refresh what the desktop cache will copy — a known, documented-in-code
limitation (`scripts/build-codex.mjs:283-301`) [src: build-codex].

## 4. The WSL-vs-Windows boundary (the documented split state)

This is now first-party documented, and it matches what muster recorded from live state:

- "The Windows app uses the same Codex home directory as native Codex on Windows:
  `%USERPROFILE%\.codex`. If you also run the Codex CLI inside WSL, the CLI uses the Linux
  home directory by default, so it doesn't automatically share configuration, cached auth,
  or session history with the Windows app" [DOCUMENTED] [src: winapp].
- Documented remedies: sync the two directories, or point WSL at the Windows home with
  `export CODEX_HOME=/mnt/c/Users/<windows-user>/.codex` in the WSL shell profile
  [DOCUMENTED] [src: winapp].
- The desktop app on Windows defaults to the Windows-native agent (PowerShell + native
  Windows sandbox) and can be switched to run the agent in WSL2 from Settings, taking effect
  only after an app restart; WSL1 support ended at Codex 0.115 when the Linux sandbox moved
  to bubblewrap [DOCUMENTED] [src: winapp] [src: wsl].
- Known sharp edges the docs concede: projects opened from `\\wsl$\` paths lose Git
  detection under the native agent ("store the project on the native Windows drive and
  access it in WSL through `/mnt/<drive>/...`"), and `/mnt/c` I/O is slow with symlink and
  permission issues [DOCUMENTED] [src: winapp] [src: wsl].

The `CODEX_HOME=/mnt/c/...` bridge is exactly the configuration that produces muster's
recorded split-state hazards, and the code paths that survive them are live-verified
[LIVE-VERIFIED-DECISION-RECORD] [src: retriage]:

- Case-duplicated scopes: `/mnt/c` (drvfs) is case-insensitive, and `realpath` does not
  normalize casing there, so the same physical scope can register under two casings.
  `canonicalDiskCasing` (`src/codex-install.js:100-112`) recovers on-disk casing by walking
  parent listings, and `reconcileScopeRegistryEntries` (`:121-144`) collapses duplicates by
  `dev:ino` identity rather than string compare — with WSL drive-path casing tests at
  `test/codex.test.js:1315,1329,1379` cited by the retriage verdict [src: codex-install]
  [src: retriage].
- Hook command portability: hook entries carry both `command` and `commandWindows`, with
  `formatCodexWindowsPath` mapping `/mnt/c/...` to `C:/...` (`src/codex-install.js:501-507`)
  so the same installed `hooks.json` works whichever side of the boundary executes it; the
  inverse mapping (`X:\...` to `/mnt/x/...`) backs marketplace-root identity checks
  (`normalizedLocalRoot`, `:578-583`) [src: codex-install].
- drvfs write-burst hazard: renaming a directory immediately after a large write burst on a
  WSL2 drvfs mount can return persistent spurious ENOENT, so plugin generation stages on
  native tmpfs and copy-publishes instead of renaming a hot tree
  (`scripts/build-codex.mjs:14-26`) [src: build-codex].

Implementation-grade consequence [INFERRED from the two documented CODEX_HOME defaults]: on
a Windows+WSL machine there are two physical `CODEX_HOME`s unless the user applies the
documented bridge. Any muster guarantee phrased as "the active Codex CLI and Desktop global
config" (e.g. the re-opened thread-limits item) must therefore either write both homes or
detect the bridge, and doctor's split-state reporting is the right surface for the
undecidable cases [src: backlog] [src: retriage].

## 5. config.toml: one file, shared layers — thread limits and model

Desktop, CLI, and IDE extension read the same configuration layers [DOCUMENTED]:

- "Codex stores MCP configuration in `config.toml`... The ChatGPT desktop app, Codex CLI,
  and IDE extension share this configuration. Once you configure your MCP servers, you can
  switch among those clients without redoing setup" [src: mcp]. The config-basics page makes
  the same claim for the model/approvals/sandbox settings ("The CLI and IDE extension share
  the same configuration layers") [src: cfg-basic].
- Precedence (highest first): CLI flags / `-c` overrides → project `.codex/config.toml`
  files from repo root down to cwd (closest wins; trusted projects only) → profile files
  (`~/.codex/<profile>.config.toml` via `--profile`) → user `~/.codex/config.toml` → system
  `/etc/codex/config.toml` → built-in defaults [src: cfg-basic].
- Project configs cannot override credential/provider/notification/telemetry keys
  (`openai_base_url`, `model_provider`, `model_providers`, `notify`, `profile`, `otel`, …) —
  Codex ignores them with a startup warning [src: cfg-adv]. Managed machines can add
  admin-enforced `requirements.toml` constraints, including `marketplaces.allowed_sources`
  restrictions and `features.plugin_sharing = false` [src: cfg-basic] [src: cfg-ref].

Thread limits — the keys behind muster's re-opened `codex-thread-limits-enforcement` item —
are global `[agents]` settings in this same shared file [DOCUMENTED] [src: subagents]:

- `agents.max_threads`: concurrent open agent thread cap, defaults to 6 when unset [src: subagents].
- `agents.max_depth`: spawn nesting depth, defaults to 1 (root spawns children; children
  cannot spawn deeper), with an explicit doc warning that raising it multiplies token/latency
  cost [src: subagents].
- Also `agents.job_max_runtime_seconds` (CSV fan-out worker timeout, default 1800s per call)
  and `agents.interrupt_message` (default true) [src: subagents].

So the target state muster's item names (max_threads >= 12, max_depth >= 2) is a documented,
supported write to the shared `config.toml` — one write per physical `CODEX_HOME` covers
desktop, CLI, and IDE simultaneously, and the only multiplicity comes from the WSL/Windows
dual-home case in section 4 [DOCUMENTED for the keys and sharing; INFERRED for the coverage
claim] [src: subagents] [src: mcp] [src: backlog]. Current mainline muster writes no
`config.toml` at all (`src/codex-install.js` has no configToml handling — verified by grep
in the retriage), which is why the item was re-opened [LIVE-VERIFIED-DECISION-RECORD]
[src: retriage].

Model selection lives in the same file (`model = "gpt-5.6"`, `model_reasoning_effort`),
with the GPT-5.6 family split into Sol (deep reasoning), Terra (balanced default), and Luna
(speed/affordability, higher usage limits) [DOCUMENTED] [src: cfg-basic] [src: pricing].

## 6. MCP servers: desktop vs CLI

- Configuration is a `[mcp_servers.<name>]` table in the shared `config.toml` (user or
  trusted-project scope): STDIO (`command`/`args`/`env`/`env_vars`/`cwd`) and streamable
  HTTP (`url`, bearer/OAuth/ChatGPT-session auth), plus `enabled`, `required`,
  `enabled_tools`/`disabled_tools`, per-tool and per-server approval modes, and startup/tool
  timeouts [DOCUMENTED] [src: mcp].
- Desktop UX: Settings > MCP servers > Add server > Restart; `/mcp` in the composer lists
  connected servers. CLI UX: `codex mcp add|list|login`; `/mcp` in the TUI. IDE UX: gear
  menu > MCP servers > Restart extension. All three edit the same store [DOCUMENTED] [src: mcp].
- Plugin-provided MCP servers are launched from the plugin manifest — user config does not
  set their transport, but can control on/off state and tool policy under
  `plugins.<plugin>.mcp_servers.<server>` keys [DOCUMENTED] [src: mcp] [src: cfg-ref].

muster's 21 MCP tools ride the plugin path: the generated plugin's `.mcp.json` starts the
bundled `runtime/muster-mcp.mjs` server (`scripts/build-codex.mjs:401-403`), and the count
is live-enforced — `doctor --codex` performed a real `initialize` + `tools/list` handshake
returning "21/21 tools" [LIVE-VERIFIED-DECISION-RECORD] [src: build-codex] [src: retriage].

## 7. Skills and custom agents: parity across surfaces

- Skills live under `CODEX_HOME` ("config, auth, logs, sessions, skills") [src: envvars];
  the app-server exposes `skills/list` (per-cwd, cached, `forceReload`), `skills/config/write`
  (enable/disable by path), and `skills/changed` file-watch notifications, with skill paths
  like `~/.codex/skills/<name>/SKILL.md` in the documented examples [DOCUMENTED]
  [src: appserver]. Plugins add bundled skills that "become available when you start a new
  chat or CLI session after installation" [src: plugins].
- Invocation differs by surface: ChatGPT surfaces use `@` mentions for plugins/skills, Codex
  surfaces use `$` mentions [DOCUMENTED] [src: skills-plugins].
- Custom agents: standalone TOML files under `~/.codex/agents/` (personal) or
  `.codex/agents/` (project) — each defines `name`, `description`,
  `developer_instructions`, optional `model`, `model_reasoning_effort`, `sandbox_mode`,
  `mcp_servers`, `skills.config`, `nickname_candidates`. Built-ins are `default`, `worker`,
  `explorer`; a name collision resolves in favor of the custom agent. "The ChatGPT desktop
  app, Codex CLI, and IDE extension can show the nicknames where agent activity appears"
  — i.e. all three surfaces run the same custom-agent registry [DOCUMENTED] [src: subagents].
- Subagent visibility parity: "Subagent activity appears in the ChatGPT desktop app, Codex
  CLI, and the IDE extension"; the CLI adds `/agent` for thread switching; the IDE shows a
  background-agent panel above the composer [DOCUMENTED] [src: subagents].

Reconciling the 74/27/21 surface: the 27 profiles are `.codex/agents/*.toml` /
`$CODEX_HOME/agents/*.toml` files (the documented custom-agent surface shared by all three
local clients), the 74 skills (12 public + 62 internal) and 21 MCP tools ship inside the
plugin that both the desktop marketplace reader and the CLI plugin registry install from the
same `.agents/plugins` catalog. The counts were re-verified three ways against the CLI-side
install (staging tree count, `check-codex.mjs` invariants, live `doctor --codex` +
MCP handshake) and the item ruled still-true [LIVE-VERIFIED-DECISION-RECORD] [src: retriage].
Desktop-side count parity is mechanism-level documented (same registry, same catalog, same
cache) but was not independently re-counted inside the desktop UI during the retriage — the
original item's dual-client criterion was accepted on the strength of the shared-host
documentation plus CLI-side live checks; treat an in-app recount as an open verification
step, not a settled fact [INFERRED] [src: retriage] [src: backlog].

## 8. Session/thread model, plan/task primitives, notifications

- Core model (app-server, shared by rich clients): a Thread is a conversation containing
  Turns; `thread/start|resume|fork|read|list|archive|delete`, SQLite-backed metadata,
  cursor-paginated listing filterable by `cwd`, and `thread/compact/start` for history
  compaction. Turn-level: `turn/start` (can override model, personality, cwd, sandbox
  per-turn), streamed `item/*` events [DOCUMENTED] [src: appserver].
- Plan-adjacent primitives: `thread/goal/set|get|clear` (persisted goals with a `goals`
  feature flag default-on), `collaborationMode/list` presets, `review/start` (built-in
  reviewer emitting review items), and `command/exec` (sandboxed exec outside any thread)
  [DOCUMENTED] [src: appserver] [src: cfg-basic].
- Desktop-side organization: the Projects view mixes ChatGPT projects and local folder
  projects; tasks are the unit of work with pin/rename/archive/search; the CLI deliberately
  has no Projects view (cwd is the project; `/new`, `/resume`, `codex resume`), and the IDE
  treats the open workspace as the project [DOCUMENTED] [src: projects].
- Desktop-only environment primitives: "Local environments are available only in Codex in
  the ChatGPT desktop app" — per-project `.codex` folder config holding worktree setup
  scripts (run automatically when Codex creates a worktree for a new task), quick actions in
  the top bar, an integrated terminal, and built-in Git controls (diff pane with inline
  comments, stage/revert, commit, push, create PR) [DOCUMENTED] [src: localenv]. Scheduled
  tasks and long-running work are likewise app/web workflow features [src: app].
- Notifications: desktop has turn-completion alerts (never / background-only / always) plus
  separate permission/question toggles and the floating "pet" status companion
  (Running / Needs input / Ready / Blocked); web has push/email/SMS categories; the CLI
  emits TUI notifications and can run an external `notify` program; the IDE has no separate
  controls and inherits `notify` from the connected Codex host [DOCUMENTED] [src: notif].
- Hooks fire at the same lifecycle points across the host: layered from `~/.codex/hooks.json`,
  inline `[hooks]` in user `config.toml`, `<repo>/.codex/hooks.json`, and project config
  (trusted only), plus plugin-bundled `hooks/hooks.json`; events include `SessionStart`,
  `SubagentStart`, `PreToolUse`, `PostToolUse` [DOCUMENTED] [src: hooks]. muster installs
  its hook groups into `<configDir>/hooks.json` with a runtime under `<configDir>/muster/`
  at both project and user scope (`prepareHooks`, `src/codex-install.js:516-563`), and the
  live doctor run reported both scopes healthy [src: codex-install] [src: retriage].

## 9. Auth and quota metering (the thing that got burned)

- Two sign-in methods on all three local surfaces: Sign in with ChatGPT (browser flow;
  subscription access) or an API key; Codex cloud requires ChatGPT sign-in [DOCUMENTED]
  [src: auth].
- Metering split: "When you sign in with an API key, Codex uses standard API pricing instead
  of included ChatGPT plan credits" [src: auth]. With ChatGPT sign-in, usage draws from the
  plan's shared pool: "The usage limits for local messages and cloud tasks share a five-hour
  window. Additional weekly limits may apply" — with per-model message ranges per plan (Plus:
  Sol 15-90, Terra 20-110, Luna 50-280 per 5h; Pro tiers at 5x/20x) [DOCUMENTED] [src: pricing].
- Desktop vs CLI metering: there is no per-surface quota — desktop Codex turns and CLI turns
  are both "local messages" against the same account pool, and "ChatGPT Work and Codex share
  usage" (Work usage uses the same pricing, credits, and limits as Codex) [DOCUMENTED — no
  surface-level carve-out appears anywhere in the pricing page] [src: pricing]. This is the
  mechanism behind the burn muster's memory records: a heavy desktop/Work session and a CLI
  sprint drain one shared window. Luna's higher ranges are the documented budget lane.
- Mitigations the platform provides: mid-turn grace ("If you reach your usage limits during
  an active turn, the agent will be able to continue working on that turn"), purchasable
  credits, model downshift, and per-account visibility — the usage dashboard at
  chatgpt.com/codex/settings/usage, `/status` in the CLI, and programmatic
  `account/rateLimits/read` + `account/rateLimits/updated` notifications (including
  `planType`) on the app-server API [DOCUMENTED] [src: pricing] [src: appserver].
- Enterprise: Codex access tokens for non-interactive automation with workspace
  entitlements; workspace RBAC/retention applies under ChatGPT sign-in [DOCUMENTED] [src: auth].

## 10. Augmentation-surface table

Every filesystem/API surface a tool like muster can legitimately write or drive, and which
clients it reaches [src: build-plugins] [src: mcp] [src: subagents] [src: hooks] [src: envvars] [src: appserver]:

| Surface | Location / API | Reaches | Notes |
|---|---|---|---|
| Custom agent profiles | `$CODEX_HOME/agents/*.toml` (user), `.codex/agents/*.toml` (project) | Desktop + CLI + IDE | muster's 27 profiles [src: retriage] |
| Repo marketplace | `$REPO_ROOT/.agents/plugins/marketplace.json` | Desktop picker + CLI `/plugins` + IDE | muster's generated catalog [src: build-codex] |
| Personal marketplace | `~/.agents/plugins/marketplace.json` | Desktop + CLI + IDE | per-user curated list |
| Legacy marketplace | `$REPO_ROOT/.claude-plugin/marketplace.json` | Desktop (documented reader) | Claude-plugin compatibility path [src: build-plugins] |
| Plugin bundle | `.codex-plugin/plugin.json` + `skills/` + `.mcp.json` + `hooks/hooks.json` + `.app.json` | All local clients after install + restart | one bundle = skills + MCP + hooks [src: build-plugins] |
| Plugin cache | `~/.codex/plugins/cache/$MARKETPLACE/$PLUGIN/$VERSION/` (`local` for local) | Desktop-documented; host state | loads from cache, not source [src: build-plugins] |
| Shared config | `~/.codex/config.toml` + project `.codex/config.toml` + profiles + `/etc/codex/config.toml` | Desktop + CLI + IDE | model, `[agents]` limits, `[features]`, MCP, plugin on/off [src: cfg-basic] |
| Hooks | `~/.codex/hooks.json`, inline `[hooks]`, `<repo>/.codex/hooks.json`, plugin hooks | Desktop + CLI + IDE (trusted project) | muster writes `<configDir>/hooks.json` [src: hooks] |
| MCP servers | `[mcp_servers.*]` in shared config; `codex mcp add`; desktop/IDE Settings UIs | Desktop + CLI + IDE | plugin-provided servers policy-only [src: mcp] |
| Skills | `$CODEX_HOME/skills/`; `skills/list`, `skills/config/write` (app-server) | Desktop + CLI + IDE | `$`-mention in Codex, `@` in ChatGPT [src: skills-plugins] |
| app-server JSON-RPC | `codex app-server` (stdio/ws/unix): `thread/*`, `turn/*`, `review/start`, `command/exec`, `account/*` | Any embedding client | the rich-client protocol itself [src: appserver] |
| Local environments | project `.codex` folder (setup scripts, actions) | Desktop only | worktree bootstrap + top-bar actions [src: localenv] |
| Agent guidance | `AGENTS.md`, rules | All surfaces | delegation instructions honored by subagents [src: subagents] |
| Notifications | `notify` in user config; desktop settings | CLI + IDE (`notify`); desktop (UI) | `notify` is user-scope only [src: cfg-adv] |

Top three for muster's purposes: (1) the repo/personal marketplace + plugin bundle (one
generated artifact carries skills, MCP tools, and hooks to every local client), (2) the
custom-agent TOML directories (the 27-profile surface, shared verbatim), (3) the shared
`config.toml` (thread limits, model tiering, plugin/MCP policy — the write target for the
re-opened thread-limits item) [src: build-codex] [src: subagents] [src: backlog].

## 11. Desktop-vs-CLI divergence table

| Dimension | ChatGPT desktop app (Codex mode) | Codex CLI | Evidence |
|---|---|---|---|
| Distribution | `Codex.dmg` (macOS), MS Store `9PLM9XGG6VKS` (Windows) | `install.sh`/`install.ps1` to `CODEX_INSTALL_DIR`; package cache in `CODEX_HOME/packages/standalone` | [src: app] [src: winapp] [src: envvars] |
| Config path | Same `CODEX_HOME` layers — but on Windows the app pins `%USERPROFILE%\.codex` while a WSL CLI uses the Linux home (documented non-sharing; `CODEX_HOME=/mnt/c/...` bridge) | `~/.codex/config.toml` + project layers wherever the process runs | [src: mcp] [src: winapp] |
| Plugin install UX | Plugins directory GUI (OpenAI/workspace/personal tabs), workspace sharing, restart-to-apply | `/plugins` browser + `codex plugin marketplace add|list|upgrade|remove`; new session to apply | [src: plugins] [src: build-plugins] |
| Plugin cache | `~/.codex/plugins/cache/$MARKETPLACE/$PLUGIN/$VERSION/`, on/off state in `config.toml` (documented for the app) | Installs the same marketplace entries into host state; cache path documented only on the app page | [src: build-plugins] |
| MCP | Settings > MCP servers GUI; app Restart to apply; `/mcp` list | `codex mcp add/list/login`; `/mcp` in TUI; same `config.toml` store | [src: mcp] |
| Skills/agents parity | Same skills root, same custom-agent TOMLs; subagent activity + nicknames surfaced in-app | Same registry; `/agent` thread switcher; `$`-mentions | [src: subagents] [src: appserver] |
| Project/task primitives | Projects view (ChatGPT + local projects), tasks, worktrees + local environments (setup scripts, actions, Git panel — desktop-only), scheduled tasks | cwd-as-project; `/new`, `/resume`; no Projects view | [src: projects] [src: localenv] |
| Notifications | OS alerts (never/background/always), permission+question toggles, pet companion | TUI notifications + external `notify` program | [src: notif] |
| Quota metering | Same shared plan pool — local messages + cloud tasks in one 5h window; usage dashboard | Same pool; `/status` shows remaining limits; API-key mode bills at API rates | [src: pricing] [src: auth] |
| Windows agent runtime | Defaults to native PowerShell agent + Windows sandbox; switchable to WSL2 agent (restart required) | Runs wherever invoked (native or inside WSL; bubblewrap sandbox on Linux/WSL2) | [src: winapp] [src: wsl] |
| Open source | Not listed as open source (closed shell) | Open source (`openai/codex`), incl. app-server crate | [src: opensource] |

Confirmed divergences that matter for muster: the Windows dual-home split (the one place
"shared config" breaks), the desktop-only local-environment/actions layer, restart-to-apply
vs new-session-to-apply, the desktop-documented plugin cache path, and the GUI-vs-CLI
marketplace management (the CLI commands muster drives are documented as the authoring path,
with "Use the ChatGPT desktop app to install and test a local plugin") [src: build-plugins]
[src: winapp] [src: localenv].

## 12. Sourcing gaps and confidence boundaries

- Desktop internals are thin by design: no public doc describes the desktop app's process
  architecture (whether it embeds app-server in-process, spawns the `codex` binary, or
  bundles its own core build). The shared-`CODEX_HOME`/shared-config claims are documented;
  the "one Rust core behind all local surfaces" reading is [INFERRED] and marked so
  [src: envvars] [src: appserver].
- The official `/codex/changelog` page returned mismatched content in this crawl (a Claude
  Code changelog body under a "Codex changelog" title), so no release-notes citations were
  usable; version claims here (e.g. WSL1 cutoff at 0.115) come from the WSL/Windows pages
  instead [src: wsl] [src: winapp].
- Desktop-side live re-verification of the 74/27/21 counts was not part of the retriage
  (its doctor and MCP handshake run CLI-side); mechanism-level parity is documented, in-app
  recount remains open (section 7) [src: retriage].
- The CLI plugin-cache path is documented only on the desktop-app section of the
  build-plugins page ("How the ChatGPT desktop app uses marketplaces"); whether the CLI uses
  the identical `~/.codex/plugins/cache/` layout is [INFERRED] from the single-host model
  and muster's working `codex plugin add` flow, not separately documented [src: build-plugins]
  [src: codex-install].
- Firecrawl's search endpoint returned empty result sets during this session; coverage was
  achieved via site map + direct scrapes of the official docs tree, so third-party
  corroboration (release blogs, community posts) is absent from this doc's citations.

## Sources

- app: https://developers.openai.com/codex/app (ChatGPT desktop app overview; Codex.dmg download; Chat/Work/Codex modes)
- ide: https://developers.openai.com/codex/ide (Codex IDE extension; openai.chatgpt marketplace id; Xcode/JetBrains integrations)
- cfg-basic: https://developers.openai.com/codex/config-file/config-basic (config.toml layers, precedence, [features] flags, sandbox/approvals)
- cfg-adv: https://developers.openai.com/codex/config-file/config-advanced (config and state locations under CODEX_HOME; project-config restricted keys; profiles)
- cfg-ref: https://developers.openai.com/codex/config-file/config-reference (plugins.<plugin>.mcp_servers.* keys; features.plugin_sharing; marketplaces.allowed_sources)
- envvars: https://developers.openai.com/codex/config-file/environment-variables (CODEX_HOME used by CLI/IDE/app-server/installers; CODEX_INSTALL_DIR; CODEX_API_KEY/ACCESS_TOKEN; RUST_LOG)
- wsl: https://developers.openai.com/codex/windows/wsl (WSL2 agent, bubblewrap/WSL1 cutoff at 0.115, /mnt/c performance, \\wsl$ paths)
- winapp: https://developers.openai.com/codex/windows/windows-app (Windows app; %USERPROFILE%\.codex; WSL non-sharing + CODEX_HOME bridge; native-vs-WSL agent switch; MS Store id)
- plugins: https://developers.openai.com/codex/plugins (plugin anatomy; desktop/web/CLI/IDE install surfaces; restart semantics; permissions)
- build-plugins: https://developers.openai.com/codex/build-plugins (.codex-plugin/plugin.json; marketplace files incl. .agents/plugins and .claude-plugin; plugin cache path ~/.codex/plugins/cache; codex plugin marketplace CLI; workspace sharing)
- skills-plugins: https://developers.openai.com/codex/skills-and-plugins (skills vs plugins; @ vs $ mentions)
- mcp: https://developers.openai.com/codex/extend/mcp (shared MCP config across desktop/CLI/IDE; [mcp_servers.*] schema; plugin-provided MCP; web does not read local config)
- hooks: https://developers.openai.com/codex/hooks (hook layers: ~/.codex/hooks.json, inline [hooks], repo .codex/hooks.json; plugin hooks; SessionStart/SubagentStart/PreToolUse events)
- subagents: https://developers.openai.com/codex/agent-configuration/subagents ([agents] max_threads default 6, max_depth default 1; custom agent TOMLs in ~/.codex/agents and .codex/agents; cross-surface activity display)
- appserver: https://developers.openai.com/codex/app-server (app-server protocol; thread/turn/goal/review/command APIs; skills/list, app/list, account/rateLimits; powers rich clients like the VS Code extension)
- projects: https://developers.openai.com/codex/projects (Projects view desktop; CLI cwd-as-project, /new /resume; IDE workspace-as-project)
- localenv: https://developers.openai.com/codex/environments/local-environment (local environments desktop-only; worktree setup scripts; actions; built-in Git tools)
- notif: https://developers.openai.com/codex/notifications (desktop alert modes + pets; web channels; CLI notify; IDE inherits host notify)
- auth: https://developers.openai.com/codex/auth (ChatGPT vs API-key sign-in on all three local surfaces; plan credits vs API pricing; enterprise access tokens)
- pricing: https://developers.openai.com/codex/pricing (shared local-messages/cloud-tasks 5h window; per-model per-plan ranges; credits; usage dashboard; Sol/Terra/Luna)
- opensource: https://developers.openai.com/codex/open-source (CLI + app-server open source; IDE extension and Codex cloud not; desktop absent from table)
- retriage: docs/decisions/retriage-install-items.md:45-113 (live verification method, counts table at :74-84, recovery commands :88-93, per-item verdicts :112-113, WSL casing tests cited at :112)
- codex-install: src/codex-install.js:23-26,100-144,501-563,578-638,656-774 (CODEX_HOME resolution, canonicalDiskCasing, scope-registry reconciliation, formatCodexWindowsPath, hook install, marketplace registration)
- build-codex: scripts/build-codex.mjs:14-26,283-301,401-433 (drvfs staging rationale, version-idempotent build, .mcp.json + .codex-plugin/plugin.json + marketplace template)
- backlog: .muster/backlog.md:91-92 (codex-desktop-install 74/27/21 + cross-host criteria; codex-install-thread-limits config.toml criteria; file lives in the main checkout at /home/ryan/dev/muster/.muster/backlog.md — untracked, driver-owned)
