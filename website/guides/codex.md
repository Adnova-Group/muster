# Codex

Muster runs on Codex CLI and Codex Desktop as a first-class runtime. The same deterministic CLI does the routing math. The Codex plugin carries the model-facing layer, and the npm installer writes the profiles and lifecycle hooks that Codex itself cannot install.

## Requirements

- [Codex CLI or Codex Desktop](https://developers.openai.com/codex)
- Node.js 20 or newer (`node --version`)

Model work uses the account or subscription of the active Codex session. Muster's CLI makes no model calls and needs no separate model API key.

## Install

```sh
npx -y @adnova-group/muster@0.6.0 install codex --scope project
```

`--scope project` writes:

- Muster-owned agent profiles under `.codex/agents/`
- the hook runtime under `.codex/muster/`
- Muster-owned hook groups merged into `.codex/hooks.json`
- a managed agent-declaration region in `.codex/config.toml`
- the canonical shared `[agents]` key `max_concurrent_threads_per_session`

`--scope user` writes the same owned material under `$CODEX_HOME` (or `~/.codex` when that is unset). The canonical ceiling is shared in the Codex home config. Muster defaults it to `12` only when no canonical or legacy user ceiling exists, and it never raises or lowers a positive user value. The last managed-scope uninstall restores only receipt-proven Muster changes; legacy `max_threads`/`max_depth` values are cleaned only when an older valid Muster receipt proves ownership.

### Native Windows and WSL are separate installs

Run the installer in the same host that launches Codex. Native Windows normally uses `%USERPROFILE%\.codex`; WSL normally uses its Linux `~/.codex`. They also have separate Node installations, executable search paths, and plugin caches. Installing Muster in WSL therefore does not configure native Codex Desktop, even when the repository itself is reachable through `/mnt/c/...`.

If you move from WSL Codex to native Windows Codex, rerun the desired project/user installs from PowerShell, review the native definitions with `/hooks`, and run `muster doctor --codex` there. Treat the old WSL scope as a separate installation and uninstall it from WSL if it is no longer used. `commandWindows` path mapping lets a hook definition represent a Windows path; it does not merge the two user homes or make a Linux-only Node executable callable by native Desktop.

With Codex on `PATH`, the installer also registers the `Adnova-Group/muster` marketplace and adds `muster@muster`, idempotently. Without Codex on `PATH` it still installs the profiles and hooks, then prints the exact registration follow-up for you to run.

```sh
npx -y @adnova-group/muster@0.6.0 install codex --scope user
```

## The canonical-scope hook collapse

The **user scope is canonical for hooks.** If the user scope already carries a healthy Muster hook install, a project-scope install **skips its own hook merge entirely**. Profiles still install as normal. Rerunning `--scope project` on a machine that has both scopes therefore converges on **one firing scope** instead of double-firing every lifecycle event.

Existing unrelated profiles and hook groups are preserved in both scopes. Muster only owns what it wrote; the merge is additive against your own entries.

::: tip Both scopes is the normal state
You do not have to choose. Install the user scope once for hooks that follow you across repos, then install the project scope in each repo for its profiles. The collapse rule keeps the event stream single-fired.
:::

## Why the Codex plugin is hooks-free

Codex executes plugin-bundled hooks by default. If Muster's Codex plugin bundled its hooks, every event would fire twice: once from the plugin and once from the `hooks.json` layer.

So the Codex plugin is **deliberately hooks-free.** Hooks come from the npm installer through the supported project or user `hooks.json` layer instead, which is also the layer you can inspect and revoke. The two paths never overlap.

## Trust review

Codex stores trust per hook definition, keyed by the hooks file, event, group, hook index, and current content hash. A fresh definition or changed command needs review before it fires. An unchanged reinstall keeps the matching trust entry. Removing or collapsing a Muster scope prunes only the exact trust keys owned by that departing definition; another definition at the same path and Codex project-trust records remain.

Inspect current definitions at any time:

```
/hooks
```

The hooks inject orchestration context and surface supported diagnostics and policy warnings. They do not rewrite your files.

## Invoking Muster on Codex

Codex has no slash-command namespace, so the modes are skills:

```
$muster Add rate limiting to the public API with tests
```

| Skill | Equivalent |
| --- | --- |
| `$muster` | The entry point; routes to the right mode for the outcome. |
| `$muster-plan` | Approve-first: assemble the crew, show the manifest, stop. |
| `$muster-go` | Hands-off full lifecycle: branch, route, waves, gates, disposition. |
| `$muster-audit` | Breadth-first whole-codebase review and fix. |
| `$muster-capture` | Mine the conversation into approval-gated backlog items. |
| `$muster-init` | Prepare repository state and coordinate Codex native Init evidence. |
| `$muster-design` | Run context-gated Muster Design workflows with explicit `DESIGN.md` provenance. |

All ten modes have a skill: the six above plus `$muster-plan-backlog`, `$muster-go-backlog`, `$muster-diagnose`, and `$muster-runner`. The three legacy aliases remain skills too: `run` maps to `plan`, `autopilot` maps to `go`, and `sprint` maps to `go-backlog`. They are deprecated as of 2026-07-17 and retire in Muster 0.7.0.

Codex native Init uses the canonical instruction pair: `AGENTS.md` is authoritative, and `CLAUDE.md` contains exactly:

```md
# Claude Code

@AGENTS.md
```

If conflicting instruction files existed at the preparation baseline, Init leaves a HUMAN-HOLD instead of overwriting or merging them. A request to run Init, an existing file, or a refusal to overwrite does not prove completion. Muster finalizes only from an artifact delta, an explicit pre-existing confirmation, or an attempt-bound call-result receipt.

For annotated go-backlog files, Codex dispatches every ready implementation/review leg in the dependency wave up to the emitted concurrency bound. Completion notifications are not a reason to wait for a user turn: after each wake, the orchestrator drains all available receipts, runs `sprint-reconcile`, dispatches every returned action, and reconciles again before waiting. Integration remains backlog-ordered after the full wave build/review barrier. There is no special three-runner ceiling; the current backlog control defaults to 5 and clamps at 10, while the shared Codex thread floor remains 12.

## What the Codex plugin bundles

| Component | Count |
| --- | --- |
| Deterministic CLI | the full `muster` verb surface |
| Pipelines | all of them |
| MCP tools | 31 tools: 30 CLI-wrapper tools plus `muster_sprint_protocol` |
| Custom-agent profiles | 27 |
| Skills | 77 total: 14 public + 63 internal |
| Internal skill breakdown | 12 native orchestration + 51 capability |

## Inspecting a Codex install

```sh
muster capabilities --codex
muster doctor --codex
```

`capabilities --codex` reports the live Codex plugin, MCP, skills, and agents inventory, and walks the same resolution ladder as the Claude Code lane. On this lane only, every **agent-backed** role additionally carries `codexModel: {model, effort}`, the exact model and reasoning effort the role's chosen profile resolves to. A driver can see the dispatch policy before dispatch instead of auditing it after the run.

`doctor --codex` is read-only and names the failing scope and cause for generation/version mismatches between installed scopes, hook coherence failures, and stale hook trust entries. See [Troubleshooting](/guides/troubleshooting) for how to read the output.

## Codex audit shape

The Codex audit covers the same six core dimensions as other runtimes, but it uses three read-only briefs to stay within the Codex thread budget:

1. **System quality:** architecture, tech debt, simplification, and readability
2. **Coverage:** test gaps and untested failure paths
3. **Security:** injection, secrets, unsafe IO, trust boundaries, installers, and lifecycle hooks

A prompting project adds prompt-quality coverage to the relevant scan. Each required dimension must return a receipt before consolidation. The three-brief shape is a quota adaptation, not a smaller audit inventory.

## Preview, provenance, and conflicts

```sh
muster install codex --scope project --dry-run
muster uninstall codex --scope project --dry-run
```

Dry-run reports the planned files, merges, hook-collapse decision, and plugin actions without writing, locking, registering, or removing anything. The plan is a preview, not proof that a later real install will see the same filesystem.

Muster refuses to overwrite unrelated profiles or mutate a managed declaration region whose provenance receipt no longer matches. Treat that refusal as an ownership warning. Inspect the named file instead of deleting the manifest to force an install.

## Uninstall

```sh
muster uninstall codex --scope project
muster uninstall codex --scope user
```

Each command removes only material owned in the scope you name: receipted profiles, the managed declaration region, hook runtime, hook groups, and exact hook-trust keys. Unrelated entries remain. The Codex plugin stays registered while another managed scope is live and is removed only after the last registered scope leaves with certain ownership. Shared thread limits restore only at that last-scope point.

## Policy limits on Codex

Some controls are weaker on Codex:

- **Todo and spawn enforcement remain advisory.** Codex's hook layer surfaces the warning; it does not hard-block the call. The review gate, not the hook, is Muster's actual quality enforcement on this harness.
- **The action fence is not a Codex sandbox.** Codex does not register a blocking hook event for Muster. Forbidden action classes still travel in run state and worker briefs, but that is instruction-level policy on this runtime. Keep Codex permissions and human approval in place for external effects.
- **Write-capable waves need isolated Git worktrees.** `spawn_agent` has no cwd field. Muster creates worktrees before dispatch, names the absolute worktree in every brief, and requires a base-SHA receipt.
- **Receipt verification proves one narrow fact.** Format validation alone is insufficient. `muster receipt-verify <sha> --cwd <repo>` confirms that the SHA resolves to a real commit object in the explicit repository. It does not prove that a worker used the assigned worktree, stayed on a branch, forked from that commit, respected ownership, or produced a clean diff. Those checks remain separate dispatch and review duties.

Next: [Troubleshooting](/guides/troubleshooting) and the [CLI commands](/reference/commands) reference.
