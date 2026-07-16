# Research: Claude Cowork — base loop, extension surfaces, and muster's ride

Input for harness-internals work: what Claude Cowork natively provides, how its naked base
loop runs, which extension surfaces exist, and — reconciled line-by-line against muster's
shipping Cowork port (`cowork/`) — what muster rides today, where the port's assumptions
have gone stale, and what is still unexploited.

Evidence tags used throughout: **[DOCUMENTED-WEB]** = stated in a primary web source;
**[CODE-VERIFIED]** = read directly from this repo's shipping adapter code (a primary
source here, since the adapter was built against the live product and its probe results);
**[INFERRED]** = judgment call from combining sources, flagged as such.

Headline reconciliation finding, up front: muster's adapter was written against
January-2026 Cowork and asserts "Cowork extends only through MCP and MCPB desktop
extensions. It has no plugin, skill, slash-command, or hook primitives" [src: readme-5].
As of mid-2026 that premise is **stale in both directions**: Cowork gained a plugin system
that bundles skills, connectors, hooks, and sub-agents [src: cw-plugins] [DOCUMENTED-WEB],
while the local-MCP-server surface muster's Route A install rides is now
documented inconsistently — one official article says config-file local servers "aren't
available in Cowork" at all [src: cw-connectors] [DOCUMENTED-WEB]. Both shifts are
detailed in sections 3 and 8.

## 1. What Cowork is

Claude Cowork is Anthropic's agentic product for general knowledge work: "Claude Cowork
uses the same agentic architecture that powers Claude Code, with no terminal required"
[src: cw-start] [DOCUMENTED-WEB]. It launched January 12, 2026 as a research preview for
Max subscribers on the macOS desktop app [src: vb-launch] [DOCUMENTED-WEB]; Anthropic's
Labs announcement lists it alongside Claude Code, MCP, and Skills as a Labs-incubated
product [src: labs] [DOCUMENTED-WEB]. Launch coverage framed it as a file-managing
general-purpose agent squarely aimed at non-coding work [src: fortune] [DOCUMENTED-WEB];
by July 2026 Anthropic reported that more than 90% of Cowork usage was not software
development, with business operations and content creation the largest categories
[src: blog-webmobile] [DOCUMENTED-WEB].

Timeline that matters for reconciling muster's port [DOCUMENTED-WEB]:

- **Jan 12, 2026** — desktop-only research preview, Max plan, macOS first
  [src: vb-launch]. This is the Cowork that muster's adapter comments describe.
- **~May 2026** — plugins arrive: skills, connectors, hooks, sub-agents bundled per
  plugin, installable in chat and Cowork [src: cw-plugins].
- **Jul 7, 2026** — web and mobile rollout; **sessions run remotely by default** (beta),
  the agent loop moves to Anthropic-managed sandboxes, scheduled tasks run with no
  device online [src: blog-webmobile] [src: newstack].

### Execution model: two session architectures

Cowork now has two distinct execution architectures, and which one a session uses
changes what integration surfaces exist [src: cw-arch] [DOCUMENTED-WEB]:

- **Remote sessions (the new default, beta):** "the agent loop and code execution run in
  an isolated, temporary sandbox on Anthropic-managed infrastructure," one sandbox per
  session, destroyed at session end. Egress goes through a mandatory allow-list proxy
  outside the sandbox; the sandbox holds only short-lived session-scoped tokens;
  "Connector authorization tokens never enter the sandbox; connector calls are made on
  the server side." Device access (local files, browser) is brokered through the Claude
  Desktop app over an Anthropic-brokered connection, limited to connected folders, and
  unavailable when the app is offline [src: cw-arch].
- **Local sessions (existing desktop deployments):** "The agent loop runs natively on
  the device," covering conversation handling, file reads/writes in connected folders,
  web fetches, "and local plugin MCP servers." Code execution runs in a dedicated Linux
  VM isolated by the platform hypervisor (Apple Virtualization.framework on macOS,
  Hyper-V on Windows), with its own egress filtering and syscall restrictions
  [src: cw-arch].

