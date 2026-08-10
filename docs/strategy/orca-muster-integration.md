# Strategy: Orca–Muster coexistence

This strategy proposes additive coexistence between Orca and Muster. It is
based on the pinned Orca research snapshot `b09f7bd4314c66fcb2bba492833b53da67fa27a2`
(`1.4.177-rc.0`) and the official Orca documentation. Sections written before
Phase 2.5 made no live-interoperability claims; Phase 2.5 and the environment
capture in `docs/research/orca.md` have since verified the marked surfaces
against a live Orca 1.4.177 runtime (WSL host). Where an older passage below
says a name or shape is "unverified", the research document's [OBSERVED]
capture supersedes it.

## Decision

Use Orca as the outer runtime and Muster as the inner judgment/planning layer.
Keep the first integration additive and CLI/filesystem-based:

- Orca owns Orca-created worktrees, terminal/PTY placement, session restore,
  remote runtime selection, and UI state.
- Muster owns Muster-created plans, manifests, receipts, routing, crews,
  review gates, and deterministic workflow policy.
- Orca's Run/Task/Dispatch orchestration is optional. It is not an automatic
  replacement for a Muster graph.
- Neither system may silently commit, push, delete, or dispatch on behalf of
  the other system's authority.

This keeps the systems composable while contracts are still release-sensitive.

## 1. Authority matrix

The “owner” column means the system may create, mutate, and declare completion
for that concern. The other system may observe it only through an explicit
adapter or user action.

| Concern | Default owner | Allowed observer/integration | Boundary rule |
|---|---|---|---|
| Orca-created worktrees | Orca | Muster | Muster records exact path/id and base SHA when Orca reports one; the merge gate may emit an explicit public-CLI cleanup disposition after merge, but never removes implicitly and never deletes a branch itself. |
| Muster-created worktrees | Muster | Orca, after import/registration | Orca may provide terminals/UI; Muster remains responsible for lifecycle and receipts. |
| Terminal tabs, panes, PTYs | Orca | Muster | Use Orca CLI handles and status; never infer task completion from idle alone. |
| Session restore/hibernation | Orca | Muster | Reacquire terminal identity after restore; resume is provider-specific. |
| Task graph / plan | Muster by default | Orca status bridge | One graph has one owner. Do not mirror mutable status bidirectionally. |
| Orca Run/Task/Dispatch graph | Orca, only when explicitly selected | Muster adapter | Treat as a separate optional graph until a mapping contract exists. |
| Agent dispatch | Muster for Muster waves; Orca for Orca orchestration | The other system may launch only by explicit handoff | Never let both systems dispatch the same logical task. |
| Agent placement / remote host | Orca for Orca runtime placement | Muster records placement | Muster may request a target through CLI, but does not reach into Orca internals. |
| Planning, routing, crew composition | Muster | Orca UI/terminal | Orca is not the source of truth for Muster judgment. |
| Receipts and artifact provenance | Muster | Orca can display/report paths | Receipts include worktree, base SHA, task/worker identity, and verification. |
| Review gates / fix loops | Muster | Orca diff, annotation, and status | Orca decision gates are not Muster review gates without an explicit adapter. |
| Commit/push/PR | Workflow owner; Muster for Muster-owned work | Orca UI may provide the action | Orca direct ship actions must be disabled or treated as an explicit handoff when Muster gates apply. |
| Worktree comments/checkpoints | Orca for Orca cards | Muster may write a bounded progress summary | Comments are human status, never receipts or completion authority. |
| Remote federation | Orca | Muster via CLI/filesystem bridge | Do not depend on Orca's internal federation DB/wire protocol in phase one. |

If ownership cannot be determined from context, stop at observation and ask for
an explicit workflow mode. An ambiguous owner is itself a failed integration
precondition.

## 2. Coexistence workflows

### A. Muster launched inside an Orca terminal

This is the lowest-risk path and the recommended first user experience.

