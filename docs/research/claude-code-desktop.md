# Research: Claude Code on Desktop and Web — the non-terminal surfaces

Wave-1 research for `harness-internals-research`. Target: Claude Code in the Claude
Desktop app (Code tab) and Claude Code on the web (claude.ai/code) — process
architecture, how the shells drive the same agent loop as the CLI, and every concrete
divergence that matters when muster rides these surfaces. Evidence tags:
`[DOCUMENTED]` = stated in a primary source, `[OBSERVED]` = visible in primary-source
metadata/changelogs but not stated as a design contract, `[INFERRED]` = our reading;
`[GAP]` = the vendor does not document it. Docs were read 2026-07-16 from
code.claude.com (Claude Code docs moved off docs.claude.com to a dedicated host;
the Mintlify-generated tree serves raw markdown at `/docs/en/<page>.md` and an index
at `/docs/llms.txt`) [src: llms-index]. [OBSERVED]

Currency (2026-11-10): §1–§11 were read on 2026-07-16. **§12 refreshes the Code tab
through Desktop v4.23118.1 (2026-11-09, bundled Claude Code 2.1.321)**, covering the new
Code tab, the host-fed plan box, background-only subagents, and "Plugins: not available
in WSL sessions". Where §12 contradicts an earlier section, §12 wins.

## 1. Surface map: one engine, many shells

Anthropic's own framing: "Claude Code runs the same underlying engine everywhere, but
each surface is tuned for a different way of working" — surfaces are CLI, Desktop,
VS Code, JetBrains, Web, and Mobile [src: platforms]. [DOCUMENTED]

The engine's decomposition is documented as three execution environments crossed with
many interfaces: code executes **Local** (your machine), **Cloud** (Anthropic-managed
VMs), or **Remote Control** (your machine, driven from a browser), while "the
interface determines how you see and interact with Claude, but the underlying agentic
loop is identical" [src: how-it-works]. [DOCUMENTED]

Surface-defining capabilities, per the platform matrix [src: platforms]: [DOCUMENTED]

- **CLI**: full feature set, scripting/Agent SDK (CLI-only), third-party providers [src: platforms].
- **Desktop**: diff viewer, app preview, computer use and Dispatch (Pro/Max) [src: platforms].
- **VS Code / JetBrains**: inline diffs, selection sharing, editor integration [src: platforms].
- **Web**: Anthropic-managed cloud; sessions continue after you disconnect [src: platforms].
- **Mobile**: a thin client into cloud sessions, Remote Control into local sessions,
  and Dispatch into Desktop — it hosts no engine of its own [src: platforms].

"Configuration, project memory, and MCP servers are shared across the local surfaces"
— i.e., CLI, Desktop local sessions, and IDE extensions read the same files; the cloud
surface does not (§8) [src: platforms]. [DOCUMENTED]

## 2. Desktop process architecture

### 2.1 The shell

The Claude Desktop app had three tabs — **Chat**, **Cowork** (Dispatch/agentic work),
**Code** — and the Code tab is the Claude Code surface [src: desktop]. [DOCUMENTED]
Since the Unified Claude rollout (release notes 2026-09-16), Chat and Cowork are one
conversation with no mode to choose, and "The model picker and the "Code" tab are where
they were"; plugins reach Chat and Cowork from the claude.ai account, not from
`~/.claude`. Chat and Cowork are covered in
[`claude-cowork.md`](claude-cowork.md). [DOCUMENTED]
Installers are a universal `.dmg` on macOS (MDM-distributable), MSIX on Windows, and
apt/.deb on Linux (beta); device policy lives in the `com.anthropic.claudefordesktop`
macOS preference domain and the `SOFTWARE\Policies\Claude` Windows registry key
[src: desktop] [src: desktop-linux]. [DOCUMENTED]

Two architecture facts the docs state only in passing but which anchor everything:

- **Desktop embeds the engine as an Agent SDK host.** The settings reference says
  "Embedding hosts such as Claude Desktop can supply policy via the SDK
  `managedSettings` option" [src: settings], and the changelog fixes bugs in "SDK
  hosts (e.g. Claude Desktop)" and "SDK and desktop-app sessions" [src: changelog].
  So the Code tab drives the same Claude Code core the CLI wraps, through the Agent
  SDK embedding path rather than by shelling out to a terminal UI. [DOCUMENTED]
- **The UI shell is web-delivered.** "Desktop loads its application code and user
  content from Anthropic CDN hosts" (`*.claude.ai`, `*.claude.com`,
  `*.claudeusercontent.com`, `*.claudemcpcontent.com`, …) over HTTPS/443
  [src: desktop]. The app is therefore a thin native shell around a
  server-delivered web UI plus a local agent runtime. [DOCUMENTED] The docs never
  name the framework (Electron or otherwise) or the IPC protocol between the UI
  layer and the SDK-hosted engine — that boundary is undocumented. [GAP]

Related: the CLI side documents a persistent "background service" plus per-session
processes that enterprises can wrap with `CLAUDE_CODE_PROCESS_WRAPPER` /
`processWrapper` [src: corporate-launcher], and the VS Code extension exposes the
same knob as `claudeCode.claudeProcessWrapper` [src: changelog]. [DOCUMENTED]
Whether Desktop's Code tab spawns the engine through that same service is not
documented. [GAP]

### 2.2 Sessions, worktrees, and the workspace

Each Code-tab conversation is a **session** with its own chat history, project folder,
and code changes; the sidebar runs sessions in parallel [src: desktop]. [DOCUMENTED]
For git repos, every session gets an isolated copy via git worktrees, stored under
`<project-root>/.claude/worktrees/` by default, with a configurable location and an
optional branch prefix; gitignored files can be copied in via `.worktreeinclude`;
sessions can auto-archive when their PR merges or closes [src: desktop]. [DOCUMENTED]
Git is a hard requirement on Windows for the Code tab to start local sessions at all
[src: desktop]. [DOCUMENTED]

Where the CLI's `--worktree` flag is opt-in, Desktop worktree isolation is automatic
per session — the documented CLI↔Desktop feature table calls this out explicitly
[src: desktop]. [DOCUMENTED]

The workspace is pane-based: chat, diff, browser, terminal, file editor, plan, tasks,
and subagent panes in a drag-and-drop layout [src: desktop]. [DOCUMENTED] The
integrated terminal "shares the same environment as Claude" and is local-sessions
only; the file-editor pane is local+SSH only [src: desktop]. [DOCUMENTED]

### 2.3 Execution environments in one shell

