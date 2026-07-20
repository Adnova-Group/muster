# Codex

Muster runs on Codex CLI and Codex Desktop as a first-class harness, not a port. The same deterministic CLI does the routing math; the Codex plugin carries the model-facing layer, and the npm installer writes the Codex-native profiles and lifecycle hooks that Codex itself cannot install for you.

## Requirements

- [Codex CLI or Codex Desktop](https://developers.openai.com/codex)
- Node.js 20 or newer (`node --version`)

Muster draws your interactive Codex subscription. There is no separate model API and no key to manage.

## Install

```sh
npx -y @adnova-group/muster install codex --scope project
```

`--scope project` writes:

- Muster-owned agent profiles under `.codex/agents/`
- the hook runtime under `.codex/muster/`
- Muster-owned hook groups merged into `.codex/hooks.json`

`--scope user` writes the same three things under `$CODEX_HOME` (or `~/.codex` when that is unset).

With Codex on `PATH`, the installer also registers the `Adnova-Group/muster` marketplace and adds `muster@muster`, idempotently. Without Codex on `PATH` it still installs the profiles and hooks, then prints the exact registration follow-up for you to run.

```sh
npx -y @adnova-group/muster install codex --scope user
```

## The canonical-scope hook collapse

The **user scope is canonical for hooks.** If the user scope already carries a healthy Muster hook install, a project-scope install **skips its own hook merge entirely** — profiles still install as normal. Rerunning `--scope project` on a machine that has both scopes therefore converges on **one firing scope** instead of double-firing every lifecycle event.

Existing unrelated profiles and hook groups are preserved in both scopes. Muster only owns what it wrote; the merge is additive against your own entries.

::: tip Both scopes is the normal state
You do not have to choose. Install the user scope once for hooks that follow you across repos, then install the project scope in each repo for its profiles. The collapse rule keeps the event stream single-fired.
:::

## Why the Codex plugin is hooks-free

Codex executes plugin-bundled hooks by default. If Muster's Codex plugin bundled its hooks, every event would fire twice — once from the plugin and once from the `hooks.json` layer.

So the Codex plugin is **deliberately hooks-free.** Hooks come from the npm installer through the supported project or user `hooks.json` layer instead, which is also the layer you can inspect and revoke. The two paths never overlap.

## Trust review

These hooks are non-managed, so Codex asks for a **one-time trust review** the first time they would fire. Approve them once and Codex remembers the decision. Inspect what is registered at any time:

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

All eight modes have a skill: the four above plus `$muster-plan-backlog`, `$muster-go-backlog`, `$muster-diagnose`, and `$muster-runner`. The three legacy aliases remain skills too — `run` (→ `plan`), `autopilot` (→ `go`), and `sprint` (→ `go-backlog`). They are deprecated as of 2026-07-17 and retire in muster 0.7.0.

## What the Codex plugin bundles

| Component | Count |
| --- | --- |
| Deterministic CLI | the full `muster` verb surface |
| Pipelines | all of them |
| MCP tools | 28 |
| Custom-agent profiles | 27 |
| Native skills | 11 |
| Capability skills | 51 |

## Inspecting a Codex install

```sh
muster capabilities --codex
muster doctor --codex
```

`capabilities --codex` reports the live Codex plugin, MCP, skills, and agents inventory, and walks the same resolution ladder as the Claude Code lane. On this lane only, every **agent-backed** role additionally carries `codexModel: {model, effort}` — the exact model and reasoning effort the role's chosen profile resolves to, so a driver can see the dispatch policy before it dispatches rather than auditing it after the run.

`doctor --codex` is read-only and names the failing scope and cause for generation/version mismatches between installed scopes, hook coherence failures, and stale hook trust entries. See [Troubleshooting](/guides/troubleshooting) for how to read the output.

## Uninstall

```sh
muster uninstall codex --scope project
muster uninstall codex --scope user
```

Each removes only the Muster-owned profiles, hook runtime, and hook groups from that scope. Unrelated entries in `.codex/hooks.json` (or the `$CODEX_HOME` equivalent) stay where they are.

## Policy limits on Codex

Two of Muster's enforcement surfaces behave differently here, and both are deliberate:

- **Todo and spawn enforcement remain advisory.** Codex's hook layer surfaces the warning; it does not hard-block the call. The review gate, not the hook, is Muster's actual quality enforcement on this harness.
- **Write-capable waves must use isolated Git worktrees.** Codex's `spawn_agent` has no cwd field, so there is no native per-subagent isolation to ride. Muster shells out `git worktree add` before dispatch and verifies each runner's branch and base from its own base-SHA receipt (`muster receipt-verify <sha> --cwd <repo>`).

Next: [Troubleshooting](/guides/troubleshooting) and the [CLI commands](/reference/commands) reference.