1. Orca creates or opens a worktree and launches the selected terminal agent.
2. The agent starts Muster from that terminal, inheriting `PWD`, Orca context,
   and any agent-visible `AGENTS.md`/skill/MCP configuration.
3. Muster plans, routes, dispatches its own wave, writes its own manifest and
   receipts, and treats the current Orca worktree as an execution context.
4. Muster may call the `orca` CLI for bounded status/checkpoint operations,
   using `--json` and explicit selectors.
5. Muster completes its review gate and commit policy. Orca displays the diff,
   terminal, browser, and session state but does not become the gate owner.

Recommended bootstrap probes:

```sh
pwd
orca status --json
orca worktree current --json
```

The adapter should persist the returned Orca worktree identity and path in the
Muster manifest. If the commands fail, Muster can still run as a normal
terminal workflow, but it must mark Orca context as unavailable rather than
guessing identity.

### B. Orca creates worktrees; Muster operates within each

This mode is appropriate when a user wants Orca's worktree sidebar, setup
hooks, remote placement, and session persistence while each worktree runs a
Muster-owned slice.

1. Orca creates the worktree with the desired repo/base/host/setup policy.
2. Orca launches a terminal agent in that worktree.
3. Muster receives the concrete worktree path and records Orca's identity,
   branch, start-from ref, host/environment, and setup result.
4. Muster creates a manifest whose task IDs are independent of Orca card names
   and comments. Its receipt path lives inside the worktree or an explicitly
   shared Muster state root.
5. Orca's worktree comment may be updated with a short human checkpoint, but
   the full result remains in the Muster receipt.
6. Muster closes its task/receipt and, when the existing merge gate passes,
   emits the exact post-merge cleanup disposition. Orca executes the public
   CLI operation, which removes the worktree and its branch together; nothing
   is removed implicitly and Muster never deletes a branch itself.

The adapter must classify `.worktreeinclude`, shared directories, generated
dependencies, and secrets before declaring a receipt reproducible. A shared
`node_modules` or cache is not an independent worker artifact. The vocabulary
follows Orca's three documented mechanisms — `tracked`, `orca-shared-link`
(Worktree Shared Paths and `worktree.sharedDirectories`, which symlink or
clone-copy), `orca-include-copy` (`.worktreeinclude`, which copies), and
`worker-owned` — alongside the content hints that carry the reproducibility
signal. An Orca classification Muster does not recognize is recorded as
`unknown` with the raw term preserved, never rejected.

### C. Orca orchestration supervises Muster-created workers

This is possible as an optional coordination mode, but it needs stronger
identity discipline.

1. Muster creates the plan and declares the logical worker/task set.
2. Muster creates or selects worker worktrees and writes a dispatch manifest.
3. Orca is asked explicitly to place/supervise a worker in each declared
   worktree, using the CLI's worker-start/terminal surfaces or a user-approved
   Orca orchestration Run.
4. The worker runs Muster's leaf command/skill and must write a Muster receipt
   containing the logical task ID, physical worktree identity, base SHA, changed
   files, and verification.
5. Orca reports terminal/process state and can retain/archive worker output.
6. Muster remains the only system that converts the receipt into graph
   completion and advances the next wave.

Do not map one Muster task to both an Orca Dispatch and a separate Muster
Dispatch without a stable correlation contract. A safe initial correlation is
an immutable `muster_task_id`/`muster_attempt_id` passed as an explicit prompt,
environment value, or report field, while Orca's IDs remain observational.

### D. Muster coordinates; Orca provides UI, remote, and sessions

This is the preferred deeper coexistence shape once the CLI bridge is proven.

Muster remains the coordinator. Orca provides:

- a local or headless runtime;
- worktree/terminal placement;
- remote SSH/server/VM selection;
- session persistence and hibernation where the provider supports resume;
- diff review, browser/design surfaces, notifications, and bounded terminal
  output.