A Desktop session picks its environment at start: **Local**, **Remote**
(Anthropic-hosted cloud — the same infrastructure as claude.ai/code, §3), **SSH**
(Desktop auto-installs Claude Code on the remote Linux/macOS host on first connect),
or **WSL** on Windows (the session's Claude Code process, tools, and git all execute
inside the WSL 2 distribution, with per-distribution workspace trust)
[src: desktop] [src: desktop-wsl]. [DOCUMENTED] So "Desktop" is a control plane over
all three engine placements, not a single process model. [INFERRED]

Environment inheritance is a documented sharp edge: launched from Dock/Finder the app
reads your shell profile only to extract `PATH` and a fixed set of Claude Code
variables; other exports are dropped. Desktop adds its own encrypted **local
environment editor** whose variables reach every local session and preview server —
a Desktop-only config store with no CLI equivalent [src: desktop]. [DOCUMENTED]

### 2.4 The browser pane and computer use

The Browser pane previews dev servers (config in `.claude/launch.json`, JSON with
comments, committed to the repo; `autoVerify` on by default makes Claude screenshot,
inspect DOM, click, and fix after every edit) and doubles as a tabbed browser for
external sites with two extra safety layers: safety classifiers on Claude's write
actions in every permission mode, and a per-site allowlist prompt
(Allow once / Always allow / Deny) [src: desktop]. [DOCUMENTED] The changelog shows
the pane is plumbed into the engine as reserved MCP servers — "Claude Preview" and
"Claude Browser" are reserved server names user configs may no longer register
[src: changelog]. [DOCUMENTED] That is the same integration pattern as the IDE `ide`
MCP server (§5): shell capabilities are surfaced to the loop as MCP tools. [INFERRED]

Computer use (research preview, macOS/Windows, Pro/Max only, off by default) gives
the loop screen control with fixed per-app-category tiers: browsers view-only,
terminals/IDEs click-only, everything else full control — explicitly designed to
steer Claude toward the more precise tool (connector > Bash > Chrome > screen)
[src: desktop]. [DOCUMENTED]

### 2.5 Dispatch and notifications

Dispatch is a persistent conversation in the Cowork tab; from your phone it can spawn
Code sessions on your desktop machine (badge in the sidebar, push notification on
finish or approval-needed, computer-use app approvals expiring after 30 minutes
instead of session-lifetime) [src: desktop]. [DOCUMENTED] Desktop also sends OS
notifications when a session finishes while unfocused and when CI completes on a
monitored PR [src: desktop]. [DOCUMENTED] Under Unified Claude, "Dispatch isn't
available to new users. If you already use Dispatch, you can keep using it for now"
(support.claude.com article 16761823, read 2026-11-10). [DOCUMENTED]

## 3. Web architecture (claude.ai/code)

### 3.1 Placement and lifecycle

Claude Code on the web runs tasks on Anthropic-managed cloud infrastructure; sessions
persist when the browser closes and are monitorable from the mobile app. It is in
research preview for Pro/Max/Team and Enterprise premium seats
[src: web]. [DOCUMENTED] Each session gets a **fresh Anthropic-managed VM** with the
repo cloned; approximate ceilings 4 vCPUs / 16 GB RAM / 30 GB disk; setup scripts run
as root on Ubuntu 24.04 [src: web]. [DOCUMENTED] Idle sessions expire and the VM is
reclaimed; reopening provisions a fresh environment with conversation history
restored [src: web]. [DOCUMENTED]

### 3.2 Two proxies form the trust boundary

- **GitHub proxy**: git inside the sandbox holds only a custom scoped credential the
  proxy verifies and translates to your real GitHub token, which "never enters the
  container"; pushes are restricted to the session's working branch; API and
  release-asset requests are limited to repositories attached to the session. When
  no token is set, `GH_TOKEN`/`GITHUB_TOKEN` contain the literal placeholder
  `proxy-injected` and the proxy substitutes real credentials on outbound GitHub
  requests [src: web]. [DOCUMENTED]
- **Security proxy**: all other outbound traffic passes an HTTP/HTTPS proxy providing
  content filtering, rate limiting, and a DNS-level audit trail; per-environment
  access levels are None / Trusted (default allowlist of registries, VCS hosts, cloud
  SDKs) / Full / Custom [src: web]. [DOCUMENTED]

Credential isolation is a stated design property: "sensitive credentials such as git
credentials or signing keys are never inside the sandbox with Claude Code"
[src: web]. [DOCUMENTED] Caveat the docs volunteer: even with network access None,
the engine still talks to the Anthropic API, "which may allow data to exit the VM"
[src: web]. [DOCUMENTED]

### 3.3 What config reaches a cloud session

The rule is clone-or-nothing plus server-side policy: everything in the repo's
`.claude/` (settings, hooks, rules, skills, agents, commands), `CLAUDE.md`, and
`.mcp.json` applies; nothing from `~/.claude/` on your machine does; organization
policy arrives only as server-managed settings fetched from Anthropic at session
start (MDM/managed files on your device don't apply — the VM isn't your device)
[src: web]. [DOCUMENTED] Skills you enable on claude.ai are loaded into cloud
sessions automatically [src: web]. [DOCUMENTED] There is no dedicated secrets store;
environment variables and setup scripts are visible to anyone who can edit the
environment [src: web]. [DOCUMENTED]

Environment provisioning has a documented caching model: the setup script runs once,
the filesystem is snapshotted, and later sessions start from the snapshot; the cache
rebuilds on script/network-config change or after ~7 days; a custom Docker base image
is not supported [src: web]. [DOCUMENTED] `SessionStart` hooks (repo-owned) run on
every start/resume in both local and cloud sessions; `CLAUDE_CODE_REMOTE=true`
distinguishes cloud [src: web]. [DOCUMENTED]

### 3.4 Session traceability

Each cloud session has a claude.ai transcript URL derivable from
`CLAUDE_CODE_REMOTE_SESSION_ID`; since v2.1.179 web-session commits carry a
`Claude-Session: <url>` git trailer and PR bodies embed the session URL
(`attribution.sessionUrl: false` disables both) [src: web]. [DOCUMENTED]

### 3.5 Moving work between surfaces

- CLI → cloud: `claude --cloud "task"` creates a cloud session from the current
  repo's GitHub remote (push first — the VM clones from GitHub, not your disk); a
  git-bundle fallback uploads non-GitHub repos (<100 MB, no push-back)
  [src: web]. [DOCUMENTED]
- Cloud → CLI: `claude --teleport` / `/teleport` / `/tasks`→`t` fetches the session's
  branch and loads the full conversation into the terminal; requires clean git state,
  the same repository, the branch pushed, and the same claude.ai account. Handoff
  from the CLI is one-way — you cannot push an existing terminal session to the web
  [src: web]. [DOCUMENTED]
