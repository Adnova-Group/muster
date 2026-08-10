# Research: Orca — worktree IDE and orchestration runtime

Implementation-grade research for deciding how Muster can coexist with Orca.
Evidence tags used below:

- **[DOCUMENTED]** — stated in the official Orca documentation or public README.
- **[CODE-VERIFIED]** — confirmed in the pinned source snapshot, with a source
  label that resolves in the source index.
- **[INFERRED]** — an architectural interpretation or recommendation derived
  from the evidence; it is not an Orca compatibility promise.
- **[VERSION-SENSITIVE]** — true of the pinned release candidate and likely to
  change without a stable contract.
- **[UNRESOLVED]** — the documentation or source inspected here does not prove
  the claim.

## Scope and conclusion

This note covers the public Orca documentation and the source snapshot
`b09f7bd4314c66fcb2bba492833b53da67fa27a2` from `stablyai/orca`. The snapshot's
`package.json` reports version `1.4.177-rc.0` [src: package]. No Orca process was
launched, no agent was dispatched, no Orca database was opened, and no Orca
state was changed during this research.

The useful boundary is:

> Orca is the outer workspace/runtime layer: worktrees, terminal and PTY
> placement, session persistence, UI, remote execution, and agent placement.
> Muster remains the inner planning/orchestration layer: routing, crews,
> pipelines, manifests, receipts, review gates, and deterministic workflow
> policy.

Orca's structured orchestration is a separately documented optional
coordination plane. It should not replace Muster's graph or become an implicit
second owner of the same work. This is an [INFERRED] integration position, not
a claim that the two systems interoperate today.

## 1. Product identity and architecture

