# Configuration

Muster needs no config file. Every tunable is an environment variable, every one has a working default, and every one is read at the point of use — so exporting it in your shell, your `settings.json` `env` block, or a single command invocation all work the same way.

Integer variables are parsed strictly: a non-numeric or out-of-range value falls back to the default rather than failing the run. Boolean-shaped declarations (`MUSTER_ENABLE_FABLE`, `MUSTER_AGENT_TEAMS`, `MUSTER_CODEX_MULTI_AGENT`, `MUSTER_COWORK_NATIVE_PLUGIN`) accept `1`/`true` to enable and `0`/`false` to disable; anything else fails closed to the documented default.

## Variables

| Variable | Default | Semantics | Read by |
| --- | --- | --- | --- |
| `MUSTER_INLINE_SCALE` | `3` | Border-invitation threshold: the Nth distinct file edited inline across turns, with no muster run active, warns once per crossing. Never denies. Minimum `2`. | `PreToolUse` hook (`plugin/hooks/inline-budget.js`) |
| `MUSTER_INVITE_COOLDOWN_MS` | `900000` (15 min) | Suppresses a repeat border invitation for this long after the last one actually fired, so a session is never nagged twice in quick succession. | `UserPromptSubmit` + `PreToolUse` hooks |
| `MUSTER_ACTION_GUARD` | `deny` | The action-class fence, active only while a run is live and `.muster/forbidden-actions` lists a class: `deny` blocks a matching send/sign/submit/publish/purchase/delete-remote tool call, `warn` allows it with a reminder, `off` disables the fence. The only hard-deny surface in the stack. | `PreToolUse` hook (`plugin/hooks/pre-tool-use.js`) |
| `MUSTER_TASK_GATE` | _(unset — gate on)_ | Ties a native task board "completed" tick to a recorded review-gate PASS for muster-tracked tasks; a `pending` or `escalated` entry is denied. `off` allows unconditionally. Fail-open for any task muster did not create. | `TaskCompleted` hook (`plugin/hooks/task-completed-gate.js`) |
| `MUSTER_MAX_TIER` | _(unset)_ | Caps the model tier policy (`opus` disables Fable, `sonnet` for budget mode); unset means no cap. Static agent frontmatter pins are unaffected on direct invocation; in muster runs the dispatch override honors the cap. | CLI (`src/model.js`) |
| `MUSTER_ENABLE_FABLE` | _(unset — off)_ | Opts back into the Fable tier for peak-judgment roles (tournament judge, `architecture-review`, `improve`, `advisor`). Unset degrades Fable to Opus deterministically, since the tier can be disabled platform-wide. | CLI (`src/model.js`) |
| `MUSTER_ADVISOR_MAX_CONSULTS` | `3` | Maximum advisor consults per run — bounds the cost of workers escalating to the advisor role. `0` disables advisor consults. | CLI (`src/advisor.js`) |
| `MUSTER_FUSE_TOPK` | `3` | Maximum tournament candidates passed to the fusion synthesizer. Minimum `1`. | CLI (`src/fusion.js`) |
| `MUSTER_FUSE_MIN_DISAGREEMENT` | `1` | Minimum disagreement score required to activate fusion synthesis; below it, `muster fuse` falls back to the single best candidate. `0` always fuses when at least two candidates pass. | CLI (`src/fusion.js`) |
| `MUSTER_REVIEW_DIFF_THRESHOLD` | `200` | Changed-line threshold at which the review gate dispatches two reviewers instead of one. A batching lever only — the gate's pass bar and fix-loop cap are unchanged. | CLI (`gate-cadence`, `src/gate-cadence.js`) |
| `MUSTER_AGENT_TEAMS` | _(unset — off)_ | Declares that this session's tool list carries the native `Workflow` fan-out/barrier surface, selecting `mode: "native"` wave dispatch. Nothing declared means the prose wave loop, the floor on every harness. An explicit `--agent-teams`/`--no-agent-teams` flag always wins over the env var. | CLI (`wave-dispatch`, `src/wave-dispatch.js`) |
| `MUSTER_SPRINT_PARALLEL` | `3` | Max concurrent item-runner subagents per wave in `/muster:go-backlog` wave mode. Hard ceiling `8` (higher values clamp; `0` is invalid). Read by go-backlog's orchestration protocol, not by library code. | `plugin/commands/go-backlog.md` |