- Desktop is the exception both directions: **Continue in** sends a local session to
  the web (pushes the branch, generates a conversation summary, creates a cloud
  session with the context; requires a clean tree), and `/desktop` in the CLI moves a
  CLI session into the Desktop app (macOS/Windows, subscription auth only)
  [src: desktop]. [DOCUMENTED]
- `ultraplan` hands a planning task from the CLI to a web session in plan mode, with
  section-level commenting in the browser and a choice to execute remotely or send
  the plan back to the terminal [src: ultraplan]. [DOCUMENTED] **SUPERSEDED
  (§12):** Claude Code 2.1.222 "Removed ultraplan feature"; the ultraplan page now
  says "Anthropic has removed the Ultraplan research preview."

## 4. Shared agent loop, enumerated divergences

The loop itself — gather context / take action / verify, models plus tools, "Claude
Code serves as the agentic harness" — is documented once, surface-independently
[src: how-it-works]. [DOCUMENTED] Error semantics are shared: API-error handling "and
their fixes are the same across the CLI, desktop, and web" [src: desktop].
[DOCUMENTED] The divergences are all at the shell boundary:

| Concern | CLI | Desktop | Web (cloud) |
|---|---|---|---|
| Permission modes | all incl. `dontAsk` (CLI-only) | Manual/Accept edits/Plan/Auto; Bypass behind a Settings toggle (Pro/Max) or org policy | Accept edits/Plan/Auto; no Manual label (edits pre-approved), no Bypass (VM already sandboxed) [src: permission-modes] |
| Mode switching | `Shift+Tab` cycle | mode selector next to send button; per-folder memory overrides `defaultMode` | dropdown on claude.ai; prompts surface in the web UI [src: permission-modes] |
| Plan mode | terminal plan flow | plan pane; Plan choice is session-only, not remembered per folder; since v2.42304.0 a pinned plan box fed by the host's `mcp__ccd_turn__update_plan` (§12.2) | plan mode sessions (ultraplan removed in 2.1.222, §12) [src: ultraplan] |
| Verbosity | `--verbose` flag | Normal/Verbose/Summary transcript view modes (`Ctrl+O`) | web transcript UI [src: desktop] |
| Scripting | `--print`, `--output-format`, Agent SDK | "Not available. Desktop is interactive only." | no headless entry; API trigger only via routines [src: desktop] [src: routines] |
| Terminal-dialog commands | full | `/permissions` replies "isn't available in this environment"; `/config` opens Settings GUI and ignores arguments | `/clear` unavailable; `/model`, `/effort`, `/rename` take argument forms instead of pickers [src: desktop] [src: web] |
| Diff/review | terminal diffs (or IDE viewer via `/ide`) | diff pane with per-line comments, batch submit, "Review code" button | diff view with inline comments sent with the next message [src: desktop] [src: web] |
| File rendering | terminal text | HTML/PDF/image/video paths open in the Browser pane; file paths open in the file-editor pane | no local panes; ask Claude [src: desktop] |
| Session isolation | `--worktree` opt-in | automatic worktree per session | fresh VM + branch per session [src: desktop] [src: web] |
| MCP setup | settings files / `claude mcp` | Connectors UI (local+SSH sessions); plugin-manager UI | connectors chosen per session/routine, injected by the host (§8) [src: desktop] [src: mcp] |
| File attach / @mention | text `@` mentions | drag-drop attachments (images, PDFs); `@` autocomplete local+SSH only | attachments via web composer [src: desktop] |
| Recurring work | cron/CI | Scheduled tasks (local, app must be open) | Routines on Anthropic infra [src: desktop-sched] [src: routines] |
| Agent teams | CLI feature | not in Desktop (dynamic workflows run instead) | off by default; env-flag opt-in [src: desktop] [src: web] |

Desktop's mode-selector labels were renamed (Ask permissions → Manual etc.), and
"default" is now labeled Manual uniformly across CLI/VS Code/JetBrains — mode
*names* converge even where pickers differ [src: changelog]. [DOCUMENTED]

Auto mode is the one loop-level behavior gated by shell+account: it appears only when
requirements are met, uses background safety classifiers, and can be disabled
org-wide via `disableAutoMode` [src: desktop]. [DOCUMENTED]

## 5. IDE integration internals

### 5.1 Two different bridge models

- **VS Code** (also Cursor): the extension is a graphical chat panel that **bundles
  its own private copy of the CLI** — installing it does not put `claude` on PATH;
  the standalone CLI is a separate install. A `useTerminal` setting flips the panel
  to CLI-style [src: vscode]. [DOCUMENTED]
- **JetBrains**: the plugin bundles nothing; it "runs the `claude` command in your
  IDE's integrated terminal and connects to it" — the CLI is the UI, the plugin is
  the bridge [src: jetbrains]. [DOCUMENTED]

### 5.2 The `ide` MCP server is the actual bridge

Both extensions run a local MCP server named `ide` that the CLI auto-connects to;
it is hidden from `/mcp` and is how the CLI opens native diff viewers, reads editor
selection for `@`-mentions, and pulls diagnostics [src: vscode] [src: jetbrains].
Wire format (documented in unusual detail): loopback WebSocket (`ws://`,
VS Code binds `127.0.0.1` on a random port 10000–65535; JetBrains uses an ephemeral
port, optionally all interfaces for WSL2/remote), a fresh per-activation auth token
written to `~/.claude/ide/<port>.lock` (0600 in 0700 dir), presented by the CLI as an
`X-Claude-Code-Ide-Authorization` header [src: vscode] [src: jetbrains]. [DOCUMENTED]

Model-visible tools are deliberately minimal: VS Code exposes
`mcp__ide__getDiagnostics` and `mcp__ide__executeCode` (Jupyter; always confirmed
via a native Quick Pick regardless of hooks); JetBrains exposes only
`getDiagnostics` — everything else on the server is internal RPC for the shell's
own UI, filtered out before the tool list reaches Claude
[src: vscode] [src: jetbrains]. [DOCUMENTED] This is the cleanest documented
statement of the shell/loop contract: shells extend the loop by MCP, and UI-only
RPC is kept off the model's tool list. [INFERRED]

While connected, the CLI attaches the current selection and active-file path to each
prompt (`⧉ Selected N lines…`), and `Read` deny rules suppress that context for
matching files — permission rules govern shell-injected context, not just tools
[src: vscode]. [DOCUMENTED]

### 5.3 Other IDE facts that matter

VS Code can resume claude.ai **cloud** sessions from a Remote tab (download-only;
changes don't sync back), supports third-party providers (Bedrock/Agent
Platform/Foundry) via the shared `~/.claude/settings.json`, and reuses the CLI's
checkpoint/rewind model [src: vscode]. [DOCUMENTED] JetBrains inherits CLI behavior
wholesale (mode switching is literally `Shift+Tab` in the terminal) and needs
firewall/mirrored-networking workarounds under WSL2 because the bridge is a network
socket [src: permission-modes] [src: jetbrains]. [DOCUMENTED]

