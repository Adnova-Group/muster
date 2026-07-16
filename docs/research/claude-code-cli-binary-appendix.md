# Research: Claude Code CLI — harness internals

Implementation-grade documentation of the Claude Code CLI (Anthropic), aimed at a team
that wants to rebuild its core loop. Compiled from three kinds of evidence, each marked
inline:

- **[docs]** — official documentation fetched live from `code.claude.com/docs/en/*`
  during this research pass.
- **[live]** — direct empirical inspection of a real, running Claude Code installation
  on this machine: its CLI `--help` output, its `~/.claude/` state directory, and a live
  session transcript (`~/.claude/projects/-home-ryan-dev-muster/<session-id>.jsonl`).
- **[binary]** — strings extracted from the installed native executable
  (`~/.local/share/claude/versions/2.1.211`, a 250MB bun-compiled single-file binary),
  used to corroborate or fill gaps in the docs (error messages, internal event names,
  the built-in tool registry).

Version observed: **2.1.211** (2026-07-16). Claude Code ships on a fast release
cadence (multiple point releases per week); version numbers are cited throughout
because many behaviors are gated by them.

Everything below describes the product as of this date. Treat numeric thresholds
(token counts, retry counts) that come from a documentation *example* rather than a
schema as illustrative, not load-bearing constants — they are marked as such.

---

## 1. What "Claude Code CLI" is

A single native executable (`claude`) that starts an agentic loop against the Claude
API (or Bedrock/Vertex/Foundry/a gateway). It is not a thin wrapper script: `file` on
the installed binary shows an ELF executable containing a full bundled JS/TS
application (a bun/esbuild single-file compile) — the CLI embeds its own ripgrep,
its own sandboxing runtime hooks, a markdown/mermaid renderer for `/hooks` and similar
panels, and the entire permission/hook/session machinery. There is no separate daemon;
one `claude` process is the whole harness for a session. **[live]**

Distribution/self-update: `~/.local/share/claude/versions/<semver>` holds each
installed build; `~/.local/bin/claude` is a symlink to the active version. `claude
update|upgrade` checks for and installs new builds. **[live]**

---

## 2. The naked base loop (zero-plugin session)

With no hooks, no MCP servers, no skills, and no subagents configured, a Claude Code
session is a **single homogeneous agentic tool-use loop** — there is no separate
planner/executor/verifier state machine baked into the runtime. "Plan → execute →
verify" is a pattern the system prompt encourages and that a few explicit mechanisms
can enforce, not a hardwired phase sequence. Concretely, per user turn:

1. **UserPromptSubmit** fires (even with zero hooks configured, this is a lifecycle
   point the runtime always reaches — hooks are just optional subscribers to it).
   **[docs]**
2. The full context (system prompt + CLAUDE.md/memory + tool definitions + prior
   transcript messages, subject to compaction — §3) is sent to the model as one
   `messages.create`-shaped request.
3. The model streams back a single assistant message whose `content` array can
   interleave `thinking`, `text`, and `tool_use` blocks. **[live]**
4. For each `tool_use` block: a permission decision is resolved (§4.2), then
   **PreToolUse** fires, then the tool executes, then **PostToolUse** (or
   **PostToolUseFailure**) fires. Independent tool calls in one message can be
   dispatched as a batch, after which **PostToolBatch** fires once for the whole
   batch. **[docs]**
5. Tool results are appended as a new `user`-role message (each result is a
   `tool_result` content block keyed by `tool_use_id`), and the loop returns to step 2
   — the model is called again with the enlarged context.
6. This repeats until the model emits a message with `stop_reason` other than
   `tool_use` (i.e., it stops asking for tools). At that point **Stop** fires.
7. Control returns to the human for the next prompt.

**Where "plan" and "verify" actually live in this loop**, since there is no dedicated
phase for either:

- **Plan** is a *permission-mode* overlay (§4.2), not a loop phase: entering `plan`
  mode restricts every tool to read-only until the user approves a plan via one of
  several explicit approve options, at which point the session's permission mode
  changes and normal execution resumes. Mechanically this is implemented as explicit
  `EnterPlanMode` / `ExitPlanMode` tool calls the model itself invokes — plan mode is
  tool-mediated, not just a CLI flag. **[binary, docs]**
- **Verify** has no dedicated phase either, but the **Stop** hook is the one point in
  the base loop that can force it: a Stop hook that exits with a blocking decision
  (`decision: "block"`, `reason: "..."`) prevents the turn from ending and feeds the
  reason back to the model as if it were told to keep working — e.g. "tests are red,
  keep going." This is the mechanism behind enforced TDD/verification gates (this
  repo's own former `scale-gate deny`/`todo gate` hooks, and the muster runner's
  review-gate re-verification, are instances of this pattern). **[docs]**
- Task tracking (the visible "todo list" behavior) is the **TodoWrite** built-in tool,
  which is a state object the model chooses to populate and update — not enforced by
  the runtime unless a hook inspects it (e.g., a Stop hook that greps the todo state
  for incomplete items and blocks).

So: rebuilding "the core loop" is really rebuilding one thing — a tool-use
request/response loop with a context-assembly step before each model call and a
hook-firing point before/after each side effect — plus two optional overlays (a
permission-mode gate on which tools may run, and a Stop-hook gate on when the loop is
allowed to end).

---

## 3. Agent loop internals

### 3.1 System prompt assembly

