# Research: Unified Claude (Chat + Cowork) on Claude Desktop, and muster's ride

What Chat and Cowork in the Claude Desktop app natively provide as of 2026-11-10, how a
plugin loads there, which muster primitives work on which surface, and what muster's
Desktop distribution (`cowork/`, over the neutral MCP core `mcp/server.mjs`) should do.
The Code tab (Claude Code inside Desktop) is covered in
[`claude-code-desktop.md`](claude-code-desktop.md); this file cites it only where a
Chat/Cowork fact depends on it.

Research rule: primary sources only, quoted verbatim with dates and versions. Where a
source is silent the text says "not stated". Evidence tags:

- **[DOC]**: stated in a primary web source (support.claude.com, claude.com/docs,
  code.claude.com/docs, anthropic.com). Read 2026-11-10.
- **[CHANGELOG]**: the Claude Desktop changelog at claude.com/docs/cowork/changelog,
  quoted with its version and date. Each release has General, Code and Cowork sections
  and then a **3P** section for third-party deployments (Desktop on Bedrock, Vertex,
  Foundry or a gateway). Entries from the 3P section are marked "(3P)": they describe
  the third-party build and its managed configuration, and are evidence for
  first-party behavior only where a first-party source agrees.
- **[OBSERVED]**: read on the owner's machine on 2026-11-10 (Claude Desktop for
  Windows with bundled Claude Code 2.1.321), from Desktop's own files and session
  transcripts. A behavior, not a documented contract.
- **[CODE]**: read from this repository.
- **[INFERRED]**: a judgment from combining sources, flagged as such.

## 0. Headline findings

1. **Chat and Cowork are one product now.** Release notes, 2026-09-16: "We're rolling out
   a new Claude experience that makes everything Claude Cowork does available from any
   conversation" [src: rn] [DOC]; for first-party plans it "is rolling out gradually,
   starting with Pro, Max, and Ultra plans ... On Team plans (in beta) and Enterprise
   plans, it's available where Chat and Cowork unified is turned on" [src: one-claude]
   [DOC]. For third-party deployments, Desktop v2.31226.0 (2026-10-08, 3P) added
   `desktopHome` for "Unified Claude (beta), which combines Chat and Cowork into one
   experience ... (Code is not affected), or leave it out of your configuration to stay
   on the current Chat and Cowork split until November 10, when Unified Claude goes on
   for all orgs" [src: cl] [CHANGELOG].
2. **Cowork runs in the cloud by default.** "On October 6, 2026, new Cowork tasks on Pro,
   Max, and Ultra plans run in the cloud. The Only on your computer option in Settings >
   General was removed" [src: cw-surfaces] [DOC]. And: "Local MCP servers don't run in
   sessions in the cloud" [src: cw-arch] [DOC].
3. **The plugin is the Desktop route.** Plugins install from Customize > Plugins > Add
   marketplace, are attached to the account, and sync to Claude Code. Cowork loads a
   plugin's skills, commands, agents and hooks; Chat loads skills and commands only
   [src: platform] [DOC]. muster's plugin has no top-level `bin/`, so neither surface
   refuses it [CODE].
4. **The Code tab's task panel is driven by an app-injected MCP tool, not TaskCreate.**
   The owner's screenshot session called `mcp__ccd_turn__update_plan`; Desktop's system
   prompt says to "use it in place of Claude Code's own task-list tools (TaskCreate,
   TaskUpdate, TaskList, TaskGet)" [OBSERVED]. The box shipped in v2.42304.0
   (2026-10-15). The Claude Code research track reached the same result independently
   ([`claude-code-desktop.md`](claude-code-desktop.md) §12.2). Cowork's Progress panel,
   by contrast, ran on TaskCreate/TaskUpdate in every local Cowork transcript on the
   machine, Fable 5 included [OBSERVED]. Section 2.2.
5. **Mods run in the Code tab only.** "Mods work in the Claude Code CLI, the Code tab of
   the Claude Desktop app, and the VS Code extension"; not in WSL sessions [src: mods]
   [DOC]. The plugin directory "lists a mod ... for Claude Code" [src: platform] [DOC].
   Section 8.
6. **Desktop WSL sessions load no plugins, so muster is absent there.** "**Plugins**: not
   available in WSL sessions" [src: cc-wsl] [DOC] (finding F7 in
   [`2026-11-claude-code-findings.md`](2026-11-claude-code-findings.md)). The owner has a
   "Muster (WSL)" saved environment [OBSERVED]; `muster doctor --desktop` now warns when
   it finds WSL Code-tab sessions or environments. Use a local or SSH session, or the
   CLI inside WSL.
7. **A plugin `bin/` would cost muster Chat and Cowork.** A top-level `bin/` "makes that
   surface refuse the whole plugin" in both [src: platform] [DOC]. Finding F16 (ship the
   CLI through `plugin/bin/`) must not land as written while the plugin is the Desktop
   route.
8. **Parallel subagents are documented in Cowork; a per-call model override is not.**
   Section 4. This splits muster's old phase-3 probe gate into a documented half and a
   probe-only half.

## 1. What Unified Claude is