## 6. Session persistence and resume

- **CLI**: transcripts are local JSONL at `~/.claude/projects/<project>/<session>.jsonl`
  (30-day default cleanup, format explicitly unstable), relocatable with
  `CLAUDE_CONFIG_DIR` [src: sessions] [src: claude-dir]. [DOCUMENTED]
- **Per-surface histories are separate**: "The desktop app, Claude Code on the web,
  and the VS Code extension each maintain their own session history"
  [src: sessions]. [DOCUMENTED] Where Desktop persists Code-tab session state on
  disk is not documented anywhere in the tree. [GAP]
- **Web**: cloud-backed; sessions survive disconnects, are shareable
  (Private/Team on Team/Enterprise, Private/Public on Pro/Max, with optional
  repo-access verification), archivable, and deletable [src: web]. [DOCUMENTED]
- **Remote Control**: local execution, but "while Remote Control is connected, the
  session transcript … is stored on Anthropic servers" to sync devices and survive
  reconnects; the host makes outbound HTTPS only, no inbound ports, short-lived
  scoped credentials [src: remote-control]. [DOCUMENTED]
- **Background/async**: Desktop's tasks pane shows subagents, background shells, and
  dynamic workflows inside a session [src: desktop]; local scheduled tasks fire only
  while the app is open and the machine is awake, whereas routines run on
  Anthropic-managed infrastructure with schedule, API-POST, and GitHub-event
  triggers [src: desktop-sched] [src: routines]. [DOCUMENTED]
- **Push**: mobile push (proactive and action-required variants) rides Remote
  Control/cloud plumbing; Desktop adds OS notifications
  [src: remote-control] [src: desktop]. [DOCUMENTED]
- **Auto-fix PRs** (web): with the Claude GitHub App installed, a session subscribes
  to PR webhooks and reacts to CI failures and review comments; replies post under
  *your* GitHub account labeled as Claude Code — with a documented warning about
  comment-triggered automation (Atlantis etc.) [src: web]. [DOCUMENTED]

## 7. MCP and connectors: the auth-model split

This is the sharpest CLI-vs-managed-surface divergence:

- **CLI-owned servers**: stdio/HTTP/SSE/WebSocket transports, configured in
  `~/.claude.json` (user/local scope) or `.mcp.json` (project scope); OAuth for
  remote servers is performed locally with a browser round-trip [src: mcp].
  [DOCUMENTED]
- **claude.ai connectors**: MCP servers added on claude.ai appear automatically in
  Claude Code — but only while the active auth method is the claude.ai
  subscription; an `ANTHROPIC_API_KEY`, `apiKeyHelper`, or third-party provider
  suppresses them entirely [src: mcp]. [DOCUMENTED] Some Anthropic-hosted connectors
  (Microsoft 365, Gmail, Google Calendar) cannot OAuth locally at all because the
  upstream IdP only accepts claude.ai's registered redirect URL — they must be
  connected in claude.ai Settings → Connectors and then flow down [src: mcp].
  [DOCUMENTED]
- **Org policy on connector tools** is enforced client-side from server state: a
  tool set to `ask` prompts on every call in *every* permission mode including
  bypass; `blocked` tools are filtered before the model sees them (v2.1.129+)
  [src: mcp]. [DOCUMENTED]
- **In cloud sessions the host owns the wiring**: connectors are provisioned by the
  remote host as explicit `--mcp-config` entries with URLs rewritten through the
  session proxy, so client-side `disableClaudeAiConnectors` and URL-pattern denies
  don't apply there; connector traffic routes through Anthropic's servers and needs
  no environment-allowlist entries [src: mcp] [src: web]. [DOCUMENTED]
- **Desktop adds a third config source**: the Code tab loads MCP servers from the
  Chat app's `claude_desktop_config.json` alongside `~/.claude.json` and
  `.mcp.json`; the standalone CLI does not read that file
  (`claude mcp add-from-claude-desktop` imports it on macOS/WSL) [src: desktop]
  [src: mcp]. [DOCUMENTED] Desktop's Connectors UI covers local and SSH sessions
  only — not cloud or WSL sessions [src: desktop]. [DOCUMENTED]
- **Enterprise**: `managedMcpServers` pushes server configs (with per-tool policy
  maps) in third-party Desktop deployments; `allowedMcpServers`/`deniedMcpServers`
  and `allowAllClaudeAiMcps` govern the fleet [src: desktop] [src: settings].
  [DOCUMENTED]

## 8. Artifacts: a native output surface

Artifacts are live, self-contained web pages the session publishes to claude.ai URLs;
the CLI and Desktop both publish (CLI ≥ 2.1.183, Desktop app ≥ 1.13576.0), first
publish is permission-gated, republish updates the same URL with versioning, and
viewers see updates in place [src: artifacts]. [DOCUMENTED] Constraints are strict
CSP (no external requests; inlined assets), no backend, single page, `.html`/`.md`
sources, ≤16 MiB rendered [src: artifacts]. [DOCUMENTED]

The connector bridge makes artifacts an *active* surface: a published page can
declare claude.ai connectors it may call, and every call executes through the
**viewer's** account with per-viewer permission prompts — publisher credentials are
never embedded, and connector-backed pages can't be shared publicly
[src: artifacts]. [DOCUMENTED] Availability is subscription-auth only (no API key,
gateway, Bedrock/Agent Platform/Foundry), excluded under CMEK/HIPAA/ZDR, admin
toggles + role scoping + retention policy + `claude_artifact_*` audit events + a
Compliance API for list/fetch/delete [src: artifacts]. [DOCUMENTED] Kill switches:
`disableArtifact`, `CLAUDE_CODE_DISABLE_ARTIFACT=1`, or a `permissions.deny` rule on
the `Artifact` tool [src: artifacts]. [DOCUMENTED]

## 9. Config topology