Muster talks only through the supported CLI/filesystem/skills/MCP surfaces.
Muster records the Orca runtime/worktree/terminal identifiers it observes and
reacquires handles after restore or reconnect. Orca does not need to know the
Muster graph for this workflow.

## 3. Integration surfaces

### CLI invocation

Phase one should use documented commands such as:

```sh
orca status --json
orca worktree current --json
orca worktree show --worktree id:<id> --json
orca terminal list --worktree id:<id> --json
orca terminal read --terminal <handle> --cursor <cursor> --limit 1000 --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 300000 --json
```

`orca worktree set --worktree id:<id> --comment "muster: receipt ready" --json`
was listed here in the original plan as the checkpoint-comment channel. The
implementation deliberately shipped read-only: `muster orca …` exposes no
mutating Orca subcommand, so the comment channel is deferred until a phase
that needs it, not silently dropped.

Use `orca agent-context --json` to discover the installed command schema when
available. Pin the minimum schema/version expected by the adapter and fail
closed to read-only behavior on an incompatible schema. `agent-context` is not
in Orca's public CLI reference, so it is a capability probe and never a gate: a
build that does not ship it must still be discoverable through `status` and
`worktree current`, which are the bootstrap probes above. A version at or above
the pinned minimum is recorded and accepted — every command used here is
read-only, and the shape checks on the fields actually read are what fail closed
on a breaking change.

### Environment and context discovery

At startup, record (without treating all values as trustworthy authority):

- `PWD`/current path and the enclosing Orca worktree from `worktree current`;
- Orca worktree/repository/branch/base-ref identity from JSON;
- `ORCA_WORKTREE_ID`, `ORCA_TERMINAL_HANDLE`, and `ORCA_PANE_KEY` when present.
  These are still not documented by Orca, but the live capture
  (`docs/research/orca.md`) observed them in a launched terminal;
  `ORCA_WORKSPACE_ID` was assumed here and confirmed **absent** — the adapter
  keeps it only as a defensive fallback. Absence of any variable must be normal
  and CLI identity always wins over an environment hint;
- host/environment/runtime identity when the worktree is remote;
- the selected agent/provider and whether its session is resumable.

The adapter must reject remote use of local cwd aliases. On a remote runtime,
send a server-side path or repo-qualified ID instead.

### Skills and MCP

Muster should expose its skills as the selected agent expects, while treating
Orca's `orca-cli` and optional `orchestration` skills as capabilities rather
than mandatory dependencies. The selected agent may not support `SKILL.md`,
MCP, or the same installation root. Integration setup must probe capabilities
and record the result.

MCP is appropriate for explicit, structured read/status calls when the agent
supports it. It is not a reason to write directly to Orca's internal database.
Muster's own deterministic gate should remain in Muster-owned code and receipt
validation.

### Hooks

Hooks are an optional notification/context bridge, not the primary authority
channel. Provider hooks can report agent status or a transcript path; they may
also be installed/managed by Orca and may differ across local, SSH, WSL, and
remote environments. Muster must identify hook provenance and avoid duplicate
installation. A missing or stale hook should degrade to CLI/filesystem polling,
not block a valid plan.

### Worktree metadata and artifacts

Use a small adapter record, for example:

```json
{
  "orca": {
    "runtime_id": "observed-runtime-id",
    "repo_id": "observed-repo-id",
    "worktree_id": "observed-worktree-id",
    "path": "/absolute/path/on/the/runtime",
    "branch": "feature/example",
    "start_from": "sha-or-ref",
    "host": "local-or-saved-environment",
    "terminal_handle": "observed-handle",
    "pane_key": "observed-pane"
  }
}
```

This is correlation metadata, not a claim that Orca has accepted a Muster
task. Muster receipts additionally need logical task/attempt IDs, plan/manifest
version, changed files, verification commands/results, and review outcome.

### JSON and receipt paths