"Cowork uses the same agentic architecture that powers Claude Code, accessible within
Claude Desktop without opening the terminal" [src: cw-overview] [DOC].

Timeline [DOC unless tagged]:

- **2026-01-12**: Cowork research preview on Claude Desktop (macOS only) for Max plans:
  "It runs locally on your computer in an isolated VM, enabling direct access to local
  files and MCP integrations" [src: rn].
- **2026-07-07**: "Claude Cowork is now available on web and mobile in addition to
  desktop ... Cowork runs your sessions remotely (in beta) ... scheduled tasks run with
  no device online. Chat and Cowork also share one home now" [src: rn].
- **2026-08-06**, Desktop v1.26832.0 (3P): "Added the merged Chat and Cowork home as the
  default. The "New" button starts a chat or a task from one composer" [src: cl]
  [CHANGELOG].
- **2026-09-16**: "Claude Cowork comes to every conversation ... Your chats, Cowork tasks,
  projects, connectors, and skills carry over. The new experience is rolling out
  gradually to Pro and Max plans on web, desktop, and mobile" [src: rn].
- **2026-10-06**: new Cowork tasks on Pro, Max and Ultra run in the cloud
  [src: cw-surfaces].
- **2026-10-08**, v2.31226.0 (3P): `desktopHome` for Unified Claude; Unified Claude goes
  on for all orgs on November 10 [src: cl] [CHANGELOG].
- **2026-10-29**, v4.4212.0 (3P): "(breaking) Changed an unset `desktopHome` to read as
  `standard` at launches after 12:00 PM PT on November 10, 2026: Unified Claude opens
  with Cowork on, even where `coworkTabEnabled` is `false`" [src: cl] [CHANGELOG].
- **2026-11-03**, v4.16336.0 (3P): "Removed the Chat and Cowork switch from a project's page
  under Unified Claude. A message sent there now starts a Cowork task, or a chat on a
  computer that can't run Cowork" [src: cl] [CHANGELOG].

The merged experience, in the support article's words: "these are merged into a single
conversation, so you don't need to decide which option better suits your task before
getting started ... What you could previously only do in Claude Cowork is available from
any conversation" [src: one-claude] [DOC]. "The model picker and the "Code" tab are where
they were" [src: one-claude] [DOC].

Whether a Unified Claude conversation loads plugin components as "Chat" or as "Cowork"
in the platform-support table (section 3) is **not stated**. The table defines Chat as
"conversations in claude.ai on the web, in the Claude desktop app, and in the mobile
apps" and Cowork as "Cowork tasks in the desktop app" [src: platform]. The project-page
entry above suggests a message becomes a Cowork task where the computer can run Cowork
[INFERRED].

### Execution model: cloud and local sessions

- **Cloud (default)**: "the agent loop and code execution run in an isolated, temporary
  sandbox on Anthropic-managed infrastructure. Each session gets its own sandbox"
  [src: cw-arch] [DOC]. "When a session in the cloud needs something on the user's device,
  like a local file or the browser, the request goes through the Claude Desktop app on
  that device over an Anthropic-brokered connection" [src: cw-arch] [DOC].
- **Local (legacy)**: "Local sessions apply to existing desktop deployments (on Pro, Max,
  and Ultra plans, only tasks and scheduled tasks started on the device before October 6,
  2026)". There "The agent loop runs natively on the device. This includes ... local
  plugin MCP servers", and "Code execution runs in an isolated virtual machine (VM)"
  [src: cw-arch] [DOC].
- **For local work, use the Code tab**: "For new tasks that run only on your computer,
  use Claude Code in the desktop app" [src: cw-surfaces] [DOC].

Cloud Cowork and local files conflict across two articles on MCP servers. The
architecture article: "Local MCP servers don't run in sessions in the cloud"
[src: cw-arch]. The surfaces article lists, under "What requires the desktop app ...
even when your session runs in the cloud": "Local connectors. This includes plugins
using those connectors", and "Local connectors and plugins that include local MCP
servers work through the desktop app only" [src: cw-surfaces]. Both are [DOC]; how a
cloud session reaches a local MCP server, if it does, is **not stated**.

## 2. The base loop

"When you start a task in Cowork, Claude: Analyzes your request and creates a plan.
Breaks complex work into subtasks when needed. Runs code and shell commands in an
isolated environment on Anthropic's servers. Coordinates multiple workstreams in
parallel if appropriate. Delivers finished outputs to your session" [src: cw-start]
[DOC].

Native primitives [DOC, src: cw-start unless noted]:

- **Sub-agent coordination**: "Claude breaks complex work into smaller tasks and
  coordinates parallel workstreams to complete them"; "For complex tasks, Claude may
  coordinate multiple sub-agents working simultaneously".
- **Permission setting**: "If you have the new Claude experience, the permission setting
  in the message box offers Auto (default on Pro, Max, Ultra, and Team plans) and Manual
  (default on Enterprise plans)". The pre-unified Cowork selector also has Skip ("Skip
  all approvals (Skip), formerly "Act without asking.""). No plan mode is documented for
  Chat or Cowork.
- **Deletion protection**: "Claude requires your explicit permission before permanently
  deleting any files".