Muster's adapter documents exactly the local architecture: "Cowork runs the local MCP
server natively on the device (the agent loop)" [src: readme-5] and "The CLI runs in
Cowork's Linux VM" is the server's own framing of where spawned work lands
[src: mcps-head] [CODE-VERIFIED]. Note the wrinkle: the MCP server is launched by the
host-native agent loop (host Node, host PATH — the README requires host Node 20+
explicitly [src: readme-42]), not inside the code-execution VM; the VM is where
Claude-authored shell/code runs [INFERRED from src: cw-arch + src: readme-42].

### How it differs from Claude Code CLI

- No terminal; the surface is the Claude Desktop/web/mobile chat UI [src: cw-start]
  [DOCUMENTED-WEB].
- No `~/.claude` loading: muster's capability resolver documents that "a Claude Code
  plugin merely being present on disk does not make that plugin's agents/skills callable
  from Cowork" [src: caps-23] [CODE-VERIFIED]. (Cowork's *own* plugin system, section 3,
  is a separate install path with its own Customize UI [src: cw-plugins].)
- No hooks in the Claude Code enforcement sense available to an MCP integrator: no
  SessionStart/UserPromptSubmit/PreToolUse to register from outside; muster's sprint
  protocol names the concrete losses — no wave-guard, no scale-gate, no action-class
  fence, no run-active marker [src: sprint-14] [CODE-VERIFIED]. Plugin-bundled hooks now
  exist ("Hooks and sub-agents run only in Cowork" [src: cw-plugins]) but are a plugin
  author surface, not an MCP server surface [DOCUMENTED-WEB].