The system prompt is not one static string; the harness selects among prompt
variants and appends dynamic sections. Evidence from the binary (three literal
identity strings coexist and are chosen by launch context): **[binary]**

```
"You are Claude Code, Anthropic's official CLI for Claude."                      (interactive CLI)
"You are Claude Code, Anthropic's official CLI for Claude, running within
 the Claude Agent SDK."                                                          (SDK-hosted)
"You are a Claude agent, built on Anthropic's Claude Agent SDK."                 (headless/agent-style; this is
                                                                                   what this research agent itself saw)
```

Beyond the identity line, the documented startup context — in the order the official
context-window visualization lists it — is: **[docs]**

| Section | Loaded | Notes |
|---|---|---|
| System prompt (core behavior/tool-use instructions) | always, first | never shown to the user directly |
| Auto memory (`MEMORY.md`) | always | first 200 lines / 25KB, whichever is smaller (§7) |
| Environment info (cwd, platform, shell, OS, git-repo flag) | always | git branch/status/recent commits load as a separate block at the very end of the system prompt |
| MCP tool names (schemas deferred) | always | full JSON schemas are **not** loaded up front by default — see "deferred tools" below |
| Skill descriptions (one-liners) | always, unless `disable-model-invocation: true` | full skill body loads only on invocation; this listing is **not** re-injected after `/compact` |
| `~/.claude/CLAUDE.md` (user, global) | always | |
| Project `CLAUDE.md` (walking up the directory tree) | always | |

`--exclude-dynamic-system-prompt-sections` (CLI flag) moves the per-machine bits (cwd,
env info, memory paths, git status) out of the system prompt and into the first user
message instead, specifically to improve cross-user prompt-cache reuse. **[live,
`claude --help`]**

**Deferred tools.** By default, MCP tool schemas (and, per the binary, a broader class
of "deferred tools") are listed by name only; the model must call a `ToolSearch`-style
tool with `select:<name>[,<name>...]` or a keyword query to pull in the full JSON
schema before it can invoke them. This is exactly the mechanism this research agent
observed directly in its own transcript: dozens of MCP tools appeared as bare names in
a system-reminder, uncallable until a `ToolSearch` lookup fetched their schemas.
`ENABLE_TOOL_SEARCH=auto` loads schemas upfront when they fit in 10% of the context
window; `ENABLE_TOOL_SEARCH=false` disables deferral entirely and loads everything.
**[docs, binary, live]**

### 3.2 Streaming and message construction

Assistant messages are Anthropic Messages-API-shaped: `content` is an array of typed
blocks. From a live transcript, the three block types actually observed: **[live]**

```jsonc
// thinking block (extended thinking) — carries an opaque signature, not just text
{ "type": "thinking", "thinking": "...", "signature": "CAIS/QcKiAEIDxgC..." }

// tool_use block — note the "caller" field, distinguishing direct model-issued
// calls from calls attributed to something else (e.g. a forked/dispatched context)
{ "type": "tool_use", "id": "toolu_01...", "name": "Bash",
  "input": { "command": "...", "description": "..." },
  "caller": { "type": "direct" } }

// tool_result — travels back as a content block inside the NEXT user-role message
{ "tool_use_id": "toolu_01...", "type": "tool_result",
  "content": "...", "is_error": false }
```

`--include-partial-messages` (print mode + `stream-json`) exposes partial-message
deltas as they arrive; `--forward-subagent-text` additionally surfaces subagent
text/thinking as parent-tagged messages via `parent_tool_use_id`. **[live, `claude
--help`]**

### 3.3 Context compaction

Two compaction paths exist: manual (`/compact`) and automatic, gated by
`autoCompactWindow` (a token threshold configurable in `settings.json`, tunable via
`/autocompact`). Evidence for the mechanism, corroborated across the binary and docs:
**[binary, docs]**

- Compaction can be **precomputed in the background** before the hard threshold is hit,
  then swapped in synchronously if a "prompt too long" condition fires — i.e., the
  summary isn't necessarily computed on the blocking path.
- **PreCompact** fires before compaction and can **block it** (`"Compaction blocked
  by PreCompact hook"` is a literal runtime error string) — a hook can veto
  compaction entirely, leaving the session to continue uncompacted (and presumably
  fail on the next oversized request, or the caller handles it).
- **PostCompact** fires after compaction completes and cannot block anything (it's
  strictly a notification point).
- Compaction can either summarize *everything* (no `messagesToKeep`) or preserve a
  tail of recent messages (`preserved_messages`, with an `anchor` marking where
  preserved content begins) — i.e., compaction is not always "replace the whole
  history with one summary"; it can be a partial rewrite.
- `PreCompact`/`PostCompact` hooks match on trigger: `manual` vs `auto`.
- **What survives compaction** (documented explicitly): project-root `CLAUDE.md` is
  **re-read from disk and re-injected** after `/compact`. Nested/subdirectory
  `CLAUDE.md` files are *not* automatically re-injected — they reload only the next
  time Claude reads a file in that subdirectory. The startup skill-description listing
  is *not* re-injected either; only skills actually invoked during the session persist
  through compaction. Auto-mode's classifier reads conversational "boundaries" (e.g.
  "don't push yet") straight out of the live transcript, so a stated boundary can be
  silently lost if compaction drops the message that stated it — the docs explicitly
  recommend a hard `deny` rule instead of relying on a spoken boundary surviving
  compaction. **[docs]**

### 3.4 Subagent context isolation