- **Scheduled tasks**: "Scheduled tasks run remotely, so they run on their cadence even
  when your computer is asleep or the Claude Desktop app is closed" and "have access to
  the same capabilities as regular Cowork tasks, including connected tools, skills, and
  installed plugins" [src: cw-sched]. Creating one, "Claude may ask you questions with
  multiple choice responses" [src: cw-sched].
- **Projects**: "Projects work in every conversation" [src: one-claude]; "From a project
  you can start a chat or a Cowork session, and Claude uses the project's knowledge as
  context" [src: cw-surfaces]. A project has its own instructions, scheduled tasks,
  context and memory [src: cw-projects].
- **Global and folder instructions**: folder instructions "add project-specific context
  to Cowork when you select a local folder on desktop. Claude can also update these on
  its own during a session".

Absent for muster's purposes: no dependency-ordered task graph, wave barrier, review gate
or tournament; nothing in the documented loop validates that a plan was followed. That
is the layer muster's deterministic tools supply [INFERRED].

### 2.1 Progress UI

- Cowork: "Progress indicators show what Claude is doing at each step" [src: cw-start]
  [DOC]. All three changelog entries on it sit in the 3P section: v3.6556.1
  (2026-10-22, 3P) "Fixed Cowork's live list of steps and progress notes showing only
  when a reply began with steps"; v4.16336.0 (2026-11-03, 3P) "In Cowork and Chat,
  Claude's steps and progress notes now sit behind one status row, which opens with a
  click"; v4.23118.1 (2026-11-09, 3P) "Fixed Cowork's Progress panel not ticking steps
  that a subagent marked done" [CHANGELOG]. v1.15962.0 (2026-06-25, General): "Fixed the
  conversation jumping and the Progress panel flashing when opening a completed task"
  [CHANGELOG].
- What drives the Progress panel is **not stated** in any source. Every local Cowork
  transcript on the owner's machine (76 files, last on 2026-10-12, bundled Claude Code up
  to 2.1.295) records TaskCreate (403 calls) and TaskUpdate (667) calls, including
  sessions on `claude-fable-5` [OBSERVED]. Claude Code's tool reference explains why
  Fable gets the tools there: "In background sessions and in cloud sessions, Claude Code
  provides the same tools on every model, listed or not" [src: cc-tools] [DOC]. Whether
  local Cowork counts as one of those, or Desktop opts in, is not stated.

### 2.2 The Code tab's task panel (the owner's screenshot)

The screenshot (model Fable 5.2, effort High, mode Auto) shows "Set up build env and
baseline" running with "1 running task" under it, pending items "Task 1: engine
carry-over" through "Final checks and report", and "3 background commands completed".
Claude Code's changelog says the task tools are off on these models: 2.1.233
(2026-08-14) "Todo/task-tracking tools (TaskCreate/Get/Update/List, TodoWrite) are no
longer available on Opus 4.8, Sonnet 5, Fable 5, Mythos 5, and newer models; set
`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` to bring them back" [src: cc-changelog] [DOC].

