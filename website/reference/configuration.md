# Configuration

Muster needs no config file. The one optional project file, [`.muster/config`](#project-config-muster-config), holds skill pins. Every tunable is an environment variable, every one has a working default, and every one is read at the point of use — so exporting it in your shell, your `settings.json` `env` block, or a single command invocation all work the same way.

Integer variables are parsed strictly: a non-numeric or out-of-range value falls back to the default rather than failing the run. Boolean-shaped declarations (`MUSTER_ENABLE_APEX`, `MUSTER_AGENT_TEAMS`, `MUSTER_COWORK_NATIVE_PLUGIN`) accept `1`/`true` to enable and `0`/`false` to disable; anything else fails closed to the documented default.

## Variables

| Variable | Default | Semantics | Read by |
| --- | --- | --- | --- |
| `MUSTER_INLINE_SCALE` | `3` | Codex only: border-invitation threshold for the Codex lifecycle hook, the Nth distinct file edited inline with no muster run active warns once per crossing. Never denies. Claude Code has no border invitation. | Codex hook (`codex/hooks/muster-hook.mjs`) |
| `MUSTER_ACTION_GUARD` | `deny` | The action-class fence, active only while a run is live and `.muster/forbidden-actions` lists a class: `deny` blocks a matching send/sign/submit/publish/purchase/delete-remote tool call, `warn` allows it with a reminder, `off` disables the fence. The only hard-deny surface in the stack. | `PreToolUse` hook (`plugin/hooks/pre-tool-use.js`) |
| `MUSTER_MAX_TIER` | _(unset)_ | Caps the conceptual model tier policy (`prime` excludes apex, `core` enables budget mode); unset means no cap. Static agent frontmatter pins are unaffected on direct invocation; in Muster runs the dispatch override honors the cap. | CLI (`src/model.js`) |
| `MUSTER_ENABLE_APEX` | _(unset; off)_ | Enables apex for peak-judgment roles (tournament judge, `architecture-review`, `improve`, `advisor`). Unset degrades apex to prime deterministically. | CLI (`src/model.js`) |
| `MUSTER_ADVISOR_MAX_CONSULTS` | `3` | Maximum advisor consults per run — bounds the cost of workers escalating to the advisor role. `0` disables advisor consults. | CLI (`src/advisor.js`) |
| `MUSTER_FUSE_TOPK` | `3` | Maximum tournament candidates passed to the fusion synthesizer. Minimum `1`. | CLI (`src/fusion.js`) |
| `MUSTER_FUSE_MIN_DISAGREEMENT` | `1` | Minimum disagreement score required to activate fusion synthesis; below it, `muster fuse` falls back to the single best candidate. `0` always fuses when at least two candidates pass. | CLI (`src/fusion.js`) |
| `MUSTER_REVIEW_DIFF_THRESHOLD` | `200` | Changed-line threshold at which the review gate dispatches two reviewers instead of one. A batching lever only — the gate's pass bar and fix-loop cap are unchanged. | CLI (`gate-cadence`, `src/gate-cadence.js`) |
| `MUSTER_AGENT_TEAMS` | _(unset — off)_ | Declares that this session's tool list carries the native `Workflow` fan-out/barrier surface, selecting `mode: "native"` wave dispatch. Nothing declared means the prose wave loop, the floor on every harness. An explicit `--agent-teams`/`--no-agent-teams` flag always wins over the env var. | CLI (`wave-dispatch`, `src/wave-dispatch.js`) |
| `MUSTER_CACHE_DIR` | _(platform cache dir)_ | Where `muster skills search` and `add` cache the ui-skills.com registry (24-hour TTL) and where preflight reads it for offline suggestions. Unset: `$XDG_CACHE_HOME/muster` or `~/.cache/muster` on Linux, `~/Library/Caches/muster` on macOS, `%LOCALAPPDATA%\muster\Cache` on Windows. | CLI (`src/skill-registry.js`) |
| `MUSTER_SPRINT_PARALLEL` | `5` | Max concurrent item builds per wave in a `muster sprint-waves` schedule (the Cowork sprint protocol and the frozen Codex lane). Hard ceiling `10` (higher values clamp; `0` is invalid). Claude Code's `muster:backlog` workflow builds items sequentially and ignores it. | CLI (`sprint-waves`, `src/sprint-waves.js`) |

## Harness-scoped variables

These are read only on the harness they name, and mostly by its host rather than by you.
The Cowork adapter is `cowork/mcp-server.mjs`; the neutral core receives its runtime identity explicitly rather than from a user-set host selector.

| Variable | Default | Semantics | Read by |
| --- | --- | --- | --- |
| `MUSTER_RUNTIME` | _(unset)_ | The neutral MCP core marks nested CLI invocations with the active host (`cowork`, `codex`, or `work`), so capability resolution uses that lane. Set on child CLI spawns by `mcp/server.mjs`. | CLI (`src/capabilities.js`) |
| `MUSTER_COWORK_NATIVE_PLUGIN` | _(unset — detect)_ | Overrides plugin detection for `capabilities --cowork`: `1`/`true` declares muster's plugin loaded, `0`/`false` declares a plugin-less install. Unset reads the Desktop account plugin list, and assumes the plugin route when no list is readable. | CLI (`src/cli.js`, `src/harness.js`, `src/capabilities.js`) |
| `MUSTER_COWORK_CONNECTORS` | _(unset)_ | Comma-separated remote-connector names (e.g. `slack,drive`) to treat as available. Remote connectors live in your cloud account, not on disk, so they cannot be auto-discovered. | CLI (`src/cli.js`) |
| `MUSTER_COWORK_MAX_INFLIGHT` | `4` | Max concurrent MCP tool executions in the Cowork server. Hard ceiling `64`. | `mcp/server.mjs` (via `cowork/mcp-server.mjs` adapter) |
| `MUSTER_COWORK_MAX_QUEUE` | `16` | Max queued MCP tool executions before overload rejection. Hard ceiling `1024`. | `mcp/server.mjs` (via `cowork/mcp-server.mjs` adapter) |

## Where to set them

Every variable is read at the point of use, so all three of these work and none of them need a restart of anything but the process that reads the value:

```sh
# one invocation
MUSTER_MAX_TIER=core npx -y @adnova-group/muster capabilities

# this shell, this session
export MUSTER_ENABLE_APEX=1
```

For the hook-side variables (`MUSTER_INLINE_SCALE`, `MUSTER_ACTION_GUARD`), set them where the harness can see them when it spawns a hook — the `env` block of your Claude Code `settings.json`, or the environment Codex itself was launched from. A variable exported inside a session after the hook has already fired does not retroactively change that firing.

To confirm a value is actually reaching the CLI, read it back off a command that reports it: `muster capabilities` shows the effective per-role model (proving `MUSTER_MAX_TIER` and `MUSTER_ENABLE_APEX`), and `muster gate-cadence <manifest.json> --changed-lines N` shows the resolved `reviewerCount` (proving `MUSTER_REVIEW_DIFF_THRESHOLD`).

Muster's conceptual ladder is `scout`, `core`, `prime`, and `apex`; harness adapters map those tiers to concrete models.

<!-- legacy-tier-compat:start -->
Compatibility only: legacy input aliases `haiku`, `sonnet`, `opus`, and `fable` normalize to `scout`, `core`, `prime`, and `apex`; they are not a second conceptual ladder. `MUSTER_ENABLE_FABLE` remains an alias for `MUSTER_ENABLE_APEX`.
<!-- legacy-tier-compat:end -->

## Project config: `.muster/config`

An optional JSON file at the project root that holds skill pins. `muster skills pin` creates it, and `muster skills unpin` edits it; editing it by hand works too.

```json
{
  "version": 1,
  "skills": {
    "pins": [
      { "id": "sp-tdd" },
      { "id": "impeccable-core", "role": "frontend" }
    ]
  }
}
```

- `id` is a builtin id (see the [Skill library](./skills)), or a skill that `muster skills add` installed in `.claude/skills/`.
- `role` is optional, and must be a catalog role such as `frontend` or `test-author`. A pin without a role applies to every task. A pin with a role applies to the tasks whose `agent_hint` or bound skills carry that role.
- `preflight` lists pinned builtins first among its skill candidates, and the planner brief names every pin. `build-args` then appends each pinned skill to every matching task in `build-args.json`, even if the plan left it out, and reports those tasks as `pinned`. A pin that no longer resolves becomes a `build-args` warning, not a failure.
- A file that is not a JSON object is an error, because silently ignoring it would drop your pins.

## Not user knobs

Two more `MUSTER_*` names appear in the tree and are deliberately absent from the tables above:

- `MUSTER_CLI` is a **run-local shell variable**, not a setting. Each mode resolves the cheapest way to invoke the CLI once per run (a vendored plugin runtime, a local checkout, a `muster` bin, or an `npx` fallback) and reuses the answer, so a run never pays a cold `npx -y` start per call. Use `muster resolve-cli` to see what it would resolve to.
- `MUSTER_COWORK_TEST_CLI` is a **test-only injection point** (a CLI path override honored only under `NODE_ENV=test`). It never affects a real run.

Next: [Troubleshooting](/guides/troubleshooting) for what to do when a setting is not taking effect.

Harness setup and support boundaries are documented in [Harness support](/guides/harnesses), [Codex](/guides/codex) and [Cowork](/guides/cowork). Security-sensitive diagnostics and reporting use [Security and reporting](/guides/security).