- No git-native workflow primitives: no worktree isolation, no headless/CI mode, no
  audit logs ("Cowork activity isn't captured in audit logs, the Compliance API, or data
  exports" [src: cw-arch]) [DOCUMENTED-WEB].
- Permissioning is UI-modal (Manual/Auto/Skip, section 2) rather than
  settings.json allow/deny rules [src: cw-start] [DOCUMENTED-WEB].

## 2. The naked base loop

Anthropic documents Cowork's task loop as five steps: "1. Analyzes your request and
creates a plan. 2. Breaks complex work into subtasks when needed. 3. Runs code and shell
commands in an isolated environment on Anthropic's servers. 4. Coordinates multiple
workstreams in parallel if appropriate. 5. Delivers finished outputs to your session"
[src: cw-start] [DOCUMENTED-WEB]. So plan-then-execute with optional parallel fan-out is
**native**, but the plan is free-form: there is no exposed task-graph object, no
dependency ordering, no gate between "waves," and no validation that the plan was
followed — which is precisely the hole muster's deterministic verbs fill
[INFERRED from src: cw-start + src: readme-11].

Native primitives that exist [DOCUMENTED-WEB, all src: cw-start unless noted]:

- **Planning + subtask decomposition** — steps 1–2 of the loop; visible progress
  indicators and surfaced reasoning ("Transparency: Claude surfaces its reasoning and
  approach so you can follow along") [src: cw-start].
- **Sub-agent coordination** — "Claude breaks complex work into smaller tasks and
  coordinates parallel workstreams to complete them"; and during a task, "For complex
  tasks, Claude may coordinate multiple sub-agents working simultaneously"
  [src: cw-start]. This is the official confirmation of the parallel fan-out muster's
  orchestration lifecycle depends on.
- **Mid-run steering** — "You can jump in to course-correct or provide additional
  direction mid-task," from any surface [src: cw-start]; the July blog frames it as
  "redirect a draft mid-meeting and Claude keeps going" [src: blog-webmobile].
- **Permission modes as the native gate** — three modes crossed with per-connector-tool
  permission settings: Manual (pause and ask), Auto (Claude reviews each action for
  safety — prompt-injection/exfiltration checks — and auto-blocks, falling back to
  asking; consumes more usage), Skip (no checks). Auto mode will not auto-approve
  sensitive actions such as granting new folder access, deleting files, or creating
  scheduled tasks [src: cw-start].
- **Enforced deletion protection** — "Claude requires your explicit permission before
  permanently deleting any files"; this is a hard product-level gate, not a prompt
  convention [src: cw-start].
- **Long-running + scheduled execution** — no conversation-timeout interruption;
  `/schedule` creates recurring tasks that run remotely with no device online
  [src: cw-start]. (Note: `/schedule` is a slash-invoked product feature — another
  small crack in the adapter's "no slash-command primitives" framing
  [INFERRED from src: cw-start + src: readme-5].)
- **Projects with memory** — persistent workspaces "with their own files, links,
  instructions, and memory"; chat memory does not carry into Cowork, and within Cowork
  memory is supported in projects only [src: cw-start].
- **Global and folder instructions** — standing per-user instructions in Settings,
  plus per-folder instructions that "Claude can also update ... on its own during a
  session" — the CLAUDE.md analog [src: cw-start].

Native primitives that are **absent** (the gap muster's port exists to fill)
[CODE-VERIFIED against src: sprint-14, src: readme-38]:

- No dependency-ordered task graph, no wave barrier, no review gate, no tournament or
  fusion machinery — the plan is prose in the agent's head; the entire deterministic
  gate/wave layer is what the 21-tool server imports [src: readme-11] [INFERRED].
- No enforcement hooks an integrator can register: muster's wave-guard, scale-gate, and
  action-class fence have "no Cowork equivalent — this session's own discipline is the
  only enforcement there is" [src: sprint-14].
- No isolated per-item worktree runners; running multiple backlog items concurrently
  "has no validated isolation model here," so muster's sprint degradation path
  (sequential, one item at a time, in the main tree) "IS the path for Cowork sprints,
  not a fallback" [src: sprint-24].
- No session sharing, no compliance/audit capture [src: cw-start] [src: cw-arch].

## 3. Extension surfaces: MCP as the (formerly only) integration plane

Muster's port targets a three-legged registry, encoded in `readInstalledCowork`: local
MCP servers from `claude_desktop_config.json`, MCPB/DXT desktop extensions enumerated
from a `Claude Extensions/` directory ("no index file exists, so we enumerate"), and
remote connectors that live in cloud/account state and "cannot be discovered
(connectorsDiscoverable:false) and must be DECLARED" [src: harness-31] [src: harness-46]
[CODE-VERIFIED]. Each leg, reconciled against current docs:

### 3a. Local MCP servers (`claude_desktop_config.json`)

Muster's Route A install merges a `muster` entry into `mcpServers` in
`claude_desktop_config.json` at platform paths — `%APPDATA%\Claude` on Windows (with an
MSIX-virtualized `LocalCache` copy that the app prefers when present),
`~/Library/Application Support/Claude` on macOS, `~/.config/Claude` on Linux community
builds [src: readme-53] [CODE-VERIFIED]; `coworkConfigDirs` mirrors exactly those paths
and tries the MSIX-virtualized path first on Windows [src: harness-17] [CODE-VERIFIED].

The documentation is now **internally inconsistent** about this surface:

- The architecture overview says the local-session agent loop includes "local plugin MCP
  servers," and its MDM key `isLocalDevMcpEnabled` disables "plugin-bundled and locally
  configured MCP servers" — implying locally-configured servers are a live Cowork
  surface on desktop [src: cw-arch] [DOCUMENTED-WEB].
- The custom-connectors article (updated April 2026) states flatly: "Local MCP servers
  configured in Claude Desktop via `claude_desktop_config.json` are a separate mechanism
  and do use your local network, but those aren't available in Cowork or claude.ai"
  [src: cw-connectors] [DOCUMENTED-WEB].
- The get-started article says "plugins that include local MCP servers work through the
  desktop app only" [src: cw-start], and the architecture overview adds "Local MCP
  servers don't run in remote sessions" [src: cw-arch] [DOCUMENTED-WEB].

Muster's own ground truth is that Route A worked — the README's verification step ("You
should see all twenty-one tools") and the "Dispatch is confirmed working" claim were
validated against a live desktop Cowork [src: readme-7] [src: readme-11]
[CODE-VERIFIED]. The reconciled reading: config-file local servers loaded in
desktop-era local sessions (where muster verified), plugin-bundled/MCPB servers are the
documented desktop path going forward, and **no local-server route reaches a remote
session's sandbox** — the surface muster's whole port stands on is session-mode-dependent
and drifting toward plugin/extension packaging [INFERRED from the three sources above].
Re-running `scripts/cowork-probe.mjs` inside a current build — exactly what the probe
was built for [src: probe-8] — is the only way to settle it empirically.

### 3b. MCPB desktop extensions

MCPB (formerly DXT) is Anthropic's one-click packaging for local MCP servers: "MCP
Bundles (.mcpb) are zip archives containing a local MCP server and a manifest.json,"
installable like a browser extension, with a `user_config` block the host renders as a
settings UI and passes to the server (as env vars, among other bindings)
[src: mcpb-spec] [src: mcpb-blog] [DOCUMENTED-WEB]. Anthropic documents desktop
extensions as the enterprise deployment path for local servers on Team/Enterprise
[src: mcpb-docs] [DOCUMENTED-WEB]; the dedicated MDM kill switch is
`isDesktopExtensionEnabled` [src: cw-arch].

Muster ships Route B as a first-class MCPB descriptor: `manifest.json` with
`manifest_version` 0.3, a node entry point at `${__dirname}/cowork/mcp-server.mjs`, and
`user_config` fields (Fable toggle, max tier, declared connectors) mapped to
`MUSTER_ENABLE_FABLE`, `MUSTER_MAX_TIER`, `MUSTER_COWORK_CONNECTORS` env vars
[src: manifest-10] [CODE-VERIFIED]. Known sharp edge: on Windows MSIX installs the
extension's `${__dirname}` is virtualized and the server's child-process spawn of the
muster CLI can fail — documented with a fallback to Route A [src: readme-105]
[CODE-VERIFIED].

### 3c. Remote connectors

Remote connectors are account-level MCP: configured in claude.ai settings, brokered
through Anthropic's cloud, never touching local disk. "The connection to your MCP server
originates from Anthropic's servers, not from your machine's network interface" — true
across every client including Cowork and desktop, so a custom connector's server must be
reachable from Anthropic's published IP ranges [src: cw-connectors] [DOCUMENTED-WEB].
Because they live in cloud state, muster cannot auto-discover them; the port makes the
gap explicit rather than papering it: connectors must be declared via
`MUSTER_COWORK_CONNECTORS`, and output carries `connectorsDiscoverable: false` "so the
gap stays visible" [src: readme-123] [src: harness-46] [CODE-VERIFIED].

### 3d. Plugins — the surface that did not exist when muster ported

"Each plugin bundles skills, connectors, and sub-agents into a single package"; skills
work across chat and Cowork, while "Hooks and sub-agents run only in Cowork." Skills are
invoked from a `/` menu in the composer. Plugin structure follows the **Claude Code
plugins reference** ("For details on plugin structure and formatting, see the Plugins
reference in our Claude Code docs"), plugins can be uploaded as files or synced from
GitHub marketplaces, and org admins can distribute or require them [src: cw-plugins]
[DOCUMENTED-WEB]. Plugins may include local MCP servers (desktop-only, with the same
trust warnings as any local program) [src: cw-plugins].

This falsifies the adapter's load-bearing comment — "it has no plugin/skill/slash/hook
primitives" [src: mcps-head] [src: readme-5] — for current Cowork. Whether muster's
existing Claude Code plugin (`plugin/`) loads as-is under Cowork's plugin loader is
**unverified**: the format is shared, but Cowork's runtime honors a different primitive
subset (no statement that commands/ slash-verbs load; hooks semantics undocumented
beyond "run only in Cowork"). This is the single highest-value open question for the
port [INFERRED from src: cw-plugins + src: readme-5].

## 4. Subagent dispatch and model override

The two capabilities muster's full orchestration lifecycle is gated on
[src: probe-8]:

- **Parallel fan-out: [DOCUMENTED-WEB].** "Coordinates multiple workstreams in
  parallel"; "Claude may coordinate multiple sub-agents working simultaneously"
  [src: cw-start]. Plugins can bundle sub-agents, and sub-agents "run only in Cowork"
  [src: cw-plugins].
- **Per-call model override: NOT documented anywhere public.** No official source found
  describes selecting a model per sub-agent (or even a session model selector) in
  Cowork. The only evidence is muster's own probe: phase 3 emits a three-task spec that
  the runtime executes — parallel batch dispatch plus one task carrying
  `modelOverride`, graded on whether "task c's modelReported reflects the override"
  [src: probe-137] [CODE-VERIFIED as an instrument]. The repo records the result:
  "Dispatch is confirmed working: Cowork can fan out parallel subagents with a per-call
  model override, so the full orchestration lifecycle ... runs here, not just the
  router" [src: readme-7] [CODE-VERIFIED]. The server's older header text still carries
  the pre-verification hedge ("gated on Cowork supporting subagent dispatch + per-call
  model override, which its docs do not disclose") [src: mcps-head] — the docs still
  don't disclose it; the claim rests entirely on the probe run.

There is no dispatch *API*: an MCP server cannot spawn Cowork sub-agents. Dispatch
belongs to the agent, so muster steers it by prompt — the `COWORK_PROTOCOL` instructs
"Dispatch each wave's members as PARALLEL subagents (fall back to muster_next, one task
at a time, only if fan-out is unavailable)" and "dispatch each role on the model
muster_capabilities assigns it" [src: mcps-56] [CODE-VERIFIED]. Degradation is
first-class: if fan-out fails, "muster still runs as a router plus single-agent
executor: the agent walks each wave one task at a time via `muster_next`"
[src: readme-146] [CODE-VERIFIED]. Every role's fallback chain terminates at `inline`
(the current agent doing the work itself) — a probe-enforced invariant [src: probe-98]
[CODE-VERIFIED].

## 5. Config and connector topology, auth model

Full topology, host side [CODE-VERIFIED unless noted]:

- **Config file:** `claude_desktop_config.json` under the platform config dir; on
  Windows the MSIX-virtualized `AppData/Local/Packages/Claude_*/LocalCache/Roaming/
  Claude` copy is "the one the app actually reads" and is tried first
  [src: harness-17] [src: readme-53].
- **Extensions:** `Claude Extensions/<id>/manifest.json`, one dir per extension, no
  central index — discovery is enumeration [src: harness-31]. Extension `user_config`
  binds to env vars at server launch [src: manifest-10] [src: mcpb-spec].
- **Remote connectors:** account state on Anthropic's side; added via claude.ai settings
  (org Owners gate Team/Enterprise), enabled per conversation via the `+` menu
  [src: cw-connectors] [DOCUMENTED-WEB].
- **Admin plane:** org-wide Cowork toggle; remote-session toggles (network-access
  policy, forced per-call approval, trusted-device enrollment); MDM device keys
  `isLocalDevMcpEnabled` and `isDesktopExtensionEnabled` [src: cw-arch]
  [DOCUMENTED-WEB].

Auth model for remote connectors [DOCUMENTED-WEB]:

- OAuth is the standard flow: "you'll typically go through an OAuth authentication
  process to securely sign in ... without Claude ever seeing your actual password";
  custom connectors optionally take an OAuth Client ID/Secret in advanced settings;
  revocation is disconnect-side or provider-side [src: cw-connectors].
- On Team/Enterprise, Owners add the connector org-wide but "users individually connect
  to and enable that connector," so Claude only gets each user's own access
  [src: cw-connectors].
- In remote sessions, tokens are held server-side only: "Connector authorization tokens
  never enter the sandbox; connector calls are made on the server side"; the sandbox
  gets session-scoped tokens expiring within hours [src: cw-arch].

## 6. Anatomy of muster's ride (and its reuse as the canonical MCP port)

What actually ships [CODE-VERIFIED]:

- **One self-contained server, no SDK:** `cowork/mcp-server.mjs` speaks newline-delimited
  JSON-RPC 2.0 over stdio, node builtins only, MCP protocol version pinned to
  `2025-06-18` [src: mcps-head] [src: mcps-294]. Twenty-one `muster_*` tools wrap the
  deterministic CLI (`src/cli.js`) — detection, capability/domain routing, gate scoring,
  RICE prioritization, wave planning, tournament pick/fuse, review tally, advisor
  validation [src: readme-11] [src: mcps-106].
- **Protocol injection via `instructions`:** the initialize response carries
  `PRINCIPLES + VERBS + ROUTING_POLICY + COWORK_PROTOCOL` — "That replaces the
  SessionStart and UserPromptSubmit hooks the Claude Code plugin uses" [src: readme-32]
  [src: mcps-56]. The per-mode lifecycles (plan/go/plan-backlog/go-backlog/diagnose/
  audit) are driven "in prose since there are no slash commands" [src: mcps-56].
- **Cowork-aware capability resolution:** `capabilities --cowork` resolves against
  Cowork's registry via `readInstalledCowork`; in cowork mode every non-MCP provider is
  filtered out — `if (cowork && entry?.kind !== "mcp") entry = null;` — and
  recommendations are likewise MCP-only, so muster never advertises a provider Cowork
  cannot invoke [src: caps-23] [src: cli-106]. The MCP wrapper exports
  `MUSTER_RUNTIME=cowork` so nested CLI children (notably `audit`) resolve the same way
  [src: mcps-142].
- **Execution hygiene:** child CLI calls carry a 60 s timeout and 16 MB buffer; a
  WorkLimiter bounds concurrency (4 in-flight / 16 queued by default, env-tunable with
  hard ceilings); MCP `notifications/cancelled` aborts queued and active work and cleans
  temp input dirs; stdin is capped at 4 MB against no-newline DoS [src: mcps-142]
  [src: mcps-225] [src: readme-130].
- **Sprint playbook as a tool:** `muster_sprint_protocol` serves
  `cowork/sprint-protocol.md` verbatim — a Cowork-native go-backlog port that names
  every degradation (no hooks, sequential item execution, claim/receipt discipline done
  by hand, HUMAN-HOLD resolved by asking the live human in-chat because there is no
  AskUserQuestion tool, merge-local/merge-push executing "with zero structural safety
  net") [src: mcps-127] [src: sprint-14] [src: sprint-118] [src: sprint-131].
- **The Cowork server is the canonical shared source:** `build-codex.mjs` produces the
  Codex MCP server by string-rewriting `cowork/mcp-server.mjs` — swapping the protocol
  line, `capabilities --cowork` → `--codex`, and `assess` → `assess --codex` — and
  bundling with esbuild; it also reuses `cowork/sprint-protocol.md` verbatim in the
  Codex runtime [src: build-codex-390] [CODE-VERIFIED]. Cowork is not a side port; it is
  the reference implementation of muster's harness-portable MCP surface.

## 7. Augmentation-surface table

| Native primitive | What it's for | How muster rides it today | Advisory vs enforcement | Gap vs Claude Code |
|---|---|---|---|---|
| Local MCP server (`claude_desktop_config.json`) | Register host-local tools with the agent loop [src: cw-arch] | Route A: the whole 21-tool deterministic brain [src: readme-11] [src: harness-17] | Tool *results* are advisory to the agent; the server enforces its own contracts (required `dir` on audit, overload rejection, cancellation) [src: mcps-106] | Claude Code loads the full plugin (hooks, commands, agents); and this surface is contradicted for current Cowork / absent in remote sessions [src: cw-connectors] |
| MCPB desktop extension + `user_config` | One-click packaged local server with a settings UI [src: mcpb-spec] | Route B: `manifest.json` maps Fable/tier/connector settings to env vars [src: manifest-10] | Config is a deterministic input; tier caps are enforced inside muster's CLI, not by Cowork | Claude Code has no equivalent packaging need (plugins carry servers); MSIX virtualized-spawn risk is Cowork-specific [src: readme-105] |
| MCP `instructions` at initialize | Server-supplied session guidance [src: mcps-294] | Carries principles + routing policy + full per-mode execution protocol [src: readme-32] | Pure advisory — prompt text the model can ignore; nothing re-injects it per turn | Claude Code gets SessionStart/UserPromptSubmit hooks (guaranteed injection) plus PreToolUse denial [src: sprint-14] |
| Sub-agent fan-out + per-call model override | Parallel workstreams on the right model tier [src: cw-start] | Wave dispatch + tournament/review crews per `COWORK_PROTOCOL`; model per role from `muster_capabilities` [src: mcps-56] [src: readme-7] | Entirely advisory — dispatch discipline is prompted; no hook can force crew dispatch over inline editing | Claude Code has a real Task tool contract, agent definitions, worktree isolation, wave-guard enforcement [src: sprint-24] |
| Remote connectors (OAuth, cloud-brokered) | External SaaS tools, org-governed [src: cw-connectors] | Declared-only via `MUSTER_COWORK_CONNECTORS`; `connectorsDiscoverable:false` keeps the blindness visible [src: harness-46] | Declaration is trust-me config; muster cannot verify a connector exists or is enabled | Claude Code MCP configs are disk-discoverable; muster reads them directly there [src: caps-23] |
| Plugins (skills + hooks + sub-agents + connectors) | Role/team customization, marketplace-distributed [src: cw-plugins] | **Not ridden at all** — adapter predates the surface [src: readme-5] | Skills advisory; plugin hooks' enforcement semantics undocumented | Same plugin format as Claude Code per docs — potentially closes the skills/commands/hooks gap wholesale; unverified [src: cw-plugins] |
| Permission modes + deletion protection | Native action gating (Manual/Auto/Skip; hard delete-approval) [src: cw-start] | Acknowledged only: sprint protocol prefers `pr`/`keep` because muster's own fences don't exist here [src: sprint-131] | Cowork-enforced, but not hookable — muster can't add its action-class fence into it | Claude Code permissions are rule-configurable (settings allow/deny) and hook-extensible |
| Global/folder instructions | Standing context; folder-level, agent-updatable [src: cw-start] | **Not ridden** — muster injects context only via MCP `instructions` | Advisory prose | CLAUDE.md analog exists here; muster's plugin uses CLAUDE.md-adjacent hooks on Claude Code |
| Scheduled tasks (`/schedule`, runs deviceless) | Recurring unattended runs [src: cw-start] | **Not ridden** — `/muster:runner`'s cron analog on Claude Code has no Cowork counterpart wired | Product-enforced schedule; content advisory | Claude Code routines/cron + runner mode already exist; a scheduled Cowork task could drive `muster_sprint_protocol` unattended [INFERRED] |
| Projects (files, instructions, memory) | Persistent multi-task workspace [src: cw-start] | **Not ridden** — STATE.md is hand-written per sprint [src: sprint-14] | Advisory | Claude Code has no direct equivalent; projects could host `.muster/` state across sessions [INFERRED] |

## 8. Sourcing gaps and confidence notes

- **Per-call model override** rests solely on muster's probe run [src: readme-7]
  [src: probe-137]; zero public documentation. Treat as CODE-VERIFIED-but-fragile:
  re-probe after any Cowork update, exactly as the README prescribes for new runtimes
  [src: readme-146].
- **Sub-agent internals** (how many, scheduling, context inheritance, whether plugin
  sub-agents and loop-native sub-agents are the same mechanism) are undocumented;
  official sources say only that parallel sub-agent coordination happens
  [src: cw-start] [src: cw-plugins].
- **The local-MCP contradiction** (section 3a) is unresolved in official docs: the
  architecture overview, get-started, and custom-connectors articles disagree on
  whether config-file local servers reach Cowork at all [src: cw-arch] [src: cw-start]
  [src: cw-connectors]. Muster's port empirically worked on desktop-era Cowork; its
  status under remote-default sessions is unknown and is the port's biggest existential
  risk.
- **Plugin-format compatibility** — whether `plugin/` loads under Cowork's loader, and
  what subset (skills yes, hooks "run only in Cowork" with undefined semantics,
  commands unstated) — is the biggest unexploited opportunity and needs a hands-on
  test, not more reading [src: cw-plugins] [src: readme-5].
- **No deep-dive engineering source exists for Cowork** (contrast Claude Code's
  published internals); the closest are the enterprise architecture overview
  [src: cw-arch], the Trust Center security PDF it links, and launch/expansion press
  [src: vb-launch] [src: newstack] [src: fortune]. Cowork sourcing is genuinely thin —
  the shipping adapter code in this repo is the best primary source available for
  integrator-facing behavior, which is itself a finding about the platform's maturity.
- The support article muster's README links as "desktop-architecture-overview"
  [src: readme-3] has been retitled "Claude Cowork architecture overview" and
  restructured around remote sessions — a marker of how fast the January-era ground
  truth is moving [src: cw-arch].

## Sources

- cw-arch: https://support.claude.com/en/articles/14479288-claude-cowork-desktop-architecture-overview
- cw-start: https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork
- cw-plugins: https://support.claude.com/en/articles/13837440-use-plugins-in-cowork
- cw-connectors: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- blog-webmobile: https://claude.com/blog/cowork-web-mobile
- newstack: https://thenewstack.io/claude-cowork-cloud-mobile/
- vb-launch: https://venturebeat.com/technology/anthropic-launches-cowork-a-claude-desktop-agent-that-works-in-your-files-no
- fortune: https://fortune.com/2026/01/13/anthropic-claude-cowork-ai-agent-file-managing-threaten-startups/
- labs: https://www.anthropic.com/news/introducing-anthropic-labs
- mcpb-blog: https://www.anthropic.com/engineering/desktop-extensions
- mcpb-spec: https://github.com/modelcontextprotocol/mcpb
- mcpb-docs: https://claude.com/docs/connectors/custom/desktop-extensions
- readme-3: cowork/README.md:3
- readme-5: cowork/README.md:5
- readme-7: cowork/README.md:7
- readme-11: cowork/README.md:11-32
- readme-32: cowork/README.md:32
- readme-38: cowork/README.md:38
- readme-42: cowork/README.md:42
- readme-53: cowork/README.md:53-57
- readme-105: cowork/README.md:105
- readme-123: cowork/README.md:123-126
- readme-130: cowork/README.md:130-132
- readme-146: cowork/README.md:146
- mcps-head: cowork/mcp-server.mjs:2-16
- mcps-56: cowork/mcp-server.mjs:53-78
- mcps-106: cowork/mcp-server.mjs:106-139
- mcps-127: cowork/mcp-server.mjs:127-131
- mcps-142: cowork/mcp-server.mjs:142-166
- mcps-225: cowork/mcp-server.mjs:221-292
- mcps-294: cowork/mcp-server.mjs:294-331
- sprint-14: cowork/sprint-protocol.md:12-33
- sprint-24: cowork/sprint-protocol.md:24-31
- sprint-118: cowork/sprint-protocol.md:113-125
- sprint-131: cowork/sprint-protocol.md:131-143
- manifest-10: cowork/manifest.json:10-42
- harness-17: src/harness.js:15-29
- harness-31: src/harness.js:31-40
- harness-46: src/harness.js:42-70
- caps-23: src/capabilities.js:23-29,43,60
- cli-106: src/cli.js:106-117
- probe-8: scripts/cowork-probe.mjs:2-13
- probe-98: scripts/cowork-probe.mjs:98-131
- probe-137: scripts/cowork-probe.mjs:134-166
- build-codex-390: scripts/build-codex.mjs:390-398,327