The screenshot's session is a local Windows Code-tab session (`entrypoint:
claude-desktop`, Claude Code 2.1.321, model `claude-fable-5-2`, effort `high`)
[OBSERVED]. Its transcript shows:

- The list is written by `mcp__ccd_turn__update_plan`, an MCP server Desktop injects
  into Code-tab sessions. The call that drew the screenshot's list carries
  `{"items": [{"content": "Set up build env and baseline", "status": "in_progress"},
  {"content": "Task 1: engine carry-over", "status": "pending"}, ...]}`; later calls send
  `{"done": [1, 2], "start": 3}` or `{"advance": true}` [OBSERVED].
- Desktop's system prompt for the session has a section "# Task list and wrap-up (this
  app)": "The user follows your progress on a task list the app shows under your latest
  message, not by reading your messages, so keeping it is part of doing the task here.
  `mcp__ccd_turn__update_plan` is that list, and the only one the app shows under your
  message: use it in place of Claude Code's own task-list tools (TaskCreate, TaskUpdate,
  TaskList, TaskGet), and do not search for them" [OBSERVED].
- The same section requires a closing `mcp__ccd_turn__wrap_up` call: "it fills the
  next-step box ... When this turn leaves the user a decision to make or a step to take,
  it also holds one short question ... plus buttons of one to three words that answer
  it" [OBSERVED]. The session's call: `{"recap": ..., "ask": "Build Plan 5B as written,
  with this drill layout?", "actions": [{"label": "Yes, build it"}, {"label": "Change
  something"}], "blocked": true}` [OBSERVED].
- Other app-injected servers named in that prompt: `ccd_session` (`start_session`,
  `hand_off_to_session`, `list_start_targets`, `mark_chapter`, `dismiss_task`),
  `ccd_session_mgmt` (`list_sessions`), `ccd_view` (`show_pane`), `ccd_window`
  (`open_session_in`), plus `ccd_pr` and `ccd_settings` tools [OBSERVED].
- "1 running task" and "3 background commands completed" match the documented tasks
  pane: "The tasks pane shows the background work running inside the current session:
  subagents, background shell commands, and dynamic workflows" [src: cc-desktop] [DOC].
  The session dispatched `Agent` calls ("Implement Task 1: engine carry-over", `model:
  "opus"`) and background Bash [OBSERVED].

The box itself is in the changelog. v2.42304.0 (2026-10-15, Code): "Added a box at the
end of the conversation in local and SSH sessions that shows Claude's plan while it
works. When a turn ends, the box can show a short recap with buttons for what to do next
(not yet in third-party deployments)" [CHANGELOG]. The third-party build got it in
v3.1623.0 (2026-10-20, 3P): "Added to Code tab sessions Claude's plan and a next-step box
at the end of a turn" [CHANGELOG]. The entry names local and SSH sessions, not WSL.

Conclusion: in the Code tab the checklist is the app's own `update_plan` list, kept by
the model because the Desktop system prompt tells it to, and the counts under it come
from the tasks pane. It does not depend on TaskCreate or `CLAUDE_CODE_ENABLE_TODO_TOOLS`
[OBSERVED]. The tool names and the system-prompt text are not in the public docs;
`ccd_turn` is an internal surface that can change without notice. The Claude Code track
read the same transcript and counted six `update_plan` calls, one `wrap_up` call and no
TaskCreate or TodoWrite calls ([`claude-code-desktop.md`](claude-code-desktop.md) §12.2).
Its finding F18 notes that muster's `mcp__.*` hook matcher also fires on these tools.

## 3. Extension surfaces

### 3a. Plugins (the documented route)

Component support, verbatim from the platform-support page [src: platform] [DOC]:

| Component | Chat | Cowork | Claude Code |
| :- | :- | :- | :- |
| Skills (`skills/<name>/SKILL.md`) | Loads | Loads | Loads |
| Commands (`commands/*.md`) | Loads as a skill; Claude applies it when it fits | Loads; you run it by typing `/plugin-name:command` | Loads |
| Agents (`agents/*.md`) | Ignored | Loads | Loads |
| Hooks (`hooks/hooks.json`) | Ignored | Loads | Loads |
| Local MCP server, a command the app starts, including `.mcpb` bundles | Ignored | Loads when the Cowork session runs on your computer | Loads |
| MCP server that references `${user_config.*}` values | Ignored when the URL contains the reference | Ignored when a referenced option has no default; Cowork doesn't prompt for values | Loads; prompts you for the values |
| Executables in a top-level `bin/` directory | Can't be installed | Can't be installed | Loads |
| LSP servers, output styles, themes, `settings` | Ignored | Ignored | Loads |

"A component marked "Ignored" is skipped on that surface, and a component marked "Can't be
installed" makes that surface refuse the whole plugin" [src: platform]. The same page:
"Chat and Cowork read plugins from your claude.ai account, and Claude Code reads them from
the machine it runs on", and an account install "also appears in Claude Code as a synced
plugin at the next session start" [src: platform]. Cowork "doesn't read the Claude Code
CLI's `~/.claude` directory on your machine. To use a skill or plugin that exists only in
`~/.claude`, add it in **Customize**" [src: cw-overview].

Install steps: "On the Plugins page, click "Add," then select "Add marketplace." ... Add
from a repository: Enter a repository URL, or owner/repo for GitHub. Repositories on
github.com work, and so do public repositories on gitlab.com and bitbucket.org"
[src: cw-plugins-help] [DOC]. Sync to Claude Code "needs Claude Code v2.1.273 or later",
happens "once each time Claude Code starts", and is one-way [src: cw-plugins-help] [DOC].
Limits: 200 MB uncompressed, 5,000 files per plugin, 25 marketplaces [src: cw-plugins]
[DOC].

Related Desktop changes [CHANGELOG]:

- v2.2553.0 (2026-09-17, Cowork): "Fixed plugin skills that reference
  `${CLAUDE_PLUGIN_ROOT}` or `${CLAUDE_SKILL_DIR}` sometimes running their commands with
  those paths blank".
- v3.6556.1 (2026-10-22, Cowork): "Fixed Claude not finding your plugins and skills in
  scheduled tasks and other tasks not open on screen, except in third-party deployments".
- v1.24012.9 (2026-07-24, Cowork): "Fixed plugin hooks silently doing nothing on
  Windows".
- Third-party build only: v1.44121.4 (2026-09-02, 3P) "Added support in Chat for skills
  from organization-provided plugins"; v1.52386.0 (2026-09-10, 3P) "Changed hooks from
  organization plugins to also run in Chat, matching Cowork and Code". For first-party
  Chat the table's "Ignored" for hooks stands.
- Hooks on Windows without Git for Windows: v2.42304.0 (2026-10-15, 3P) "(breaking)
  Changed what a failed `PreToolUse` hook does on Windows computers without Git for
  Windows: if it sets none of `shell`, `args`, or `onFailure`, it now blocks the tool
  call ... This includes hooks in plugins" [CHANGELOG]. The engine side applies to
  every build: Claude Code 2.1.299 "Fixed PreToolUse and PermissionRequest hooks that
  set no shell failing open when Git for Windows isn't installed; a guard that fails now
  blocks the call" (quoted in [`claude-code-desktop.md`](claude-code-desktop.md) §12.5).
  muster's `plugin/hooks/hooks.json` sets none of `shell`, `args` or `onFailure`, and
  matches `Bash|PowerShell|mcp__.*` [CODE]. Finding F6 (exec form, explicit
  `onFailure`) covers the fix.

muster's plugin against the table [CODE]: skills (7) and commands (7) load in both
surfaces; agents and the PreToolUse hook load in Cowork only; `output-styles/` is
ignored; `workflows/` has no row (section 6); no `bin/`, no `.mcp.json`, no
`${user_config}`. The plugin's commands call `sh "${CLAUDE_PLUGIN_ROOT}/runtime/muster.sh"`,
which runs `npx -y @adnova-group/muster@<version>` outside a source checkout. Whether
`sh`, `node` and `npx` with registry access exist in the Cowork sandbox is **not
stated**; enterprise cloud sessions default to "No network access" [src: cw-arch].

On disk, Desktop keeps the account plugin list at
`%APPDATA%\Claude\plugin-list\<org>\<account>\plugins.json`, entries
`{id, name, enabled, installPath}`, with installs under `%APPDATA%\Claude\rpm\` [OBSERVED].
`muster doctor --desktop` and `capabilities --cowork` read it (section 5).

### 3b. Local MCP servers (`claude_desktop_config.json`)

The fallback route: muster's `cowork/mcp-server.mjs` registered under `mcpServers`.
Code-tab docs: "A server you define in `claude_desktop_config.json` is available in both
the Desktop chat surface and local Code tab sessions" [src: cc-desktop] [DOC]. Local
Cowork sessions run local plugin MCP servers on the device [src: cw-arch]; cloud sessions
do not (section 1). Admins can turn local servers off: "Set isLocalDevMcpEnabled to false
to disable plugin-bundled and locally configured MCP servers" [src: cw-arch] [DOC].

### 3c. MCPB desktop extensions

`.mcpb` bundles are a local-MCP-server variant ("Local MCP server, a command the app
starts, including `.mcpb` bundles" [src: platform]). muster's development MCPB
descriptor (`cowork/manifest.json`, "Route B") is retired: plugins replace it, and
"Cowork doesn't prompt for values" a `${user_config}` field would need [src: platform].

### 3d. Remote connectors

"In Cowork, connectors reach external services through Anthropic's cloud, not through
your local network" [src: cw-plugins-help] [DOC]. "Connector authorization tokens never
enter the sandbox; connector calls are made on the server side" [src: cw-arch] [DOC].
Connector state lives in the account, not on disk, so muster still treats connectors as
DECLARED (`MUSTER_COWORK_CONNECTORS`) [CODE].

## 4. Subagent dispatch and model override

- **Parallel subagents: documented.** "Sub-agent coordination — Complex work gets divided
  into smaller tasks with parallel workstreams for faster results" [src: cw-overview];
  "Claude may coordinate multiple sub-agents working simultaneously" [src: cw-start];
  plugin agents load in Cowork [src: platform]. All [DOC]. muster therefore needs no
  probe before letting dependency-free wave members fan out in Cowork.
- **Per-call model override: not documented.** No source describes choosing a model per
  sub-agent in Chat or Cowork. Desktop v1.17377.1 (2026-06-30, 3P) "Fixed subagents
  failing with an invalid model error on third-party inference providers" [CHANGELOG]
  shows that subagents carry a model, not that a caller can pick it. muster keeps the phase-3 probe
  (`scripts/cowork-probe.mjs`) as the instrument: a per-call model override needs a
  fresh successful phase-3 receipt from the active Cowork build. Until then each role's
  `claudeModel` is advisory in Cowork, and `capabilities --cowork` says so in its
  `dispatch` block [CODE].
- In the Code tab both are normal Claude Code behavior; the screenshot session passed
  `model: "opus"` on its `Agent` calls [OBSERVED].

There is still no dispatch API: an MCP server cannot spawn Cowork sub-agents. In the
plugin-less fallback, muster steers dispatch by prompt from its MCP `instructions`, with
sequential `muster_next` as the verified default driver when no subagent tool is
available [CODE].

## 5. Config topology and `muster doctor --desktop`

- **Config dirs** [CODE + OBSERVED]: macOS `~/Library/Application Support/Claude`;
  Windows `%APPDATA%\Claude`, and for the MSIX package
  `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude`. On the owner's machine
  the MSIX package `Claude_pzs8sxrjxfjjc` exists but has no `LocalCache\Roaming\Claude`,
  and the app reads and writes `%APPDATA%\Claude` [OBSERVED].
- **Logs**: `%LOCALAPPDATA%\Claude\Logs`, with one `mcp-server-<name>.log` per local MCP
  server (`mcp-server-muster.log` present) [OBSERVED].
- **Account plugin list**: section 3a [OBSERVED].
- **Admin plane**: `isLocalDevMcpEnabled` and `isDesktopExtensionEnabled` are MDM keys
  on every build [src: cw-arch]. `allowedPluginMarketplaces`,
  `userPluginMarketplacesEnabled` and related keys are third-party configuration
  (v1.37937.0, 2026-08-25, 3P: "Added
  `userPluginMarketplacesEnabled` and `userPluginUploadsEnabled`, which control whether
  members can add their own plugin marketplaces and upload their own plugins")
  [CHANGELOG].

`muster doctor --desktop` (read-only; it never edits Desktop config) reports each config
dir it finds, from WSL through `/mnt/c/Users/*/AppData/...`; each `mcpServers` entry
that launches muster, with the checkout's package version, git HEAD, commits behind this
CLI's checkout, and uncommitted changes; whether muster is in the account plugin list;
and the log dir [CODE].

## 6. Primitive matrix: which muster primitive works where

Columns: Code tab (local session, not WSL), Chat, Cowork local (tasks started on the
device before 2026-10-06, or third-party/enterprise local deployments), Cowork cloud.

| Primitive | Code tab | Chat | Cowork local | Cowork cloud |
| :- | :- | :- | :- | :- |
| Skills (`/muster:*` skills) | Yes [DOC] | Yes [DOC] | Yes [DOC] | Yes [DOC] |
| Commands (`plugin/commands/*.md`) | Yes [DOC] | As skills, applied when they fit [DOC] | Yes, `/muster:<command>` [DOC] | Yes [DOC] |
| Agent subagents (plugin agents) | Yes, with per-call `model` [DOC, OBSERVED] | Ignored [DOC] | Yes; per-call model not stated | Yes; per-call model not stated |
| Workflow tool (`plugin/workflows/*.js`) | Yes: "Workflows are available in the CLI, the Desktop app, the IDE extensions" [src: cc-workflows] | Not stated | Dynamic workflows exist (v1.15962.0 one-time workflow prompt, Cowork section [CHANGELOG]); plugin workflows not stated | Not stated |
| Hooks (`plugin/hooks/hooks.json`) | Yes [DOC] | Ignored [DOC]; org plugins' hooks run in 3P builds [CHANGELOG] | Yes; which events fire not stated | Yes; which events fire not stated |
| MCP: local `cowork/mcp-server.mjs` | Yes, via `claude_desktop_config.json` [DOC] | Yes, via `claude_desktop_config.json` [DOC] | Yes [DOC] | No per [src: cw-arch]; conflicting wording in [src: cw-surfaces] |
| AskUserQuestion | Yes [OBSERVED] | Not stated | Yes [OBSERVED]; multiple-choice questions documented for scheduled tasks [DOC] | Not stated |
| Plan mode / ExitPlanMode | Yes, with the Plan pane [DOC] | No plan mode documented | No plan mode documented | No plan mode documented |
| Task list | `mcp__ccd_turn__update_plan` [OBSERVED] | Status row (3P entry) [CHANGELOG] | TaskCreate/TaskUpdate [OBSERVED] | Not observed |
| Mods | Yes, except WSL sessions [DOC] | No (directory lists mods for Claude Code) [DOC] | Not stated | Not stated |
| `runtime/muster.sh` (`sh` + `npx`) | Yes | Not stated | Not stated | Not stated |

WSL sessions in the Code tab are a separate column in practice: "Plugins aren't available
in WSL sessions" [src: cc-desktop], and mods' hooks don't run there "because plugins
aren't available in WSL sessions" [src: mods] [DOC]. muster in a WSL Code-tab session
gets none of its plugin. A Code-tab SSH session supports plugins ("In a local session or
an SSH session, click **+** next to the prompt box and select **Add plugins**"
[src: cc-desktop]) [DOC].

Consequence for muster [INFERRED]: the software lifecycle (branches, worktrees,
`merge-wave`, Workflow fan-out) belongs in the Code tab or the CLI. In Chat and Cowork
the plugin's skills and commands load, but its git and `npx` steps depend on a sandbox
whose toolchain is not documented, and cloud sessions see local files only through the
desktop app's folder bridge. Non-code pipelines (content, product, business) fit Cowork.

## 7. Plan and approval primitive

- **Code tab**: Plan mode, "Claude reads files and runs commands to explore, then proposes
  a plan without editing your source code" [src: cc-desktop] [DOC]; v1.40609.0 (Code)
  (2026-08-27): "the Plan pane now accepts comments in Plan mode or while Claude is asking
  you to approve the plan" [CHANGELOG]. Same ExitPlanMode as the CLI, so
  `resolvePlanSurface("claude-desktop")` returns the native surface [CODE]. The
  `wrap_up` next-step box (section 2.2) also renders question buttons, but it is an
  undocumented app surface; muster does not target it.
- **Chat and Cowork**: the permission setting offers Auto and Manual (Skip in the
  pre-unified selector) [src: cw-start]; no plan mode is documented. AskUserQuestion is
  observed in local Cowork transcripts, and scheduled-task creation asks "questions with
  multiple choice responses" [src: cw-sched]. `resolvePlanSurface("cowork")` returns the
  prose plan with an AskUserQuestion approval [CODE].

## 8. Desktop features since July 2026 that matter to muster

- **Mods** (Claude Code 2.1.287, 2026-10-01: "Added Claude Mods: plugins may now modify
  deeper behavior" [src: cc-changelog]). "A mod is a plugin that changes how Claude Code
  looks and behaves. It's made of JavaScript or TypeScript event handlers" [src: mods].
  A plugin ships one by naming "code a plugin names under `modules` in
  `hooks/hooks.json`" [src: platform]. Where: CLI, the Code tab "except in a WSL
  session", VS Code; hooks but no drawing in `claude -p` and cloud sessions [src: mods].
  Mod vs settings hook: "Pick it when ... You want a pane, a band above the prompt, a
  custom command, or to rewrite an event" versus "You want to block, allow, or log an
  event with a script you already have" [src: mods]. The Desktop changelog v4.23118.1
  (2026-11-09, 3P): "Changed tool calls made by a plugin's own code (a mod), rather than
  by Claude, to never show an approval card" [CHANGELOG]; whether mods run in Cowork is
  not stated. Design note:
  [`docs/strategy/desktop-run-pane-mod.md`](../strategy/desktop-run-pane-mod.md).
- **Task/progress UI**: section 2.
- **Scheduled tasks**: Cowork's run in the cloud with skills and plugins [src: cw-sched];
  the Code tab has local tasks that fire "only ... while the app is open and your computer
  is awake" plus cloud tasks [src: cc-sched] [DOC].
- **Subagents in Cowork**: section 4.
- **Projects starting Cowork tasks**: v4.16336.0 (3P), section 1 [CHANGELOG]; for first-party plans "From a project you can start a chat or a Cowork session" [src: cw-surfaces]. Code-tab Projects
  are a separate beta: "one ongoing conversation where Claude coordinates a stream of
  related work", threads usually cloud sessions, "Projects aren't offered on Team or
  Enterprise plans yet" [src: cc-projects] [DOC].
- **Dispatch and computer use**: "Dispatch isn't available to new users. If you already
  use Dispatch, you can keep using it for now" [src: one-claude] [DOC]. Dispatch "runs
  your tasks on your desktop ... Development tasks run in Claude Code; knowledge work runs
  in Cowork" [src: cw-dispatch]. Computer use is "In beta on Pro, Max, and Ultra plans"
  [src: one-claude] [DOC].
- **Artifacts and Claude Docs**: 2026-09-16, "You can now ask for a design, deck, or
  document in any conversation with Claude, including in Claude Code and the Artifacts
  tab ... Claude Docs is a new way to write living documents with Claude and your team"
  [src: rn] [DOC].
- **Remote Control**: a Code-tab local session "shows up on your other devices once Remote
  Control connects it" [src: cc-desktop]; mods' hooks still run "in the session on your
  machine" [src: mods] [DOC].
- **Background sessions**: v2.110.0 (2026-09-15, Code) "Changed SSH and WSL sessions to
  keep running when left idle in the background"; v4.16336.0 (3P) restarts local and WSL
  Code sessions after an app restart "within a day" with one automatic message
  [CHANGELOG].
  Cowork cloud work "keep[s] running in the cloud even if you close your laptop"
  [src: one-claude].
- **Plan mode in the Code tab**: section 7.
- **Models**: "Introducing Claude Fable 5.2 and Claude Mythos 5.2", Nov 9, 2026
  [src: news] [DOC], which matches the owner's Desktop picker and the screenshot
  session's `claude-fable-5-2` [OBSERVED]. Third-party builds: v4.23118.1 (2026-11-09,
  3P) "Changed `fable` in `inferenceModels` to request the newest Fable model"; v1.17377.2
  (2026-07-01, 3P) "Added Claude Fable 5 to the model picker for organizations with
  access" [CHANGELOG].

## 9. Anatomy of muster's ride

What ships [CODE]:

- **Primary route, the plugin.** `.claude-plugin/marketplace.json` lists `muster` with
  source `./plugin`. In Desktop: Customize > Plugins > Add marketplace >
  `Adnova-Group/muster`, then install `muster`. It syncs to Claude Code.
- **Fallback route, the MCP server.** One neutral MCP core, `mcp/server.mjs`
  (newline-delimited JSON-RPC 2.0 over stdio, node builtins only), wraps the CLI as a
  30-tool MCP server: 29 CLI-wrapper tools plus `muster_sprint_protocol`.
  `cowork/mcp-server.mjs` is the Cowork adapter (`runtimeIdentity: "cowork"`);
  `mcp/codex-server.mjs` and `mcp/chatgpt-work-server.mjs` are the other host adapters,
  and `cowork/chatgpt-work-server.mjs` is a compatibility shim. `build-codex.mjs` builds
  the Codex and Work adapters directly; it no longer string-rewrites
  `cowork/mcp-server.mjs`.
- **Instructions are a fallback.** The Cowork adapter's MCP `instructions` now say: if
  `/muster:*` skills are present, use them and treat the tools as their deterministic
  backend; otherwise drive the fallback protocol. Parallel subagents are allowed
  (documented); per-call model override needs a phase-3 receipt; sequential
  `muster_next` remains the default when no subagent tool is available.
- **Capability resolution.** `capabilities --cowork` reads `claude_desktop_config.json`,
  `Claude Extensions/` and the account plugin list. A declaration (`--native-plugin`,
  `--plugin-less`, `MUSTER_COWORK_NATIVE_PLUGIN`) wins; then the plugin list (muster
  present and enabled: builtins resolve as on Claude Code; list readable without muster:
  MCP servers plus inline); with no readable list the plugin route is assumed. Installed
  non-MCP providers from `~/.claude` never resolve in Cowork, which does not read it. The
  output carries a `dispatch` block: `pluginLoad`, `parallelSubagents: "documented"`,
  and `perCallModelOverride` marked as requiring a phase-3 probe receipt.
- **Sprint playbook as a tool.** `muster_sprint_protocol` serves
  `cowork/sprint-protocol.md`. Without a proven native per-subagent worktree primitive,
  the orchestrator creates a dedicated isolated Git worktree for each write-capable item
  and executes those implementations sequentially in their assigned worktrees; the
  main tree is the coordination and ordered-integration surface. Claim/receipt discipline
  is done by hand, and `pr`/`keep` dispositions are preferred.

## 10. Augmentation table

| Native surface | What it gives | muster's use |
| :- | :- | :- |
| Account plugins (Customize) | Skills, commands, agents, hooks in Cowork; skills and commands in Chat | Primary Desktop route |
| Sub-agent coordination | Parallel workstreams | Wave fan-out without a probe |
| Per-call model override | Not documented | Advisory `claudeModel`; phase-3 probe gates it |
| Local MCP servers | Deterministic tools in Code tab, Chat, local Cowork | Plugin-less fallback; deterministic backend |
| Code-tab `ccd_turn` task list | Checklist under the latest message | Observed only; not targeted |
| Mods | Panes, bands, commands, in-process tool rules in the Code tab | Candidate run-progress pane (design note) |
| Scheduled tasks | Cloud runs with plugins | Candidate home for the unattended runner |
| AskUserQuestion | Selection UI | Approval in the fallback and in plan-surface |

## 11. Gaps and confidence

- Which hook events fire in Cowork: not stated. Check by hand.
- Whether `sh`/`node`/`npx` resolve in the Cowork sandbox: not stated. Check by hand.
- Whether plugin `workflows/` load in Cowork or Chat: not stated.
- How a cloud session reaches a local MCP server: the two support articles conflict
  (section 1).
- Whether a Unified Claude conversation loads plugins as Chat or as Cowork: not stated.
- What drives Cowork's Progress panel: not stated; TaskCreate/TaskUpdate observed.
- The `ccd_turn` tools and the `plugin-list/` file are undocumented app internals; muster
  reads the plugin list (read-only, with a declared override) and does not call
  `ccd_turn`.
- Older claims this file used to make, now retired: "Cowork has no plugin, skill,
  slash-command, or hook primitives" (stale since the 2026 plugin launch), and the
  MCP-only default in `capabilities --cowork`.

## Sources

- rn: https://support.claude.com/en/articles/12138966-release-notes (read 2026-11-10)
- one-claude: https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude
- cw-surfaces: https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile
- cw-arch: https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview
- cw-start: https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork
- cw-sched: https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork
- cw-projects: https://support.claude.com/en/articles/14116274-organize-your-tasks-with-projects-in-claude-cowork
- cw-dispatch: https://support.claude.com/en/articles/13947068-assign-tasks-from-anywhere-in-claude-cowork
- cw-plugins-help: https://support.claude.com/en/articles/13837440 (Use plugins in Claude)
- cl: https://claude.com/docs/cowork/changelog (Claude Desktop changelog; latest entry v4.23118.1, 2026-11-09, bundled Claude Code 2.1.321)
- cw-overview: https://claude.com/docs/cowork/overview.md
- cw-plugins: https://claude.com/docs/cowork/guide/plugins.md
- platform: https://claude.com/docs/plugins/platform-support.md
- plugins-build: https://claude.com/docs/plugins/build.md
- cc-desktop: https://code.claude.com/docs/en/desktop.md
- cc-wsl: https://code.claude.com/docs/en/desktop-wsl.md
- cc-sched: https://code.claude.com/docs/en/desktop-scheduled-tasks.md
- cc-projects: https://code.claude.com/docs/en/claude-projects.md
- cc-workflows: https://code.claude.com/docs/en/workflows.md
- cc-tools: https://code.claude.com/docs/en/tools-reference.md (Task tool availability)
- cc-changelog: https://code.claude.com/docs/en/changelog.md (2.1.233, 2.1.268, 2.1.287)
- mods: https://code.claude.com/docs/en/plugins/mods/overview.md and reference.md
- news: https://www.anthropic.com/news (Nov 9, 2026 entry) and https://www.anthropic.com/claude-fable-and-mythos-5-2
- Observed: `%APPDATA%\Claude\` (config, `plugin-list\`, `local-agent-mode-sessions\`),
  `%LOCALAPPDATA%\Claude\Logs\`, and the Code-tab transcript
  `%USERPROFILE%\.claude\projects\<project>\<session>.jsonl` of the screenshot session,
  all read 2026-11-10 on the owner's Windows machine.
- Code: `cowork/mcp-server.mjs`, `mcp/server.mjs`, `src/harness.js`,
  `src/capabilities.js`, `src/plan-surface.js`, `src/doctor.js`,
  `plugin/runtime/muster.sh`, `plugin/hooks/hooks.json`, `scripts/cowork-probe.mjs`.