## Harness-scoped variables

These are read only on the harness they name, and mostly by its host rather than by you.

| Variable | Default | Semantics | Read by |
| --- | --- | --- | --- |
| `MUSTER_CODEX_MULTI_AGENT` | _(unset — on)_ | Declares whether Codex's `features.multi_agent` is enabled this session. Codex ships it on, so the default is on; only an explicit off drops wave dispatch to the `sequential-inline` floor. | CLI (`src/wave-dispatch.js`) |
| `MUSTER_RUNTIME` | _(unset)_ | `cowork` marks a nested CLI invocation as running under Cowork, so capability resolution uses the Cowork lane. Set by the Cowork MCP server on the CLI spawns it makes. | CLI (`src/capabilities.js`) |
| `MUSTER_COWORK_NATIVE_PLUGIN` | _(unset — off)_ | Declares that Cowork's own plugin loader accepted muster's `plugin/` tree. A declared capability check, never a probe: unset keeps resolution MCP-only. | CLI (`src/cli.js`, `src/capabilities.js`) |
| `MUSTER_COWORK_CONNECTORS` | _(unset)_ | Comma-separated remote-connector names (e.g. `slack,drive`) to treat as available. Remote connectors live in your cloud account, not on disk, so they cannot be auto-discovered. | CLI (`src/cli.js`) |
| `MUSTER_COWORK_MAX_INFLIGHT` | `4` | Max concurrent MCP tool executions in the Cowork server. Hard ceiling `64`. | `cowork/mcp-server.mjs` |
| `MUSTER_COWORK_MAX_QUEUE` | `16` | Max queued MCP tool executions before overload rejection. Hard ceiling `1024`. | `cowork/mcp-server.mjs` |

## Where to set them

Every variable is read at the point of use, so all three of these work and none of them need a restart of anything but the process that reads the value:

```sh
# one invocation
MUSTER_MAX_TIER=sonnet npx -y @adnova-group/muster capabilities

# this shell, this session
export MUSTER_ENABLE_FABLE=1
```

For the hook-side variables (`MUSTER_INLINE_SCALE`, `MUSTER_INVITE_COOLDOWN_MS`, `MUSTER_ACTION_GUARD`, `MUSTER_TASK_GATE`), set them where the harness can see them when it spawns a hook — the `env` block of your Claude Code `settings.json`, or the environment Codex itself was launched from. A variable exported inside a session after the hook has already fired does not retroactively change that firing.

To confirm a value is actually reaching the CLI, read it back off a command that reports it: `muster capabilities` shows the effective per-role model (proving `MUSTER_MAX_TIER` and `MUSTER_ENABLE_FABLE`), and `muster gate-cadence <manifest.json> --changed-lines N` shows the resolved `reviewerCount` (proving `MUSTER_REVIEW_DIFF_THRESHOLD`).

## Not user knobs

Three more `MUSTER_*` names appear in the tree and are deliberately absent from the tables above:

- `MUSTER_CLI` is a **run-local shell variable**, not a setting. Each mode resolves the cheapest way to invoke the CLI once per run (a vendored plugin runtime, a local checkout, a `muster` bin, or an `npx` fallback) and reuses the answer, so a run never pays a cold `npx -y` start per call. Use `muster resolve-cli` to see what it would resolve to.
- `MUSTER_TEST_NOW_MS` and `MUSTER_COWORK_TEST_CLI` are **test-only injection points** (a frozen clock for the hook cooldown tests; a CLI path override honored only under `NODE_ENV=test`). Neither affects a real run.

Next: [Troubleshooting](/guides/troubleshooting) for what to do when a setting is not taking effect.