| Store | Contents | Which surfaces read it |
|---|---|---|
| `~/.claude/settings.json` | user settings, hooks, env | CLI, Desktop local/SSH-created sessions, VS Code, JetBrains — "Desktop reads the same settings files as the CLI"; **never** cloud sessions [src: desktop] [src: web] |
| `~/.claude.json` | OAuth session, user/local-scope MCP, per-project state, caches | CLI + Desktop + IDE extensions [src: settings] |
| `~/.claude/` app data | transcripts, file-history, plans, shell snapshots, `remote-settings.json` cache | CLI (documented); Desktop/web store history elsewhere [src: claude-dir] [src: sessions] |
| repo `.claude/` + `CLAUDE.md` + `.mcp.json` | project settings, hooks, rules, skills, agents, commands, team MCP | **every** surface including cloud (part of the clone) [src: web] |
| `.claude/settings.local.json` | personal overrides, saved approvals; gitignored | local surfaces; resolved to the repo root across worktrees (v2.1.211+) [src: settings] |
| `claude_desktop_config.json` | Chat-app MCP servers | Desktop (Chat + Code tab) only; CLI must import [src: desktop] |
| Desktop local environment editor | env vars, stored encrypted | Desktop local sessions + preview servers only [src: desktop] |
| Cloud environment config | network level, env vars, setup script | web + Desktop Remote sessions + routines; org-shared variants exist [src: web] |
| Managed settings | policy | delivery differs by placement: disk/MDM + admin-console push for local sessions; **server-managed only** for cloud; SSH sessions read the remote host's file [src: desktop] [src: settings] |

Settings precedence is uniform across CLI/VS Code/JetBrains (managed > CLI args >
local > project > user), with the SDK-host nuance that Desktop-supplied
`managedSettings` are ignored when an admin-deployed managed source exists unless
`parentSettingsBehavior: "merge"` opts in — and even then the embedder can only
tighten policy [src: settings]. [DOCUMENTED]

## 10. Documentation gaps (findings, not failures)

- **Shell internals**: no page documents the Desktop app's UI framework, process
  tree, or UI↔engine IPC; the SDK-host relationship is established only via a
  settings note and changelog phrasing [src: settings] [src: changelog]. [GAP]
- **Desktop data-at-rest**: `~/.claude` application data is documented for the CLI
  only; Desktop Code-tab session storage location, retention, and encryption (beyond
  the "encrypted" env editor) are undocumented [src: claude-dir]. [GAP] Partly
  filled 2026-11-10 (§12.2): a local Windows Code-tab session wrote its transcript to
  `%USERPROFILE%\.claude\projects\<slug>\<session>.jsonl`, the CLI layout, with
  `entrypoint: "claude-desktop"`. [OBSERVED]
- **Web UI internals**: claude.ai/code's client is undocumented; only the VM
  environment, proxies, and lifecycle are specified [src: web]. [GAP]
- **Dispatch internals** live in support-center articles, not the developer docs
  tree [src: desktop]. [GAP]
- **Versioning**: Desktop feature gates cite two different version schemes
  ("Claude Desktop v1.2581.0" for panes, "desktop app version 1.13576.0" for
  artifacts), neither aligned with CLI 2.1.x — no published Desktop changelog maps
  them [src: desktop] [src: artifacts]. [OBSERVED] **RESOLVED (§12):** the Desktop
  changelog at claude.com/docs/cowork/changelog now heads each release with
  "Bundled Claude Code version: 2.1.x" (v4.23118.1, 2026-11-09: 2.1.321), and
  `/status` in a local session shows the Code tab's Claude Code version.
- **No headless Desktop**: scripting/automation is explicitly CLI-only; there is no
  documented programmatic way to drive Desktop or claude.ai/code sessions other
  than routines' API trigger [src: desktop] [src: routines]. [DOCUMENTED]

## 11. Augmentation surfaces for muster

Muster's premise is to ride harness-native primitives and keep only the judgment
layer. The non-terminal surfaces reward exactly one strategy: **put everything in the
repo**, because repo-scoped `.claude/` is the only config plane that reaches every
surface including cloud VMs [src: web]. [DOCUMENTED]

| Native primitive | What it's for | How muster can RIDE it | Advisory vs enforcement line | Desktop/web-specific caveat |
|---|---|---|---|---|
| Repo `.claude/` (skills, agents, commands, rules, hooks, settings) | portable project behavior | ship muster's plugin/skills/gates repo-committed so runs behave identically in CLI, Desktop, and cloud sessions [src: web] | `CLAUDE.md`/rules = advisory; `.claude/settings.json` hooks + permission rules = enforced | user-scope `~/.claude` never reaches cloud; user-enabled plugins must be re-declared in repo settings [src: web] |
| `SessionStart` hooks + `CLAUDE_CODE_REMOTE` | per-session bootstrap everywhere | muster env/bootstrap checks that self-scope to cloud vs local [src: web] | enforcement (blocking hook) | cloud runs them on every start/resume — keep fast; setup scripts (cached) are the right home for slow installs [src: web] |
| Automatic worktrees per Desktop session | parallel-session isolation | muster's worktree conventions align: expect work under `<root>/.claude/worktrees/`, use `.worktreeinclude` for env files [src: desktop] | native behavior, not muster-controllable per session | location is user-configurable in Desktop settings; branch-prefix setting can rename muster-expected branches [src: desktop] |
| `Claude-Session` trailer + session URL env | run-to-transcript traceability | stamp muster receipts/PRs with the session URL; parse trailers to join receipts to transcripts [src: web] | advisory metadata; `attribution.sessionUrl:false` turns it off | web sessions only (v2.1.179+); local sessions need muster to inject equivalents [src: web] |
| `.claude/launch.json` + auto-verify | app preview and self-verification | muster's verify skill can rely on Desktop auto-verify for UI slices and commit launch configs [src: desktop] | advisory (Claude-driven verification) | Desktop-only; CLI/cloud runs need muster's own verify path; `autoVerify` user-toggleable [src: desktop] |
| Scheduled tasks (local) / Routines (cloud) | recurring unattended runs | run `muster runner` as a Desktop scheduled task or a cloud routine with API/GitHub triggers instead of cron [src: routines] | enforcement of cadence is native; task content is advisory prompt | local tasks fire only while the app is open; routines get connectors fixed at creation and fail under org IP-allowlists/ZDR [src: desktop-sched] [src: web] |
| Artifacts | shareable live run output | publish run STATE/receipts/review dashboards as private artifacts; connector-backed boards for live backlog views [src: artifacts] | advisory output; org admin toggles + deny rule are the enforcement side | unavailable on API-key/gateway/3P auth and under ZDR/CMEK/HIPAA; 16 MiB CSP-sandboxed single page [src: artifacts] |
| Diff pane + inline comments + "Review code" | human review gate in shell UI | muster review-gate output can instruct humans to use native diff commenting; complementary, not replaceable [src: desktop] | human-in-the-loop advisory; no API to read/write those comments | Desktop/web UI only — muster can't script it (no headless Desktop) [src: desktop] |
| Permission modes + managed settings | autonomy governance | muster declares required mode per pipeline stage; org managed settings enforce ceilings (`disableBypassPermissionsMode`, `disableAutoMode`) [src: settings] | modes = enforced by harness; muster's stage policy = advisory unless mirrored into permission rules | mode sets differ per surface (no `dontAsk` outside CLI; no bypass in cloud); Desktop remembers mode per folder over `defaultMode` [src: permission-modes] |
| claude.ai connectors + org tool policy | external-tool access with central auth | muster capability-detection should probe `/mcp` state rather than assume `.mcp.json` is the world; respect `ask`/`blocked` verdicts [src: mcp] | org per-tool `ask`/`blocked` is hard enforcement (survives bypass mode) | connectors vanish whenever API-key/gateway auth is active; in cloud they arrive host-injected and client kill-switches don't apply [src: mcp] |
| `--cloud` / `--teleport` / Continue-in | moving work between placements | muster dispositions can offload long runs cloudward and teleport results back into the local review flow [src: web] | advisory workflow | CLI→web is one-way except via Desktop's Continue-in; teleport demands clean tree, pushed branch, same account [src: web] [src: desktop] |
| `ide` MCP bridge pattern | shell capabilities as MCP tools | precedent for muster tooling: expose orchestration state via MCP, keep UI RPC off the model's tool list [src: vscode] | pattern, not a hook point (server name `ide` and `Claude Preview`/`Claude Browser` are reserved) [src: changelog] | loopback `ws://` + lock-file auth; hidden from `/mcp`; PreToolUse hooks still see `mcp__ide__*` calls [src: vscode] |