Orca describes itself as a desktop IDE for running multiple AI coding agents
side by side. Its public model gives each task a git worktree, an agent
terminal, and a browser tab; supported examples include Claude Code, Codex,
Cursor CLI, OpenCode, and other terminal agents [DOCUMENTED: [What is Orca](https://www.onorca.dev/docs)].
The repository README calls it an “AI Orchestrator” and identifies macOS,
Windows, and Linux builds [DOCUMENTED] [src: readme].

The source is an Electron/TypeScript application with a standalone `orca` CLI,
an in-process/main runtime, a daemon-backed PTY layer, renderer state, and
runtime RPC. The CLI does not directly own all state: it discovers a running
runtime, sends an authenticated request, validates a response envelope, and
prints the result [CODE-VERIFIED] [src: runtime-transport] [src: cli-format].

### Runtime topology

| Layer | Orca responsibility | Evidence | Muster implication |
|---|---|---|---|
| Desktop/web UI | Worktree cards, panes, editors, browser, diff/review, status, notifications | [DOCUMENTED] [src: readme] | Treat as presentation and operator control. |
| CLI | Selectors, terminal/worktree/file/browser control, automations, skills, orchestration | [DOCUMENTED] [CODE-VERIFIED] [src: cli-spec-index] | Prefer this stable boundary over internal RPC/database access. |
| Runtime RPC | Authenticated request/response and long-poll keepalives between CLI/client and runtime | [CODE-VERIFIED] [src: runtime-transport] | Do not couple to RPC envelopes in phase one. |
| Main runtime | Git/worktrees, terminal/session services, agent hooks, remote providers, orchestration DB | [CODE-VERIFIED] [src: main-runtime] | This is Orca-owned state. |
| PTY daemon | Terminal process ownership, output history, checkpoints, reattach | [DOCUMENTED] [CODE-VERIFIED] [src: daemon-session] | Start agents through Orca when Orca owns session lifecycle. |
| Agent CLI | Actual coding loop, provider session, skills/hooks/MCP behavior | [DOCUMENTED] | Muster compatibility depends on the selected agent's surfaces. |

Orca is not a model, a git replacement, or a managed VPS product. It runs
existing terminal-based agents and uses machines/accounts chosen by the user
[DOCUMENTED]. The important integration consequence is that “supported agent”
means “Orca can launch and observe a CLI,” not “the agent exposes every
Muster contract.”

### Supported agents and the compatibility ceiling

The supported-agent catalog includes provider-specific launchers such as Claude
Code, Codex, Cursor CLI, OpenCode, Gemini, Pi, Hermes, Copilot, and others, and
the custom-agent flow accepts an arbitrary terminal command [DOCUMENTED: [Supported agents](https://www.onorca.dev/docs/agents/supported),
[Add a custom CLI agent](https://www.onorca.dev/docs/agents/custom-cli)]. This
means Orca can host arbitrary terminal-based coding agents. It does not mean
those agents share a session transcript format, hook protocol, skill location,
MCP support, resume flag, working-directory contract, or permission model
[INFERRED]. A Muster adapter must probe the selected agent's surfaces instead
of keying integration solely on its display name.

## 2. Worktrees and filesystem topology

Orca is worktree-native. A repository has a base ref; a worktree has a
start-from ref, its own branch, its own files, and its own agent terminals.
The documented lifecycle is create → work → review → ship → archive/delete.
Creating a worktree runs `git fetch`/`git worktree add` in the background, and
the UI shows setup progress [DOCUMENTED: [Worktrees](https://www.onorca.dev/docs/model/worktrees)].

### Creation and lineage

- `orca worktree create` accepts a repository, name, base branch, linked issue,
  comment, setup decision, optional agent, and prompt [DOCUMENTED] [CODE-VERIFIED]
  [src: cli-worktree-handler].
- A child worktree can be inferred from the current Orca worktree/terminal, or
  declared with `--parent-worktree`; `--no-parent` makes it independent
  [CODE-VERIFIED] [src: cli-worktree-handler].
- Orca records lineage for CLI-created children and excludes stale, cyclic, or
  cross-host/repository links from descendant operations [DOCUMENTED:
  [Worktrees](https://www.onorca.dev/docs/model/worktrees)] [VERSION-SENSITIVE]
  [src: worktree-lineage].
- An external `git worktree add` remains external until imported. Removing a
  worktree with plain git is eventually reconciled by Orca [DOCUMENTED].

This is a real git worktree model, not a virtual branch overlay. A Muster
manifest must therefore record the concrete path, repository identity, branch,
and base/start SHA it believes it is operating on [INFERRED].

### Shared paths and `.worktreeinclude`

A fresh worktree does not contain gitignored dependencies, caches, or local
secrets. Orca has three distinct mechanisms [DOCUMENTED: [Worktrees](https://www.onorca.dev/docs/model/worktrees)]:

1. Per-user Worktree Shared Paths. These materialize from the primary checkout,
   using a clone-copy on macOS when possible or a symlink otherwise.
2. Repo-level `worktree.sharedDirectories` in `orca.yaml`. These are
   gitignored directories shared/symlinked across worktrees; they must exist as
   directories in the primary checkout.
3. A root `.worktreeinclude` file. It copies listed gitignored files or
   directories, giving each worktree its own copy.

The pinned code makes the third contract more precise: entries are
repo-relative literal paths; blank lines and comments are ignored; absolute,
parent-traversing, glob, and negation patterns are rejected or skipped; absent,
tracked, and non-ignored paths are not copied; resolution failure does not
block worktree creation [CODE-VERIFIED] [VERSION-SENSITIVE]
  [src: worktree-include].
`worktree.sharedDirectories` is loaded from `orca.yaml`, filtered to existing
gitignored directories, and combined with per-user shared paths [CODE-VERIFIED]
[src: worktree-shared].

Integration rule: Muster should not assume that a path means “copied” or
“shared.” It should classify it as tracked checkout content, Orca-linked
shared content, Orca-copied include content, or a Muster-owned artifact. A
receipt that needs independent reproducibility should avoid mutable shared
directories [INFERRED].

### Setup and cleanup hooks

Orca can run repository-defined setup commands after worktree creation and
supports repository hook configuration through `orca.yaml`/settings
[DOCUMENTED: [Agent hooks & memory](https://www.onorca.dev/docs/agents/hooks-memory)].
The CLI exposes `--setup run|skip|inherit` and `--run-hooks`; current/existing
worktrees do not rerun setup, while a new worker worktree defaults to setup
according to repository policy [CODE-VERIFIED] [src: cli-worker-spec].

Archive/delete can remove the worktree and branch. Hook execution is a
provider/repository policy surface, and the source includes trust, warning, and
remote installer logic [CODE-VERIFIED] [src: hooks]. Whether a particular hook
is safe to run from a Muster-created or CI-created worktree is
[UNRESOLVED] without inspecting that repository's configuration. The first
integration should make setup/cleanup ownership explicit and should not invoke
Orca hooks as an accidental side effect of a Muster receipt operation.

## 3. Terminals, panes, PTYs, sessions, and status

An Orca agent session is one CLI agent running in one terminal in one worktree.
Orca exposes tabs, split panes, terminal handles, bounded output reads, input,
waits, and terminal lifecycle controls [DOCUMENTED: [Agents & sessions](https://www.onorca.dev/docs/model/agents-sessions),
[CLI reference](https://www.onorca.dev/docs/cli/reference)]. The CLI's typed
specification includes `terminal list/show/read/send/wait/create/split/rename/
switch/close`; `read` has cursors and bounded limits [CODE-VERIFIED]
[src: cli-terminal-spec].

The terminal implementation is PTY-backed. A background daemon owns local PTYs,
while session/history components persist terminal output and checkpoint data
for reattach and cold restore [DOCUMENTED] [CODE-VERIFIED] [src: daemon-session]
[src: terminal-history]. The split/pane layout is separate UI/session state
from the process itself; a terminal handle is runtime-scoped and should be
reacquired after runtime restart [DOCUMENTED: [CLI reference](https://www.onorca.dev/docs/cli/reference)].
Agent Session History separately scans provider session stores and exposes past
sessions for manual resume; this is provider-specific discovery, not a generic
Muster transcript store [DOCUMENTED: [Agent session history](https://www.onorca.dev/docs/agents/session-history)]
[CODE-VERIFIED] [src: agent-session-history].

### Restore and hibernation

Normal app close, auto-update relaunch, and an Orca UI crash can preserve live
agents because the daemon survives and Orca warm-reattaches to the same PTYs.
A host reboot, kernel panic, hard power-off, or daemon death ends the running
processes, though worktrees, layout, and last-persisted scrollback restore on
the next launch [DOCUMENTED: [Session restore](https://www.onorca.dev/docs/model/session-restore)].

Agent hibernation is experimental and off by default. It stops eligible idle
agent terminals and resumes them with provider-specific resume flags when the
worktree is reopened. Only providers with resumable sessions are eligible;
Hermes, Cursor CLI, Copilot, and other non-resumable terminals remain running
[DOCUMENTED: [Agent hibernation](https://www.onorca.dev/docs/agents/hibernation)].
This is a major collision risk for a coordinator that assumes a worker process
is continuously attached [INFERRED].

### Status and notifications

Orca derives agent status from terminal/provider signals, including OSC titles
for supported agents. The UI distinguishes working, waiting, idle, and plain
shell/no recognized agent, and emits an agent-finished notification on a
working-to-idle transition [DOCUMENTED: [Agents & sessions](https://www.onorca.dev/docs/model/agents-sessions)].
This status is observational, not a proof of Muster task completion. A worker
can be idle while it has not produced a receipt, and a terminal can remain live
after a task is marked complete [CODE-VERIFIED] [src: cli-worker-spec].

## 4. CLI, selectors, JSON, automation, skills, MCP, hooks, and memory

### CLI selectors and runtime discovery

The public CLI examples and pinned specification support `orca status --json`,
`orca open --json`, `orca serve`, repository and worktree commands, terminal
commands, files, browser automation, automations, environments, agent hooks,
and orchestration. Examples in this document are limited to commands present
in the pinned command specs or official reference [DOCUMENTED] [CODE-VERIFIED].

Selectors include `id:`, `path:`, `branch:`, `issue:`, `name:`, and aliases such
as `active`/`current`. Local `active`/`current` resolution means the enclosing
managed worktree. For a remote runtime, the local current directory cannot
identify a server-side path; callers must pass an explicit server-side selector
such as `id:<repo-id>::<absolute-path>` or `path:<absolute-server-path>`
[DOCUMENTED: [CLI reference](https://www.onorca.dev/docs/cli/reference)]
[CODE-VERIFIED] [src: selectors].

`orca agent-context --json` is a generated schema from the live command
specification. It includes schema version, command count, paths, aliases,
usage, flags, examples, and notes [CODE-VERIFIED] [src: agent-context]. This
is a better discovery mechanism for an adapter than scraping help text, though
it remains versioned Orca behavior rather than a Muster contract.

All normal CLI success and failure results support `--json`; the pinned formatter
serializes the runtime response rather than a best-effort human string
[CODE-VERIFIED] [src: cli-format]. JSON should be treated as the machine
boundary, with explicit schema/version checks and preserved raw receipts
[INFERRED].

Useful documented examples include:

```sh
orca status --json
orca worktree current --json
orca worktree show --worktree path:/abs/path/to/worktree --json
orca terminal read --terminal <handle> --cursor <cursor> --limit 1000 --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 300000 --json
orca file open-changed --mode both --worktree active --json
```

### Scheduled automation and hooks

Orca has scheduled automations that can create/run prompts against a repository
or worktree, and the CLI exposes `automations list/create/run`. Automations can
create workspaces and dispatch to a chosen provider [DOCUMENTED: [Scheduled automations](https://www.onorca.dev/docs/cli/automations)]
[CODE-VERIFIED] [src: automations]. They are a second possible task producer;
Muster should not enable them for a Muster-owned graph without an explicit
ownership agreement [INFERRED].

Orca reads per-repository `.claude/` and `.codex/` configuration and runs hooks
that those agent systems expose when it launches agents. It also maintains
Orca-managed hook endpoints on disk so long-lived sessions can reconnect to a
new runtime after restart [DOCUMENTED: [Agent hooks & memory](https://www.onorca.dev/docs/agents/hooks-memory)]
[CODE-VERIFIED] [src: hooks]. Provider hook payloads and trust behavior are
provider-specific; they are not interchangeable with Muster's review gates.

### Skills and MCP

The public registry distributes Orca CLI capabilities as installable `SKILL.md`
packages, including `orca-cli`, `orchestration`, `computer-use`, `orca-linear`,
and `orca-emulator`. The documented install form is, for example:

```sh
npx skills add https://github.com/stablyai/orca --skill orca-cli
npx skills add https://github.com/stablyai/orca --skill orchestration
```

[DOCUMENTED: [Skills registry & MCP](https://www.onorca.dev/docs/cli/skills)].
The pinned source scans bounded skill roots for `SKILL.md`, canonicalizes paths,
deduplicates provider/source identities, and supports plugin skill sources
[CODE-VERIFIED] [src: skill-discovery]. MCP endpoints are registered under
Orca integrations and are then made available to agents that support MCP
[DOCUMENTED]. There is no evidence here that every supported agent consumes
the same MCP or skill installation location [UNRESOLVED].

### Memory and context

Orca leaves agent-owned `AGENTS.md` and `CLAUDE.md` files in place and surfaces
them in the file explorer. It also reads repo-level agent configuration and
worktree setup data [DOCUMENTED: [Agent hooks & memory](https://www.onorca.dev/docs/agents/hooks-memory)].
Those files are context for the selected agent, not a durable Muster plan or
receipt. Muster should keep authoritative state in its own manifest/receipt
paths and use agent context files only for instructions that are safe to be
advisory [INFERRED].

## 5. Remote execution and federation

Orca documents four broad run modes: local desktop, SSH target, self-hosted
Remote Orca Server, and an on-demand per-workspace environment/VM. The machine
and cloud account are user-controlled; Orca is not a managed VPS service
[DOCUMENTED: [Ways to run Orca](https://www.onorca.dev/docs/ways-to-run)].

### Local, headless, and SSH

- `orca serve --port <port> --pairing-address <address> --json` starts a
  foreground runtime without opening the desktop window, for a headless or
  Remote Orca Server deployment [DOCUMENTED] [src: cli-serve].
- With SSH, Orca creates the git worktree and runs the agent on the remote host;
  the local UI streams file events and diff state. Disconnects are intended to
  preserve remote agents and allow terminal reattachment [DOCUMENTED: [SSH worktrees](https://www.onorca.dev/docs/ssh)].
- Remote terminal sessions are leased through the remote relay. The pinned
  source has remote runtime transport, heartbeat, watcher, PTY, and pairing
  code, but the exact lease and version-skew behavior is release-sensitive
  [CODE-VERIFIED] [VERSION-SENSITIVE] [src: remote-runtime].

### Remote Orca servers and environments

A Remote Orca Server is another Orca runtime reachable through a pairing/link
flow. A per-workspace environment can provision a disposable cloud sandbox,
VM, or local Docker-like runtime from a checked-in recipe (`orca.yaml` and
lifecycle scripts) [DOCUMENTED: [Ways to run Orca](https://www.onorca.dev/docs/ways-to-run)].
The source also has saved environment selectors, remote runtime metadata,
pairing fingerprints, and server-side orchestration calls [CODE-VERIFIED]
[src: remote-runtime] [src: orchestration-environment].

### Orchestration federation

The pinned orchestration layer can relay worker messages across an Orca server
boundary. Federation stores the peer fingerprint, checks it on use, pulls
contiguous sequence-numbered messages, imports them idempotently, and
acknowledges the imported sequence. Worker reports are validated against the
task and dispatch IDs before they can complete a task [CODE-VERIFIED]
[VERSION-SENSITIVE] [src: federation-sync]. This is an Orca-internal
coordination feature, not a general inter-process API for Muster.

Remote identity matters: local cwd selectors are invalid against a remote
runtime, and the same visible path may be meaningless on the server. Any
Muster integration that crosses a remote boundary needs a server-side
worktree identity and a declared host/environment identity [INFERRED].

## 6. Orca orchestration model

The official CLI reference directs users to Orchestration for tracked
multi-agent dispatch instead of ad hoc terminal prompts. The current command
surface in the pinned snapshot is more explicit than that short description.

### Primitives

| Primitive | Meaning in the pinned snapshot | Evidence |
|---|---|---|
| Run | Lightweight namespace and home inbox; creation/binding does not schedule or place workers | [CODE-VERIFIED] [src: orchestration-spec] |
| Task | Durable unit with `pending`, `ready`, `dispatched`, `completed`, `failed`, or `blocked` status; dependencies can be declared | [CODE-VERIFIED] [src: orchestration-spec] [src: orchestration-types] |
| Dispatch | Assignment/context for a task to a terminal/worker; the dispatch identity is used for exact reports and messages | [CODE-VERIFIED] [src: orchestration-spec] [src: orchestration-types] |
| Worker | Supervised agent terminal launched with an agent or existing terminal, optional model/effort, worktree placement, setup, timeout, and retry linkage | [CODE-VERIFIED] [src: worker-spec] |
| Message | Typed durable mail such as status, dispatch, worker_done, handoff, escalation, decision_gate, question, and heartbeat | [CODE-VERIFIED] [src: orchestration-types] |
| Wait | `check --wait` blocks for matching messages, uses a timeout, and emits keepalive lines; `ask` blocks for a coordinator answer | [CODE-VERIFIED] [src: orchestration-spec] |
| Gate | A question/options gate blocks a task until a resolution is recorded | [CODE-VERIFIED] [src: orchestration-spec] [src: orchestration-gates] |

The command specification includes:

```text
orca orchestration run-create --objective <text> --json
orca orchestration task-create --spec <text> --deps <json_array> --json
orca orchestration dispatch --task <task_id> --to <handle> --json
orca orchestration worker-start --task <task_id> --agent <agent> --json
orca orchestration check --wait --timeout-ms <n> --json
orca orchestration gate-create --task <task_id> --question <text> --json
orca orchestration gate-resolve --id <gate_id> --resolution <text> --json
```

These examples are source-backed, but the exact schema and lifecycle are
version-sensitive because the repository labels some older coordinator commands
as retired. In particular, `coordinator-start`/`coordinator-stop` are retained
as recovery-oriented aliases that perform no effects and point callers to the
current lightweight primitives [CODE-VERIFIED] [VERSION-SENSITIVE]
[src: orchestration-spec].

### Worker lifecycle and recovery

The worker specification separates task state from terminal resource state.
`worker-stop` fences and stops the exact supervised agent terminal; it does not
delete the worktree or unrelated terminals. `worker-abandon` fences without
claiming that the process stopped. `worker-release` closes only a proven
coordinator-owned agent terminal after settlement and preserves an inspectable
output archive; `worker-retain` records an explicit exception for debugging
[CODE-VERIFIED] [src: worker-spec] [src: worker-terminal-ownership].

Worker output can be read from an exact provider transcript or bounded terminal
fallback. The source clips transcript size, removes local image paths,
redacts dispatch capability tokens, and makes transcript-derived identifiers
opaque [CODE-VERIFIED] [src: worker-transcript]. This is strong evidence that
Orca treats worker observation and resource cleanup as separate reliability
problems.

Dispatch retries link to a prior dispatch but do not inherit placement; callers
must repeat the intended server/worktree/agent choices [CODE-VERIFIED]
[src: worker-spec]. Setup has readiness gates, and worker startup returns
effects/residual resources/recovery information for partial failure
[CODE-VERIFIED] [src: worker-spec].

### Dependencies, questions, and gates

Task dependencies are represented in the Task graph, while messages and
questions are the communication plane. `check --ack` acknowledges a whole
delivery batch; `--peek` does not mark messages read; `--wait` leaves a timed-out
question pending so it can be resumed [CODE-VERIFIED] [src: orchestration-spec].
This is not the same as a deterministic review gate: Orca can record a
decision, but the source inspected here does not establish Muster's
manifest/receipt policy, reviewer quorum, or fix-loop arithmetic.

### Optional coordination plane, not automatic replacement

Orca orchestration is useful when Orca owns the worktree and worker placement,
or when a user wants Orca's UI, dispatch visibility, and remote federation.
Muster should only map its own entities to these primitives after a stable
contract exists. Until then, run Orca orchestration and Muster orchestration as
separate planes with one declared owner for each task graph [INFERRED].
The public workflow is described in [Orchestration](https://www.onorca.dev/docs/cli/orchestration);
the source snapshot is the stronger authority for the exact command and state
shapes documented here.

### Legacy migration and authority takeover

The pinned source retains compatibility machinery for an older coordinator and
legacy direct-delivery messages. The current CLI labels the old coordinator
start/stop commands retired, exposes `--takeover-legacy` on Run binding, and
marks legacy messages read-only unless an explicit compatibility takeover is
active [CODE-VERIFIED] [VERSION-SENSITIVE] [src: orchestration-spec]
[src: orchestration-compatibility]. This matters for coexistence: a Muster
adapter must not “take over” an Orca legacy coordinator just because it can see
its messages. Migration requires an explicit owner decision and a recorded
authority transition [INFERRED].

## 7. Review, attribution, shipping, browser, artifacts, and notifications

Orca's documented worktree lifecycle includes a diff view against the
start-from ref, Annotate AI Diff, Attribution, commit/push, PR creation, and
checks. It also provides per-worktree browser tabs, browser automation, design
mode, and file/diff commands [DOCUMENTED: [Worktrees](https://www.onorca.dev/docs/model/worktrees),
[CLI overview](https://www.onorca.dev/docs/cli/overview)].

The pinned source has distinct modules for source-control actions, attribution,
browser sessions, artifacts, notifications/inbox, and automated workspace
provenance [CODE-VERIFIED] [src: review-and-ship]. The source includes artifact
sharing/cloud records and terminal attribution paths, but the exact hosted
artifact retention and account behavior are not a stable integration contract
[VERSION-SENSITIVE] [UNRESOLVED].

The primary coexistence hazard is direct Orca commit/push: Orca can ship a
worktree while bypassing a Muster review gate or receipt. In a Muster-owned
workflow, Orca review is an observation/UI aid and Muster's commit/push policy
remains authoritative. In an Orca-owned workflow, Muster must not silently
assume that a commit or PR passed Muster gates [INFERRED].

## 8. Telemetry and privacy

The official telemetry page says packaged Orca builds collect anonymous product
usage keyed by a local random ID, with version/platform and coarse feature
events. It says Orca does not transmit file contents, prompts, agent output,
terminal output, repo names, branch names, URLs, paths, or commit messages;
`DO_NOT_TRACK=1` and `ORCA_TELEMETRY_DISABLED=1` disable transmission
[DOCUMENTED: [Privacy & Telemetry](https://www.onorca.dev/docs/telemetry)].
The policy identifies PostHog Cloud as the vendor/US region and says raw
diagnostic detail remains local unless a diagnostic bundle is explicitly
shared [DOCUMENTED].

The pinned source includes telemetry consent, event schemas, client lifecycle,
burst caps, and PostHog integration [CODE-VERIFIED] [src: telemetry]. This
does not prove that a separately installed agent, MCP server, provider, or
Muster process has the same privacy behavior. Do not put receipt contents,
prompts, or task payloads into Orca free-form telemetry fields [INFERRED].

## 9. Source index and cross-checks

All GitHub source links below are pinned to the research commit rather than
`main`, so future work can diff behavior instead of silently treating it as
stable.

| Label | Pinned source |
|---|---|
| [src: package] | [`package.json`](https://github.com/stablyai/orca/blob/b09f7bd4314c66fcb2bba492833b53da67fa27a2/package.json) |
| [src: readme] | [`README.md`](https://github.com/stablyai/orca/blob/b09f7bd4314c66fcb2bba492833b53da67fa27a2/README.md) |
| [src: main-runtime] | [`src/main/runtime`](https://github.com/stablyai/orca/tree/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/main/runtime) |
| [src: runtime-transport] | [`src/cli/runtime/transport.ts`](https://github.com/stablyai/orca/blob/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/cli/runtime/transport.ts) |
| [src: cli-format] | [`src/cli/format.ts`](https://github.com/stablyai/orca/blob/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/cli/format.ts) |
| [src: cli-spec-index] | [`src/cli/specs`](https://github.com/stablyai/orca/tree/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/cli/specs) |
| [src: cli-terminal-spec] | [`src/cli/specs/core.ts`](https://github.com/stablyai/orca/blob/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/cli/specs/core.ts) |
| [src: cli-worktree-handler] | [`src/cli/handlers/worktree.ts`](https://github.com/stablyai/orca/blob/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/cli/handlers/worktree.ts) |
| [src: selectors] | [`src/cli/selectors.ts`](https://github.com/stablyai/orca/blob/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/cli/selectors.ts) |
| [src: agent-context] | [`src/cli/agent-context.ts`](https://github.com/stablyai/orca/blob/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/cli/agent-context.ts) |
| [src: orchestration-spec] | [`src/cli/specs/orchestration.ts`](https://github.com/stablyai/orca/blob/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/cli/specs/orchestration.ts) |
| [src: worker-spec] | [`src/cli/specs/orchestration-worker-specs.ts`](https://github.com/stablyai/orca/blob/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/cli/specs/orchestration-worker-specs.ts) |
| [src: orchestration-types] | [`src/main/runtime/orchestration/types.ts`](https://github.com/stablyai/orca/blob/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/main/runtime/orchestration/types.ts) |
| [src: orchestration-db] | [`src/main/runtime/orchestration/db.ts`](https://github.com/stablyai/orca/blob/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/main/runtime/orchestration/db.ts) |
| [src: orchestration-gates] | [`src/main/runtime/rpc/methods/orchestration-gates.ts`](https://github.com/stablyai/orca/blob/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/main/runtime/rpc/methods/orchestration-gates.ts) |
| [src: federation-sync] | [`src/main/runtime/orchestration/federation-sync.ts`](https://github.com/stablyai/orca/blob/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/main/runtime/orchestration/federation-sync.ts) |
| [src: orchestration-environment] | [`src/main/runtime/orchestration/environment-transport.ts`](https://github.com/stablyai/orca/blob/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/main/runtime/orchestration/environment-transport.ts) |
| [src: worker-terminal-ownership] | [`src/main/runtime/orchestration/worker-terminal-ownership.ts`](https://github.com/stablyai/orca/blob/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/main/runtime/orchestration/worker-terminal-ownership.ts) |
| [src: worker-transcript] | [`src/main/runtime/orchestration/worker-transcript-payload.ts`](https://github.com/stablyai/orca/blob/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/main/runtime/orchestration/worker-transcript-payload.ts) |
| [src: cli-worker-spec] | [`src/cli/specs/orchestration-worker-specs.ts`](https://github.com/stablyai/orca/blob/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/cli/specs/orchestration-worker-specs.ts) |
| [src: worktree-include] | [`src/main/git/worktree-include-file.ts`](https://github.com/stablyai/orca/blob/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/main/git/worktree-include-file.ts) |
| [src: worktree-shared] | [`src/main/git/worktree-shared-directories.ts`](https://github.com/stablyai/orca/blob/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/main/git/worktree-shared-directories.ts) |
| [src: worktree-lineage] | [`src/cli/handlers/worktree-lineage-summary.ts`](https://github.com/stablyai/orca/blob/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/cli/handlers/worktree-lineage-summary.ts) |
| [src: daemon-session] | [`src/main/daemon/session.ts`](https://github.com/stablyai/orca/blob/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/main/daemon/session.ts) |
| [src: terminal-history] | [`src/main/daemon/terminal-history-log.ts`](https://github.com/stablyai/orca/blob/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/main/daemon/terminal-history-log.ts) |
| [src: agent-session-history] | [`src/main/ai-vault`](https://github.com/stablyai/orca/tree/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/main/ai-vault) |
| [src: remote-runtime] | [`src/shared/remote-runtime-client.ts`](https://github.com/stablyai/orca/blob/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/shared/remote-runtime-client.ts) |
| [src: hooks] | [`src/main/agent-hooks`](https://github.com/stablyai/orca/tree/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/main/agent-hooks) |
| [src: skill-discovery] | [`src/main/skills/discovery.ts`](https://github.com/stablyai/orca/blob/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/main/skills/discovery.ts) |
| [src: automations] | [`src/main/automations`](https://github.com/stablyai/orca/tree/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/main/automations) |
| [src: review-and-ship] | [`src/main/source-control`, `attribution`, `artifacts`, `browser`](https://github.com/stablyai/orca/tree/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/main) |
| [src: telemetry] | [`src/main/telemetry`](https://github.com/stablyai/orca/tree/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/main/telemetry) |
| [src: orchestration-compatibility] | [`src/main/runtime/rpc/orchestration-legacy-compatibility.ts`](https://github.com/stablyai/orca/blob/b09f7bd4314c66fcb2bba492833b53da67fa27a2/src/main/runtime/rpc/orchestration-legacy-compatibility.ts) |

### Explicit gaps

- No live interoperability test was run. In particular, this note does not
  prove that a Muster process can discover, join, or safely co-own an Orca Run,
  Task, Dispatch, worker terminal, or federation channel.
- The stable public contracts for RPC, orchestration DB schema, federation
  wire behavior, plugin installation locations, remote path mapping, and
  artifact retention are not established by this research.
- Supported-agent launch flags and session parsers are provider-specific and
  may change between RCs. “Arbitrary terminal-based agent” is a product shape;
  complete Muster integration still depends on that agent's working-directory
  behavior, skills, MCP, hooks, transcript, and resume support.
- Direct use of Orca's internal RPC or SQLite database is intentionally out of
  scope for the first integration proposal. Stable CLI, filesystem, skills,
  MCP, hooks, and JSON surfaces are preferred.

The next document, [Orca–Muster integration strategy](../strategy/orca-muster-integration.md),
turns these findings into an authority matrix and phased adoption plan.