Parse `--json` as a versioned external response. Store the raw response next to
the adapter event or receipt when it is useful for diagnosis, but redact auth
tokens, pairing codes, prompts, and provider secrets. Keep the authoritative
Muster receipt in the existing Muster receipt location; only publish a bounded
pointer or summary into Orca's comment/artifact/UI surfaces.

## 4. Collision risks and mitigations

| Collision | Failure mode | First mitigation |
|---|---|---|
| Two task graphs | Orca Task status and Muster task status disagree; both advance work | Declare one graph owner per workflow; observe the other read-only. |
| Duplicate dispatch ownership | Both systems launch a worker for one logical item | Require a correlation ID and one dispatch owner; use Orca placement only when explicitly delegated. |
| Mismatched worktree identity | Same branch/name maps to different repo, host, or path | Record concrete Orca IDs/path/base SHA and validate before every mutation. |
| Session restoration | Orca reattaches/hibernates a terminal and invalidates a stale handle | Re-list/reacquire terminal identity after restart, resume, or reconnect. |
| Remote path differences | Local cwd or receipt path is sent to a server where it does not exist | Use server-side selectors and runtime-scoped artifact paths. |
| Direct Orca commit/push | A user ships a diff before Muster's gate/receipt | Mark worktree as Muster-gated and require explicit handoff before ship actions. |
| Provider-specific hooks | Duplicate, stale, or incompatible hooks alter agent behavior | Detect provider and hook provenance; make hooks advisory and idempotent. |
| Shared ignored paths | Workers mutate the same cache, `.env`, or linked dependency tree | Declare shared paths; keep receipts/artifacts in worker-owned paths. |
| Cleanup races | Orca deletes a worktree while Muster is writing a receipt | Require settled status and receipt durability before archive/delete. |
| Hibernation/resume mismatch | A non-resumable agent is killed or resumed as a fresh session | Record resumability; treat a new session as a new attempt unless verified. |
| Remote federation drift | Orca peer identity or relay sequence changes | Use public CLI only; record peer/runtime identity and reject unknown changes. |

## 5. Phased recommendation

### Phase 1 — CLI/worktree coexistence

Implement no Orca plugin or database integration. Add a small Muster adapter
that:

- detects Orca via `orca status --json`;
- resolves and validates the current worktree;
- records repo/worktree/path/branch/base/runtime metadata;
- ~~can update a bounded Orca checkpoint comment~~ — deferred: the shipped
  surface is read-only (see the note under "CLI invocation" above);
- reads terminal status/output only when explicitly requested;
- keeps Muster plans, manifests, receipts, and gates authoritative.

Success criterion: a Muster plan can run inside an Orca terminal or an
Orca-created worktree without duplicate dispatch or incorrect path identity.

### Phase 2 — Read-only status and receipt integration

Add read-only projections:

- show Muster task/attempt/receipt state in an Orca-friendly summary or
  worktree comment;
- expose Orca terminal/worktree state to Muster's status view;
- associate bounded terminal output, diff paths, and receipt paths;
- handle session restore, remote reconnect, and provider hook absence;
- add contract fixtures for local and remote selector differences.

Success criterion: users can understand both states without either system
mutating the other's graph.

### Phase 2.5 — Merge-gate cleanup disposition

Cleanup is part of the existing Muster merge gate, not a second approval flow.
After the gate proves authority, receipt durability, review PASS, explicit ship
handoff, exact Orca identity, clean-tree state, terminal release, and merged
commit ancestry, it composes the cleanup evaluator and returns one bounded
post-merge disposition:

```text
orca worktree rm --worktree <exact-public-selector> --force --json
```