## 12. Code tab refresh: v2.42304.0 to v4.23118.1 (2026-10-15 to 2026-11-09)

Added 2026-11-10. Sources: the Desktop changelog (raw markdown at
`claude.com/docs/cowork/changelog.md`), and `code.claude.com/docs/en/desktop.md` and
`desktop-wsl.md`, all fetched 2026-11-10. One local Code-tab session transcript was
inspected read-only on 2026-11-10. Quotes are verbatim. Where these sources say
nothing, this section writes "not stated in docs". The CLI-side changes live in
claude-code-cli.md §13. [src: desktop-changelog] [src: desktop] [src: desktop-wsl]

### 12.1 Version map

Each Desktop release now names its bundled engine, which closes the §10 versioning gap:

| Desktop | Date | "Bundled Claude Code version" |
|---|---|---|
| v4.23118.1 | 2026-11-09 | 2.1.321 |
| v4.23118.0 | 2026-11-05 | 2.1.317 |
| v4.16336.0 | 2026-11-03 | 2.1.317 |
| v4.4212.0 | 2026-10-29 | 2.1.309 |
| v4.29.0 | 2026-10-27 | 2.1.309 |
| v3.6556.1 / v3.6556.2 | 2026-10-22 | 2.1.308 |
| v3.1623.4 | 2026-10-22 | 2.1.308 |
| v3.1623.1 | 2026-10-21 | 2.1.304 |
| v3.1623.0 | 2026-10-20 | 2.1.304 |
| v2.42304.0 | 2026-10-15 | 2.1.299 |

desktop.md: "To see which version of Claude Code a session runs, type `/status` in a
local session in the **Code** tab and read the **Claude Code** row". A Desktop session
can therefore trail the CLI by a release or two (2.1.321 bundled vs 2.1.322 latest on
2026-11-10). [DOCUMENTED] [src: desktop-changelog] [src: desktop]

### 12.2 The new Code tab and Claude's plan box

- **First-party, v2.42304.0 (2026-10-15)**, every item marked "(not yet in third-party
  deployments)". It added: "a session rail to the right of the conversation, with cards
  including the session's environment, context, connectors, outputs, changes, servers,
  and background tasks"; environments ("save a folder, SSH host, cloud environment, or
  Remote Control machine"); "nested sessions in local and SSH sessions: Claude can start
  a task in a separate session, which appears under the original session in the
  sidebar and reports back to it"; and "a box at the end of the conversation in local
  and SSH sessions that shows Claude's plan while it works. When a turn ends, the box
  can show a short recap with buttons for what to do next". It also changed `/btw` to
  open a side-chat pane and moved permission requests and questions into the
  conversation. [DOCUMENTED] [src: desktop-changelog]
- **Third-party, v3.1623.0 (2026-10-20)**, under its **3P** heading: "Added the new
  Code tab", "Added to Code tab sessions Claude's plan and a next-step box at the end
  of a turn", nested sessions, and "Changed subagents in Code tab sessions to run in the
  background even when Claude asks for the foreground, so they keep running after Stop;
  Claude can also now start a fork of the conversation as a subagent". [DOCUMENTED]
  [src: desktop-changelog]
- **How the plan box is fed: not stated in docs** (desktop.md does not mention it). The
  inspected transcript answers it. [OBSERVED] [src: desktop-transcript-2026-11-10]
  - The session ran with `entrypoint: "claude-desktop"`, `version: "2.1.321"`, model
    `claude-fable-5-2`.
  - The host injects two MCP servers into the engine. `ccd_turn` carries
    `update_plan` and `wrap_up`; `ccd_session` carries `dismiss_task`,
    `hand_off_to_session`, `mark_chapter` and `read_widget_context`.
  - The model made six `mcp__ccd_turn__update_plan` calls and one
    `mcp__ccd_turn__wrap_up` call. It made no TaskCreate or TodoWrite calls, and the
    tool definitions it received contained no Task tools.
  - `update_plan`'s description opens "Keep the task list the app shows under your
    latest message while you work. Every request that edits files or runs more than one
    command gets one (implement-and-test, investigate-then-fix, anything the user
    listed); only a single-command answer or pure conversation does not." It tells the
    model to send the call "IN THE SAME MESSAGE as another tool call (in parallel), so
    it costs no extra round trip", and adds: "Do not also write the plan as a numbered
    list in your message: the pinned list is the plan."
  - `wrap_up` will "Fill the \"next step\" box the app shows at the end of your turn"
    with a `recap`, an optional `ask` and `actions` buttons, and "also checks off the
    task list".
  - This is the same shell-capabilities-as-MCP pattern as the reserved
    `Claude Preview`/`Claude Browser` servers (§2.4). [INFERRED]
- **Consequence for task tracking.** Claude Code 2.1.268 offers TaskCreate/TodoWrite by
  default only on Opus 4.7, Sonnet 4.6, Haiku 4.5 and earlier (claude-code-cli.md §13.6).
  So on Opus 5.5, Sonnet 5.5 or Fable 5.2, the checklist a Desktop user sees in a local
  or SSH session is this host list, not the engine's task board. It exists only where
  Desktop injects `ccd_turn`. Whether WSL sessions get it is not stated in docs; the
  changelog names local and SSH sessions only. [DOCUMENTED/OBSERVED]

### 12.3 Background work and subagents