The `Task`/`Agent` tool spawns a subagent with its **own context window**, not a
continuation of the parent's. What it inherits vs. starts fresh with, per the official
context-window walkthrough: **[docs]**

- Own system prompt (shorter than the main session's — for the built-in
  general-purpose agent, "a brief prompt plus environment details").
- The **same** MCP servers and skills as the parent, minus a few tools that don't make
  sense nested (plan-mode controls, background-task tools, and — by default — the
  `Agent` tool itself, to prevent unbounded recursion).
- Its own copy of project `CLAUDE.md` (counted against its budget, not the parent's).
  The built-in `Explore` and `Plan` agents **skip** CLAUDE.md and the parent's git
  status entirely, to stay cheap.
- **Not** the parent's conversation history and **not** the parent's auto-memory. If
  the subagent's own frontmatter declares `memory:`, it loads its own separate
  `MEMORY.md` instead.
- A task prompt written by the parent, in place of a user message.
- A subagent inherits the parent's cwd; `cd` inside a subagent's Bash/PowerShell calls
  does not persist across its own tool calls and never affects the parent's cwd.
  `isolation: worktree` in frontmatter gives it an actual separate git worktree, and
  (v2.1.203+) locks its shell commands to that worktree — a command that resolves
  outside it fails rather than silently running in the main checkout.

Built-in subagents: **Explore** (read-only, fast; model inherited from the parent,
capped at Opus on the first-party API), **Plan** (read-only, used during plan mode to
front-load research while the main conversation stays frozen), **general-purpose**
(all tools, inherited model). Custom subagents are markdown files with YAML
frontmatter (`name`, `description`, `tools`, `model`, `permissionMode`, `mcpServers`,
`hooks`, `maxTurns`, `skills`, `memory`, `effort`, `isolation`, `color`, ...) living in
`.claude/agents/` (project) or `~/.claude/agents/` (user); resolution order when names
collide: managed settings > `--agents` CLI JSON > project (closest-to-cwd nested
directory wins) > user > plugin. Every subagent's actions — including any
`permissionMode` declared in its own frontmatter, which is **ignored** — are re-checked
by the auto-mode classifier at three points: before spawn (task description), during
execution (every action), and after completion (a return-scan that can prepend a
security warning to its results). **[docs]**

---

## 4. Tool dispatch

### 4.1 Built-in tool inventory

Extracted from the running binary's own tool-definition strings (docstrings quoted
verbatim where short). This is broader than the "classic" file/shell/search set most
users see — the same binary also implements background agents, agent teams, and
scheduling surfaces: **[binary]**

**Core (present in a bare, zero-plugin session):**

| Tool | Purpose |
|---|---|
| `Bash` | Shell execution (sandboxed by default when sandboxing is on — §4.4) |
| `Read`, `Write`, `Edit` | File I/O; Edit refuses if the file "has not been read yet" or "has changed since it was last read" (staleness guard) |
| `NotebookEdit` | Jupyter cell editing |
| `Glob`, `Grep` | Pattern-based file finding / content search (ships its own bundled ripgrep) |
| `WebFetch` | Fetches a URL, converts to markdown, summarizes with a small fast model; 15-minute self-cleaning cache; auto-upgrades http→https |
| `WebSearch` | Web search |
| `Task` / `Agent` | Subagent dispatch (§3.4) |
| `TodoWrite` | Structured task-list state (model-managed, not runtime-enforced) |
| `ExitPlanMode`, `EnterPlanMode` | Explicit plan-mode transitions (§2) |
| `AskUserQuestion` | Structured multiple-choice elicitation from the user |
| `KillShell`, `BashOutput` | Manage/poll a backgrounded shell |
| `Skill` | Invoke a packaged skill |
| `ToolSearch` | Load full schemas for deferred tools (§3.1) |

**Extended surface** (background agents / agent teams / scheduling — present in
current builds, not part of the "naked" single-session loop): `SendUserMessage`,
`SendUserFile`, `PushNotification`, `Monitor`, `ScheduleWakeup`, `TaskList`,
`TaskCreate`, `TaskGet`, `TaskUpdate`, `TaskStop`, `TaskOutput`, `EnterWorktree`,
`ExitWorktree`, `Workflow`, `ListAgents`, `CronCreate`, `CronDelete`, `CronList`,
`ConnectGitHub`, `SendMessage`, `StructuredOutput`, `WaitForMcpServers`,
`RefreshMcpTools`, `EndConversation`.

File-edit safety rules observed directly in tool docstrings: writes under
`/.claude/**` or `~/.claude/**` are refused outright at the tool level (separate from
and prior to the "protected paths" permission-mode table in §4.2); a `Read`-deny rule
on a file blocks `Edit` on that same file even if an `Edit`-allow rule would otherwise
match. `--tools "Bash,Edit,Read"` restricts the built-in set for a session; `--tools
""` disables all tools; `--tools default` restores everything. **[binary, live]**

### 4.2 Permission system

**Modes** (`defaultMode` in settings, `--permission-mode` flag, `Shift+Tab` to cycle
interactively): **[docs]**