That is the whole disposition: exactly one command. This is **verified against a
live Orca 1.4.177 runtime**, not inferred: creating a throwaway worktree and
running `orca worktree rm --worktree id:<id> --force --json` returned
`{"ok":true,"result":{"removed":true}}` and removed the directory, the git
worktree entry, **and the branch**, with no prompt. The branch is therefore
Orca's to delete and Muster must not follow with its own `git branch -d` — that
second command would run against a branch Orca has already removed and would
fail every time, after the worktree was gone. Gating it behind a separate
approval advertised a protection that never existed. Branch removal is therefore an acknowledged
effect of the disposition, not an opt-in: the evaluator requires explicit
branch-deletion approval before emitting anything, refuses a branch-preservation
request outright rather than silently ignoring it, and still declines to touch a
remote-tracking branch. `--force` is required because the command is executed
non-interactively and deletion otherwise prompts.

The evaluator returns no operations for dirty, active, unmerged, mismatched,
raced, protected, malformed, or uncertain state. Execution remains behind the
public Orca CLI boundary and performs an exact state recheck against the
disposition fingerprint before invoking any command.

The exact worktree selector is `id:<worktree-id>` for every host, with
`path:<absolute-path>` accepted only for a local worktree. Orca's own
`worktree create` help states this contract directly: "Worktree ids are the full
`<repo-id>::<path>` values returned by `orca worktree list --json`." One
canonical identity contract (`src/orca-contract.js`) owns that rule, the
absolute-runtime-path predicate, the branch-ref normalization, and the
shared-path classification vocabulary, so the adapter, the receipt normalizer,
and this evaluator cannot drift into mutually incompatible shapes.

Two properties of real Orca records are load-bearing and were absent from every
hand-written fixture:

- **Branches are fully-qualified refs.** A live record reports
  `refs/heads/main`, not `main`. A protection guard that compares against short
  names fails open on exactly the branches it exists to protect, so every branch
  comparison goes through `shortBranchName` first.
- **The primary checkout is a cleanup target unless explicitly barred.** Orca
  marks it `isMainWorktree`; the evaluator denies `primary-worktree` before any
  other check, independently of the branch.

Success criterion: a passing merge gate produces deterministic cleanup
operations, while every unsafe or incomplete precondition fails closed without
deleting a worktree, branch, receipt, or task graph.

### Phase 3 — Explicit placement handoff

Only after Phase 1/2 contracts stabilize, allow Muster to request Orca worker
placement. Keep Muster as plan/receipt/gate owner and Orca as terminal/worktree/
remote owner. Add immutable task/attempt correlation and a recovery protocol for
partial worker-start effects.

Success criterion: exactly one worker is created per logical attempt, and every
completion is backed by a Muster receipt plus an Orca placement record.

### Phase 4 — Optional Run/Task/Dispatch mapping

Consider mapping Muster entities to Orca Run/Task/Dispatch only after both
schemas and lifecycle contracts are stable. Start with a one-way projection or
an explicit import/export command. Do not make this mapping implicit in the
normal `muster` command path.

Success criterion: mapping preserves ownership, retry identity, dependency
semantics, review-gate authority, remote placement, and recovery behavior.

## 6. Non-goals and open questions

The first proposal does not:

- launch Orca agents or claim live interoperability;
- write Orca's orchestration SQLite database;
- depend on internal runtime RPC or federation wire envelopes;
- replace Muster routing, crews, pipelines, receipts, or review gates;
- assume all Orca-supported agents expose the same skills, MCP, hooks, session
  transcripts, or resume behavior;
- make Orca comments, terminal output, or UI status authoritative receipts.

Before deeper mapping, answer these with executable contract fixtures:

1. Which Orca CLI JSON fields are stable across a stable release and RC?
2. How are worktree identity and paths represented across local, SSH, server,
   VM, WSL, and reconnect states?
3. Can a provider hook report a durable worker identity without exposing
   secrets or relying on a stale terminal handle?
4. Which agent launchers preserve the Muster working directory and context?
5. How should a user-requested Orca commit/push hand off to a pending Muster
   gate, and how is that handoff recorded?

The answers should be added as contracts and tests, not inferred from UI state.