- desktop.md: "The tasks pane shows the background work running inside the current
  session: subagents, background shell commands, and dynamic workflows. Once the
  session has background work, open the pane with **Background tasks** in the title
  bar's **⋮** menu." Earlier, v1.12603.1 (2026-06-11): "Added a running-tasks button to
  the activity indicator that opens the Tasks panel". [DOCUMENTED] [src: desktop]
  [src: desktop-changelog]
- Claude Code 2.1.302: "Changed the desktop app and VS Code to always run the main
  conversation's subagents in the background, as the terminal does, rather than let
  Claude choose; a subagent's own Agent calls in `claude -p`, the Agent SDK, the
  desktop app and VS Code now run in the foreground by default". A muster flow that
  dispatches Agent calls in Desktop must therefore expect completion notifications,
  not inline results. [DOCUMENTED/INFERRED] [src: changelog]
- Workflows run in Desktop. docs/workflows: "In the Desktop app, an approval card
  shows the workflow name, the phase list, and a token-usage caution, with **Once**,
  **Always**, and **Deny** actions. The progress view appears in the Background tasks
  side pane." desktop.md, for SSH: "Desktop checks each new workflow before it starts,
  so while Desktop is disconnected a new one waits up to 10 minutes and then fails".
  [DOCUMENTED] [src: desktop]
- v4.16336.0 (2026-11-03): "Fixed local and WSL Code sessions that stopped when the app
  quit or restarted for an update. When you return to one within a day, the app sends
  one automatic message, shown as yours, asking Claude to continue." [DOCUMENTED]
  [src: desktop-changelog]
- Agent teams are still CLI-only. desktop.md: "For multi-agent work inside one session,
  use dynamic workflows, which run in Desktop". [DOCUMENTED] [src: desktop]

### 12.4 Plugins, and their absence in WSL sessions

- desktop-wsl.md, under "What works in a WSL session": "**Plugins**: not available in
  WSL sessions". Same page: the terminal and connectors may also be missing, and with a
  third-party provider "WSL sessions don't get the terminal or connectors". §2.3
  already listed plugins among the WSL gaps, but for muster this is now the gap that
  matters most. A Desktop WSL session loads no plugin skills, commands, hooks, agents
  or workflows, so `/muster:*` does not exist there. [DOCUMENTED] [src: desktop-wsl]
- Plugins do load in local and SSH sessions. desktop.md: "In a local session or an SSH
  session, click **+** next to the prompt box and select **Add plugins**". For SSH,
  Desktop copies them: `~/.claude/remote/plugins/` holds "Plugins that Desktop copies
  from the user's computer". The plugin browser "is not available in cloud sessions,
  and plugins you install from the desktop app aren't available for cloud sessions".
  [DOCUMENTED] [src: desktop]
- v4.23118.0 (2026-11-05): "Added a confirmation before you add, upload or turn on a
  plugin that your organization didn't provide." v3.6556.1 (2026-10-22) fixed
  marketplace-folder plugins "having no Settings tab on their page in Customize, so
  Code tab sessions ran them without the values they ask for". That Settings tab is
  where Desktop keeps plugin `userConfig` values. [DOCUMENTED] [src: desktop-changelog]
- v4.23118.1 (2026-11-09): "Changed tool calls made by a plugin's own code (a mod),
  rather than by Claude, to never show an approval card." [DOCUMENTED]
  [src: desktop-changelog]

### 12.5 Hooks on Windows without Git for Windows

- v2.42304.0 (3P): "Changed what a failed `PreToolUse` hook does on Windows computers
  without Git for Windows: if it sets none of `shell`, `args`, or `onFailure`, it now
  blocks the tool call." [DOCUMENTED] [src: desktop-changelog]
- v4.16336.0: "Changed a `PreToolUse` or `PermissionRequest` hook whose command is only
  a quoted path or string, with no `shell`, `args` or `"onFailure": "continue"`, to
  block calls on PCs without Git for Windows." v4.29.0 does the same for
  `"shell": "powershell"` hooks "unless it sets `args` or `"onFailure": "continue"`".
  [DOCUMENTED] [src: desktop-changelog]
- Claude Code 2.1.299 states the engine side: "Fixed PreToolUse and PermissionRequest
  hooks that set no shell failing open when Git for Windows isn't installed; a guard
  that fails now blocks the call." So a shell-form plugin hook is not fail-open on such
  a PC. Exec form (`args`) runs without a shell. [DOCUMENTED] [src: changelog]

### 12.6 Other Code-tab changes that touch muster

- Worktrees, v4.16336.0: "Claude Desktop no longer runs git's `post-checkout` hook when
  it makes a worktree; Claude Code's own worktrees run none either. `pre-commit` and
  other hooks still run for commits there." v4.23118.1 fixed project "skills, commands
  and agents that a worktree lacks, such as files git does not track, disappearing from
  the menu after Claude entered that worktree". [DOCUMENTED] [src: desktop-changelog]
- Skills and sandbox, v4.23118.1: "Changed skills in a subfolder's `.claude/skills`
  folder to no longer load during a session when Claude Code's sandbox is on."
  [DOCUMENTED] [src: desktop-changelog]
- Cross-session work. desktop.md: "Claude can list your other Code tab sessions, read
  what each has been doing, and send messages between them". It sees "only the sessions
  the desktop app runs itself: local, SSH, and WSL sessions in the Code tab", and "By
  default it sees the 20 most recently active sessions". [DOCUMENTED] [src: desktop]
- Environment passing, v4.29.0: SSH and WSL sessions take most `CLAUDE_*`,
  `ANTHROPIC_*` and `DISABLE_*` "settings, on/off values and numbers" from the
  computer's environment, while "most other text … goes only if saved under
  Environment variables". [DOCUMENTED] [src: desktop-changelog]