| Mode | Runs without asking | Notes |
|---|---|---|
| `default` (labeled **Manual** in every UI) | reads only | `manual` is an accepted alias for `default` everywhere (v2.1.200+) |
| `acceptEdits` | reads, file edits, common filesystem Bash (`mkdir`,`touch`,`rm`,`rmdir`,`mv`,`cp`,`sed`) scoped to cwd/`additionalDirectories` | protected-path writes still prompt |
| `plan` | reads only | edits stay blocked until a plan is approved; approving switches the session into one of `auto`/`acceptEdits`/manual-review |
| `auto` | everything, gated by a background classifier | see below; requires an eligible plan/model/provider |
| `dontAsk` | only tool calls matching pre-set `permissions.allow` rules, or approved by a `PreToolUse` hook | everything else is **auto-denied**, not prompted — for CI/locked-down use |
| `bypassPermissions` | everything | requires an explicit enabling flag at launch; refuses to start as root/sudo outside a recognized sandbox |

**Settings grammar.** `settings.json` `permissions` object: **[docs]**

```json
{
  "permissions": {
    "allow": ["Bash(npm run test *)", "Read(~/.zshrc)", "WebFetch(domain:example.com)"],
    "ask":   ["Bash(git push *)"],
    "deny":  ["Bash(curl *)", "Read(./.env)", "Read(./secrets/**)"],
    "defaultMode": "default"
  }
}
```

Matcher grammar is `Tool(matcher)`: exact command (`Bash(npm run lint)`), trailing
wildcard (`Bash(npm run test *)`), a bare `Bash(!)` (all bash), path globs for
`Read`/`Edit` (`Read(./secrets/**)`), and `WebFetch(domain:...)`. A real example from
this machine's own global settings (`~/.claude/settings.json`) shows the pattern in
use for MCP and Skill tools too: `"mcp__github__get_file_contents"`,
`"Skill(plugin-dev:hook-development)"`, `"WebFetch(domain:docs.anthropic.com)"`.
**[live]**

**File precedence** (highest to lowest): managed/enterprise settings (files under
platform-specific system directories, or pushed via MDM/server-managed settings) >
CLI arguments (session-scoped) > `.claude/settings.local.json` (gitignored) >
`.claude/settings.json` (committed, team-shared) > `~/.claude/settings.json` (user).
**Exception**: permission *rules* merge across every scope rather than the higher
scope overriding the lower one. **[docs]**

**Protected paths.** A fixed set of directories/files (`.git`, `.claude` except
`.claude/worktrees`, `.vscode`, `.idea`, `.husky`, shell rc files, `.npmrc`,
`.mcp.json`, `.claude.json`, etc.) is **never auto-approved for writes** in any mode
except `bypassPermissions` — and `permissions.allow` entries in settings cannot
override this; the safety check runs *before* allow-rule evaluation. **[docs]**

**Auto mode** (a distinct, newer overlay, not one of the four classic modes):
a server-selected classifier model (Sonnet 5 by default, independent of the session's
own `/model`) reviews every action that isn't a plain read or an in-scope working-
directory edit. It sees user messages, tool calls, and CLAUDE.md, but tool *results*
are stripped from what it sees specifically so that hostile content encountered mid-
task (prompt injection via a fetched file/page) can't manipulate the classifier
directly; a separate server-side probe scans incoming tool results for exactly that.
Decision order: (1) explicit allow/ask/deny rules resolve immediately, except
protected-path writes and org-`ask`-marked connector/MCP tools always route to a
human prompt regardless of an allow match; (2) in-scope reads/edits auto-approve;
(3) everything else goes to the classifier, which can block with a reason fed back to
the model. If the classifier blocks 3 times consecutively or 20 times total in a
session, auto mode **pauses itself** and reverts to interactive prompting (not
configurable) — in headless (`-p`) mode with no human available, repeated blocks
abort the run instead. Auto mode requires model + provider + plan/org eligibility
(current gate: Opus 4.6+/Sonnet 4.6+/Fable 5 on the first-party API; a narrower set on
Bedrock/Vertex/Foundry). **[docs]**

### 4.3 Hooks as a permission veto

`PreToolUse` and the more specific `PermissionRequest` are where a hook can override
the permission decision entirely, independent of the modes above:
`hookSpecificOutput.permissionDecision` ∈ `allow|deny|ask|defer`, with
`permissionDecisionReason` shown to the model on deny/ask. This is a *second*, hook-
level gate that runs regardless of what mode/classifier decided — settings-level
rules and hooks are two independently-evaluated veto layers over the same tool call.
Exit-code semantics apply here too (§6). **[docs]**

### 4.4 Sandboxing

Distinct from the permission system: sandboxing is **OS-level enforcement scoped to
the `Bash` tool and its child processes only** — `Read`/`Edit`/`Write` go through the
permission system directly and are never sandboxed. **[docs]**

| Platform | Mechanism |
|---|---|
| macOS | Seatbelt (`sandbox-exec`), no extra install |
| Linux, WSL2 | `bubblewrap` (filesystem) + `socat` (network relay) + an optional seccomp filter (blocks arbitrary Unix-domain-socket access) via `@anthropic-ai/sandbox-runtime` |
| Native Windows | **not supported** — run inside WSL2 |