- Managed settings: v4.23118.0 added `disableDesktopLocalSessions` ("turns off Code
  sessions that run on the device, WSL included") and `disableWslSessions` (MDM only).
  [DOCUMENTED] [src: desktop-changelog]

### 12.7 Updates to §11 (augmentation surfaces)

| Native primitive | How muster can ride it | Caveat |
|---|---|---|
| Desktop plan box (`mcp__ccd_turn__update_plan` / `wrap_up`) | In a Desktop local or SSH session the host already asks the main thread to keep a pinned step list. muster's run stages (preflight, plan, approval, build, merge, verify) can be those items, so the visible checklist matches the run directory. | Host-specific tool names. Absent in the CLI and cloud sessions; for WSL sessions, not stated. Never required: `muster next --run` stays the record. |
| Background-only subagents | Workflow scripts are unaffected because the script awaits its own agents. The prose fallback must treat Agent results as asynchronous. | Desktop ignores a foreground request. |
| Plugins in WSL sessions | None: muster is unavailable there. Recommend a local or SSH session, or the CLI inside WSL. | Documented limitation; the docs give no workaround. |

## Sources

- llms-index: [Claude Code docs index](https://code.claude.com/docs/llms.txt) — full docs tree; states availability "in the terminal, IDE, desktop app, and browser" and one-line abstracts for every page.
- overview: [Overview](https://code.claude.com/docs/en/overview) — Claude Code is one agentic tool "available in your terminal, IDE, desktop app, and browser".
- platforms: [Platforms and integrations](https://code.claude.com/docs/en/platforms) — "same underlying engine everywhere"; surface capability matrix; config/memory/MCP shared across local surfaces; away-from-terminal comparison (Dispatch, Remote Control, Channels, Slack, scheduled).
- how-it-works: [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works) — agentic loop phases; three execution environments (Local/Cloud/Remote Control); "the underlying agentic loop is identical" across interfaces.
- desktop: [Desktop application](https://code.claude.com/docs/en/desktop) — Code tab reference: sessions/worktrees, panes, Browser pane + safety classifiers, computer use tiers, Dispatch, environments (Local/Remote/SSH/WSL), enterprise managed settings, CDN network requirements, CLI comparison tables, `/desktop`, `claude_desktop_config.json` loading.
- desktop-quickstart: [Get started with the desktop app](https://code.claude.com/docs/en/desktop-quickstart) — Desktop positioning: graphical multi-session UI, "No terminal required".
- desktop-linux: [Claude Desktop on Linux (beta)](https://code.claude.com/docs/en/desktop-linux) — apt/.deb packaging; Chat/Cowork/Code all present; computer use absent on Linux.
- desktop-wsl: [Claude Code Desktop in WSL](https://code.claude.com/docs/en/desktop-wsl) — session's Claude Code process, tools, and git execute inside the WSL 2 distro; per-distro trust; feature gaps (no terminal pane, connectors, plugins).
- desktop-sched: [Desktop scheduled tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks) — local tasks fire only while the app is open and the machine is awake; Routines page creates both local and remote.
- web: [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web) — fresh Anthropic-managed VM per session; GitHub proxy with scoped credentials; security proxy + access levels; setup scripts and environment caching; what config reaches cloud; `--cloud`/`--teleport`; sharing; auto-fix PRs; isolation guarantees; ZDR/IP-allowlist limits.
- web-quickstart: [Get started with Claude Code on the web](https://code.claude.com/docs/en/web-quickstart) — browser/mobile task submission; clone into isolated VM; PR-centric review flow.
- vscode: [Use Claude Code in VS Code](https://code.claude.com/docs/en/vs-code) — extension bundles a private CLI copy; `ide` MCP server transport/auth/tool details; selection context; Remote tab cloud-session resume; third-party providers; extension-vs-CLI feature table.
- jetbrains: [JetBrains IDEs](https://code.claude.com/docs/en/jetbrains) — plugin runs `claude` in the integrated terminal (no bundled CLI); `ide` MCP server with only `getDiagnostics`; WSL2 networking; remote-development host install.
- sessions: [Manage sessions](https://code.claude.com/docs/en/sessions) — desktop, web, and VS Code "each maintain their own session history"; JSONL transcript location and retention; resume/branch semantics.
- claude-dir: [Explore the .claude directory](https://code.claude.com/docs/en/claude-directory) — application data written under `~/.claude`, cleanup rules, plaintext-at-rest warning, file reference table.
- settings: [Claude Code settings](https://code.claude.com/docs/en/settings) — scopes and precedence; managed-settings delivery mechanisms; "embedding hosts such as Claude Desktop can supply policy via the SDK `managedSettings` option"; `parentSettingsBehavior`.
- permission-modes: [Choose a permission mode](https://code.claude.com/docs/en/permission-modes) — per-surface mode-switching tabs (CLI/VS Code/JetBrains/Desktop/Web+mobile); cloud shows Accept edits instead of Manual; `dontAsk` CLI-only.
- mcp: [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp) — transports and scopes; claude.ai connectors auth-gating; org per-tool ask/blocked enforcement; cloud sessions receive connectors as host-injected `--mcp-config` through the session proxy; Claude Desktop import.
- artifacts: [Share session output as artifacts](https://code.claude.com/docs/en/artifacts) — publish/update/share flow; viewer-account connector calls; CSP/page constraints; availability matrix (auth, provider, ZDR); admin controls and Compliance API.
- remote-control: [Remote Control](https://code.claude.com/docs/en/remote-control) — outbound-only HTTPS relay through the Anthropic API; transcript stored server-side while connected; requirements; mobile push setup.
- routines: [Automate work with routines](https://code.claude.com/docs/en/routines) — saved prompt+repos+connectors configurations running on Anthropic-managed cloud with schedule/API/GitHub triggers.
- ultraplan: [Plan in the cloud with ultraplan](https://code.claude.com/docs/en/ultraplan) — CLI hands planning to a web session in plan mode; section-level browser comments; execute remotely or return to terminal.
- corporate-launcher: [Run Claude Code behind a corporate launcher](https://code.claude.com/docs/en/corporate-launcher) — processes started from the Claude Code binary, "including the background service and every agent view session", can be routed through `CLAUDE_CODE_PROCESS_WRAPPER`/`processWrapper`.
- changelog: [Claude Code changelog](https://code.claude.com/docs/en/changelog) — "SDK hosts (e.g. Claude Desktop)"; reserved "Claude Browser"/"Claude Preview" MCP server names for the Desktop pane; VS Code `claudeCode.claudeProcessWrapper`; Manual-mode rename across surfaces; desktop/Remote-Control fixes evidencing shared engine plumbing.
- desktop-changelog: [Claude Desktop changelog](https://claude.com/docs/cowork/changelog), fetched 2026-11-10 as raw markdown (`/docs/cowork/changelog.md`); newest v4.23118.1 (2026-11-09, "Bundled Claude Code version: 2.1.321"); v2.42304.0 new Code tab and plan box; v3.1623.0 3P parity and background subagents; v4.16336.0 / v4.29.0 / v2.42304.0 Windows hook-failure changes.
- desktop-transcript-2026-11-10: read-only inspection of one Desktop Code-tab local session transcript on Windows (`%USERPROFILE%\.claude\projects\<slug>\<session>.jsonl`), 2026-11-10: `entrypoint: "claude-desktop"`, `version: "2.1.321"`, model `claude-fable-5-2`; host MCP servers `ccd_turn` and `ccd_session`; six `update_plan` calls, one `wrap_up`, no Task tools. Project content not reproduced.