Default boundary: read/write to cwd + the session's `$TMPDIR`; read access to
everything else on disk *except* explicit deny paths (default read access still
includes credential files like `~/.aws/credentials` and `~/.ssh/` unless
`sandbox.credentials` denies them explicitly — sandboxing does not blanket-protect
secrets); zero network domains pre-allowed, first use of a new domain prompts once per
session (or is silently blocked if `allowManagedDomainsOnly` is set by policy).
Settings schema: `sandbox.enabled`, `sandbox.failIfUnavailable`,
`sandbox.allowUnsandboxedCommands`, `sandbox.autoAllowBashIfSandboxed`,
`sandbox.filesystem.{allowRead,allowWrite,denyRead,denyWrite}`,
`sandbox.network.{allowedDomains,deniedDomains,httpProxyPort,socksProxyPort,tlsTerminate}`,
`sandbox.credentials.{files,envVars}` (per-entry `mode: deny|mask`), `excludedCommands`.
Escape hatch: a per-call `dangerouslyDisableSandbox: true` tool parameter lets the
model retry a sandbox-incompatible command through the *regular* permission flow
instead (auto mode's classifier still reviews it); `allowUnsandboxedCommands: false`
disables that hatch entirely ("Strict sandbox mode"). Two independent circuit breakers
survive even `bypassPermissions`/auto-allow: `rm -rf /`-shaped deletes always prompt,
and writes to Claude Code's own `settings.json` at every scope are always denied
inside the sandbox (symlink targets included, v2.1.210+). Subagents run in the same
process and inherit the parent session's sandbox configuration verbatim. **[docs]**

Sandboxing and permission modes are explicitly two independent axes: sandbox
"auto-allow" governs whether a sandboxed Bash call still stops for a prompt; permission
mode/auto-mode governs whether *any* tool call stops for a prompt; `--dangerously-skip-
permissions` (bypassPermissions) skips both prompt layers but not the OS sandbox
boundary itself if sandboxing is separately enabled. **[docs]**

---

## 5. Session persistence

### 5.1 Storage layout

`~/.claude/projects/<slug>/` where `<slug>` is the working-directory absolute path
with `/` replaced by `-` (e.g. `/home/ryan/dev/muster` → `-home-ryan-dev-muster`), one
directory per distinct cwd ever used, confirmed directly on this machine: **[live]**

```
~/.claude/projects/-home-ryan-dev-muster/
├── <session-id>.jsonl              # the transcript, one JSON object per line
├── <session-id>/                   # sidecar directory, same name as the transcript
│   ├── subagents/
│   │   ├── agent-<id>.jsonl        # a subagent's own turn-by-turn transcript
│   │   └── agent-<id>.meta.json    # {"agentType","description","toolUseId","parentAgentId","spawnDepth"}
│   └── tool-results/
│       └── <token>.txt             # large tool outputs offloaded out of the main
│                                    # transcript line and referenced by pointer
└── memory/
    ├── MEMORY.md                   # auto-memory entrypoint (see §7)
    └── <topic>.md
```

The scratchpad path this research agent was given
(`/tmp/claude-<uid>/-home-ryan-dev-muster/<session-id>/scratchpad`) uses the *same*
slug + session-id addressing scheme as the transcript directory — session identity is
the single organizing key across transcript storage, subagent storage, and scratch
storage. **[live]**

Auto-memory location is documented independently and matches exactly:
`~/.claude/projects/<project>/memory/`, where `<project>` is derived from the git
repo root (so all worktrees/subdirs of one repo share a single memory dir), containing
a `MEMORY.md` index plus topic files Claude creates on demand. **[docs, live]**

### 5.2 Transcript record schema

Every line is one JSON object; `type` discriminates the shape. Observed entry types in
one real, long-running session (counts from that session, illustrative of relative
frequency, not a spec): `assistant`, `user`, `attachment` (hook execution records),
`system` (e.g. `stop_hook_summary`), `queue-operation`, `mode`, `permission-mode`,
`last-prompt`, `ai-title`, `pr-link`, `file-history-snapshot`, `file-history-delta`,
`bridge-session`. **[live]**

Common envelope fields on conversational entries: `uuid`, `parentUuid` (forms the
message DAG — this is how branching/forking and subagent side-chains are threaded),
`isSidechain`, `sessionId`, `timestamp`, `cwd`, `gitBranch`, `version`, `userType`,
`entrypoint` (`cli`), `permissionMode`.

```jsonc
// a user turn
{ "type": "user", "uuid": "...", "parentUuid": "...", "promptId": "...",
  "message": { "role": "user", "content": "..." },
  "origin": { "kind": "human" }, "promptSource": "typed",
  "permissionMode": "bypassPermissions", "cwd": "...", "gitBranch": "...",
  "version": "2.1.210", "sessionId": "..." }

// an assistant turn — content array holds thinking/text/tool_use blocks (§3.2)
{ "type": "assistant", "uuid": "...", "parentUuid": "...",
  "message": { "model": "...", "id": "msg_...", "role": "assistant",
               "content": [ /* blocks */ ], "stop_reason": "tool_use",
               "usage": { "input_tokens": 0, "cache_creation_input_tokens": 0,
                          "cache_read_input_tokens": 0, "output_tokens": 0 } },
  "requestId": "req_..." }

// a hook execution record — every hook firing is logged as an "attachment"
{ "type": "attachment", "uuid": "...",
  "attachment": { "type": "hook_success", "hookName": "SessionStart:startup",
                  "hookEvent": "SessionStart", "exitCode": 0, "durationMs": 374,
                  "command": "...", "stdout": "...", "stderr": "" } }

// end-of-turn hook summary
{ "type": "system", "subtype": "stop_hook_summary", "hookCount": 1,
  "hookInfos": [ { "command": "...", "durationMs": 0 } ], "hookErrors": [],
  "preventedContinuation": false, "level": "suggestion" }

// PR association (set once a session's branch gets a PR opened against it)
{ "type": "pr-link", "prNumber": 37, "prUrl": "https://github.com/...",
  "prRepository": "...", "timestamp": "..." }
```

Skill invocations inject their body as a plain `text` content block inside a
**user**-role message (not a system message) — e.g. a skill's markdown appears
prefixed with `"Base directory for this skill: <path>\n\n# <Skill Name>\n..."`,
directly in the conversation the model sees. **[live]**

Large tool outputs are not always inlined: when a tool result would be large, the
transcript line's `content` is replaced by a short pointer and the actual bytes are
written to `<session-id>/tool-results/<token>.txt` — the harness spills oversized tool
output out of the hot transcript file rather than growing every line unboundedly.
**[live]** — this pattern is visible from the caller side too: this research agent's
own tool-use system reminded it that large outputs get written to exactly such a path
and offered `offset`/`limit` pagination into them.

### 5.3 Resume, continue, fork, session IDs

Session IDs are UUIDs (`--session-id <uuid>` lets a caller pin one explicitly). Flags:
**[live, `claude --help`]**

| Flag | Effect |
|---|---|
| `-r, --resume [value]` | resume by session ID, or open an interactive picker |
| `-c, --continue` | resume the most recent conversation in the current directory |
| `--fork-session` | when resuming, mint a **new** session ID instead of reusing the old one (used with `--resume`/`--continue`) |
| `--from-pr [value]` | resume the session linked to a given PR (via the `pr-link` transcript record, §5.2) or open a picker |
| `--no-session-persistence` | (print mode only) don't write a transcript at all; the session becomes unresumable |
| `--name <name>` | display name shown in the resume picker/terminal title |

A resumed session is **not** a fresh session replaying old messages — it's the *same*
transcript file, appended to. Direct evidence: resuming produces a literal new line
`{"type":"user","message":{"content":"resume <old-session-id>"}}` appended to
`<same-session-id>.jsonl`, and a companion `{"type":"bridge-session",
"bridgeSessionId":"cse_..."}` record. So "resume" in this build is implemented as an
in-place continuation with a bridge-session marker linking to whatever the resume
picker/UI resolved, rather than a copy-and-replay. **[live]**

`SessionStart` and `SessionEnd` hooks matcher on the *reason*: `SessionStart` matches
`startup|resume|clear|compact`; `SessionEnd` matches
`clear|resume|logout|prompt_input_exit`. **[docs]**

---

## 6. Hook lifecycle

### 6.1 Every hook event

31 named events exist in the current build (confirmed both in the binary's literal
event-name strings and in the fetched docs). **[docs, binary]**

| Event | Fires | Matches against | Can block (exit 2)? |
|---|---|---|---|
| `SessionStart` | session begins/resumes | source: `startup,resume,clear,compact` | no |
| `Setup` | `--init-only`/`-p --init`/`--maintenance` | CLI flag: `init,maintenance` | no |
| `UserPromptSubmit` | user submits a prompt, before processing | — | yes |
| `UserPromptExpansion` | a typed command expands into a prompt | command name | yes |
| `PreToolUse` | before a tool call executes | tool name | yes |
| `PermissionRequest` | a permission dialog appears | tool name | yes |
| `PermissionDenied` | auto-mode classifier denies a call | tool name | no |
| `PostToolUse` | after a tool call succeeds | tool name | no |
| `PostToolUseFailure` | after a tool call fails | tool name | no |
| `PostToolBatch` | after a parallel batch resolves | — | yes |
| `Notification` | Claude Code sends a notification | notification type | no |
| `MessageDisplay` | while assistant text is displayed | — | no |
| `SubagentStart` | a subagent is spawned | agent type | no |
| `SubagentStop` | a subagent finishes | agent type | yes |
| `TaskCreated` | a background task is created | — | yes |
| `TaskCompleted` | a background task completes | — | yes |
| `Stop` | Claude finishes responding (end of turn) | — | yes |
| `StopFailure` | turn ends due to API error | error type | no |
| `TeammateIdle` | agent-team teammate about to go idle | — | yes |
| `InstructionsLoaded` | CLAUDE.md/rules loaded | load reason | no |
| `ConfigChange` | a config file changes mid-session | config source | yes |
| `CwdChanged` | working directory changes | — | no |
| `FileChanged` | a watched file changes on disk | filenames | no |
| `WorktreeCreate` | worktree being created | — | yes |
| `WorktreeRemove` | worktree being removed | — | no |
| `PreCompact` | before context compaction | trigger: `manual,auto` | yes (blocks compaction) |
| `PostCompact` | after compaction completes | trigger: `manual,auto` | no |
| `Elicitation` | MCP server requests user input | server name | yes |
| `ElicitationResult` | after user responds to elicitation | server name | yes |
| `SessionEnd` | session terminates | reason: `clear,resume,logout,prompt_input_exit` | no |

Matchers with no matcher support at all (always fire): `UserPromptSubmit`,
`PostToolBatch`, `Stop`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`,
`WorktreeCreate`, `WorktreeRemove`, `MessageDisplay`, `CwdChanged`. Matcher syntax:
empty/`*` matches everything; letters/digits/`_`/`-`/spaces/`,`/`|` is an exact-or-
alternatives string match; anything else is an unanchored JS regex. **[docs]**

### 6.2 Input/output JSON and exit codes

Every hook receives on stdin (or HTTP POST body): `session_id`, `prompt_id` (UUID,
v2.1.196+), `transcript_path`, `cwd`, `permission_mode`, `effort.level`,
`hook_event_name`, plus event-specific fields (`tool_name`, `tool_input`,
`tool_response`, `matcher`, `prompt`, `source`; subagent hooks add `agent_id`,
`agent_type`). **[docs]**

Output JSON (all fields optional):

```jsonc
{
  "continue": true,                 // false halts the whole session with stopReason
  "stopReason": "...",
  "suppressOutput": false,
  "systemMessage": "shown to the human",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow|deny|ask|defer",   // PreToolUse only
    "permissionDecisionReason": "...",
    "additionalContext": "text injected into Claude's context"
  }
}
```

For events grouped as `decision: "block"` types (`PostToolUse`, `Stop`,
`SubagentStop`, `PreCompact`, etc.) the block signal is the top-level `decision`
field, not `hookSpecificOutput.permissionDecision` — the field name that carries the
veto differs by event family. **[docs]**

Exit codes: **0** = success; parse stdout as the JSON schema above, or — if it isn't
JSON — treat it as plain additional context, but *only* for `SessionStart`, `Setup`,
`SubagentStart` (every other event's plain-text stdout on exit 0 is silently
discarded, logged to debug only). **2** = blocking error: stdout/JSON is ignored,
stderr is shown to Claude as an error, and the action is blocked *if* that event
supports blocking (see table above — `SessionStart`, `PostToolUse`,
`PermissionDenied`, `Notification`, `PostCompact`, etc. cannot block regardless of
exit code). **Any other code** = non-blocking error: first line of stderr shown in
the transcript, full stderr in the debug log, execution continues regardless.
**[docs]**

Async hooks: `"async": true` backgrounds the hook without blocking the loop;
`"asyncRewake": true` additionally wakes Claude when the backgrounded hook later
exits 2, injecting its stdout/stderr as a system reminder — i.e. a hook can defer its
verdict and interrupt the session later rather than holding it up front. **[docs]**

### 6.3 Config grammar and merge order

```jsonc
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [
        { "type": "command", "command": "...", "timeout": 600,
          "if": "Bash(git push *)" }            // scope the hook itself with permission-rule syntax
      ] }
    ]
  }
}
```

Hook types: `command` (shell — exec form with `args:[]` = no shell/tokenization, vs.
shell form = full tokenization/pipes/expansion), `http` (POST with JSON
request/response, 2xx-empty/2xx-text/2xx-JSON/non-2xx/timeout each handled
distinctly), `mcp_tool` (calls an already-connected MCP tool, output re-parsed as hook
JSON if valid), `prompt` (asks a model a yes/no question with `$ARGUMENTS`
substituted, 30s default timeout), `agent` (dispatches a full agent to judge,
60s default timeout). Placeholders available in all types: `${CLAUDE_PROJECT_DIR}`,
`${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` (also exported as env vars).
**[docs]**

Merge order across scopes (all contribute, not override): managed policy > user
(`~/.claude/settings.json`) > project (`.claude/settings.json`) > local
(`.claude/settings.local.json`) > plugin `hooks/hooks.json` (when the plugin is
enabled) > skill/agent frontmatter (while that component is active). Enterprise
`allowManagedHooksOnly` restricts non-managed hooks except in force-enabled plugins.
**[docs]**

**A real, currently-running example** from this machine's own global settings
(`~/.claude/settings.json`), showing SessionStart / PreToolUse / Stop hooks wired to
an external tool (Serena), each guarded by a file-existence test so it's a no-op
outside projects that use it: **[live]**

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command",
      "command": "test -f .serena/project.yml && uvx --from git+https://github.com/oraios/serena serena-hooks activate || true" }] }],
    "PreToolUse": [{ "matcher": "", "hooks": [{ "type": "command",
      "command": "test -f .serena/project.yml && uvx --from git+https://github.com/oraios/serena serena-hooks remind || true" }] }],
    "Stop": [{ "hooks": [{ "type": "command",
      "command": "test -f .serena/project.yml && uvx --from git+https://github.com/oraios/serena serena-hooks cleanup || true" }] }]
  }
}
```

The interactive `/hooks` command opens a read-only browser of every configured hook,
labeled by source (User/Project/Local/Plugin/Session/Built-in) and count per event;
editing requires editing the underlying JSON directly. **[docs]**

---

## 7. Memory and instruction loading (tightly coupled to §3.1)

Two independent systems, both loaded at the start of every conversation as context
(not enforced configuration — a `PreToolUse` hook is the only *hard* enforcement
layer): **[docs]**

- **CLAUDE.md** (human-authored). Discovery walks the directory tree from cwd up to
  filesystem root; every `CLAUDE.md`/`CLAUDE.local.md` found along that walk is loaded
  in full at launch (root-to-cwd order, so the file closest to cwd is read *last* —
  i.e., takes the most immediate position in context). Files in *subdirectories below*
  cwd are not loaded at launch; they load lazily the first time Claude reads a file in
  that subdirectory. Import syntax `@path/to/file` expands recursively (max depth 4);
  `.claude/rules/*.md` supports the same idea with YAML `paths:` frontmatter to scope
  a rule to matching file globs, loading it only when Claude touches a matching file.
  Precedence for the four file-based scopes, broadest-to-narrowest in load order:
  managed policy → user (`~/.claude/CLAUDE.md`) → project (`./CLAUDE.md` or
  `./.claude/CLAUDE.md`) → local (`./CLAUDE.local.md`).
- **Auto memory** (model-authored). One directory per git repo root (shared across
  all worktrees of that repo):
  `~/.claude/projects/<project>/memory/{MEMORY.md,<topic>.md,...}`. Only the first 200
  lines / 25KB of `MEMORY.md` (whichever limit hits first) load at session start;
  topic files load on demand via ordinary `Read` calls. This exact structure is
  directly visible on this machine right now — `MEMORY.md` plus four topic files under
  `~/.claude/projects/-home-ryan-dev-muster/memory/`. **[live, matches docs exactly]**

Both survive compaction differently: project-root `CLAUDE.md` is explicitly re-read
from disk and re-injected post-`/compact`; nested CLAUDE.md/rules are not
automatically re-injected (§3.3).

---

## 8. CLI surface (selected flags)

Full reference from a live `claude --help` on 2.1.211 — most relevant to rebuilding
the harness's entry points: **[live]**

| Flag | Purpose |
|---|---|
| `-p, --print` | non-interactive, single-shot; combine with `--output-format json\|stream-json` |
| `--input-format stream-json` | realtime streaming input (print mode) |
| `--permission-mode <mode>` | `default\|acceptEdits\|plan\|auto\|dontAsk\|bypassPermissions` (aliases: `manual`≈`default`) |
| `--dangerously-skip-permissions` / `--allow-dangerously-skip-permissions` | force / make-available bypass mode |
| `-r/--resume`, `-c/--continue`, `--fork-session`, `--from-pr`, `--session-id <uuid>` | session addressing (§5.3) |
| `--agent`, `--agents <json>` | select/define subagents for the session |
| `--mcp-config`, `--strict-mcp-config` | load/limit MCP servers |
| `--add-dir` | grant additional directory access (CLAUDE.md from it loads only with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`) |
| `--bare` | minimal mode: skips hooks, LSP, plugin sync, attribution, auto-memory, background prefetches, keychain reads, CLAUDE.md auto-discovery |
| `--safe-mode` | disables all customizations (CLAUDE.md/skills/plugins/hooks/MCP/etc.) for troubleshooting; admin policy still applies |
| `--worktree [name]`, `--tmux` | create/attach an isolated git worktree (+ terminal panes) for the session |
| `--effort <level>` | `low\|medium\|high\|xhigh\|max` |
| `--fallback-model`, `--max-budget-usd`, `--json-schema` | print-mode reliability/cost/structured-output controls |
| `--setting-sources`, `--settings` | control which settings scopes load / inject extra settings |
| `--sandbox` / `--no-sandbox` | force sandboxing on/off for the session |
| `claude mcp ...` | add/list/remove/serve MCP servers |
| `claude agents ...` | manage background agents (a session-spawning layer distinct from in-session subagents) |
| `claude plugin ...` | install/enable/validate/eval plugins |
| `claude doctor` | health-check settings/config without a trust prompt |
| `claude auto-mode` | inspect the auto-mode classifier's configured defaults |

---

## 9. Summary: what a from-scratch rebuild needs

1. **One request/response loop**, not a state machine: assemble context → call the
   model → for each `tool_use` block, resolve permission (rules → hooks → sandbox) →
   execute → append `tool_result` → repeat until `stop_reason != tool_use` → fire
   `Stop`.
2. **A layered veto system** in front of every tool call: settings-file permission
   rules (merged across scopes) → permission mode / auto-mode classifier → a
   `PreToolUse`/`PermissionRequest` hook decision → (for `Bash` only) an OS-level
   sandbox boundary. Any layer can deny independent of the others.
3. **A transcript that is an append-only JSONL event log**, not just a message array:
   hook executions, mode changes, compaction events, and PR/session links are all
   first-class record types alongside conversational turns, addressed by a single
   `(cwd-slug, session-id)` key that also namespaces subagent transcripts, offloaded
   large tool output, and scratch storage.
4. **Compaction as a context-management concern, not a memory concern**: recent
   messages can be preserved verbatim while older ones are summarized; a small,
   explicit re-injection step (re-reading project CLAUDE.md) patches over what
   summarization would otherwise lose; a hook can veto compaction outright.
5. **Subagents as context isolation**, not just prompt delegation: a subagent is a
   nested instance of the same loop with its own budget, inheriting configuration
   (tools/MCP/skills) but not conversation history, and is subject to the same
   permission/classifier checks as the parent — including a pre-spawn check on the
   delegated task description itself.

---

## Sources

- `code.claude.com/docs/en/{hooks,settings,sandboxing,permission-modes,memory,
  sub-agents,context-window}` — fetched live, 2026-07-16.
- Live inspection of a running Claude Code 2.1.211 installation on this machine:
  `claude --help` and subcommand `--help` output; `~/.claude/settings.json`;
  `~/.claude/projects/-home-ryan-dev-muster/56871c7c-baa9-4297-b7e8-554b69aadf44.jsonl`
  and its sidecar `subagents/`/`tool-results/` directories; `~/.claude/projects/
  -home-ryan-dev-muster/memory/`.
- `strings` extraction from the installed binary
  (`~/.local/share/claude/versions/2.1.211`) for hook event names, permission-decision
  field names, the built-in tool registry and its docstrings, sandboxing
  implementation details (bubblewrap/seatbelt/seccomp), and system-prompt identity
  strings.
