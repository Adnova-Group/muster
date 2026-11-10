# Plugin eval suite

`npm run eval:plugin` runs these cases through `claude plugin eval` (Claude Code 2.1.269+).
Each case loads `plugin/` the way Claude Code loads it, in a fresh, isolated `claude -p`
session, sends one prompt, and grades the transcript. `eval/modes/` grades prompts offline;
this suite catches regressions that only show up in the real harness, such as a Claude Code or
model update that changes how a command, skill, workflow or hook is resolved.

It is a **manual gate**: run it before a release and after every Claude Code update
(`docs/ship-checklist.md`). CI does not run it, because every case is a real model call on a
credential. `test/plugin-eval-suite.test.js` (part of `npm test`) checks that the suite loads.

## Cases

| Case | Pins | Graders |
| --- | --- | --- |
| `plan-runs-command` | `/muster:plan` on a JS repo runs the command, not a same-named workflow (the stage-3 collision); the orchestrator skill is invoked before preflight; the absolute CLI prefix reaches `muster:make-plan`; nothing calls a bare `muster`; no Python-only skill is offered | `orchestrator-invoked`, `preflight-ran`, `orchestrator-before-preflight`, `plan-workflow-not-launched`, `plan-skill-not-called`, `cli-prefix-handed-to-agents`, `no-bare-muster`, `no-python-skill` |
| `skills-list-compact` | `/muster:skills list` makes one CLI call and relays the role summary (at most 40 lines and 6,000 chars, no per-id dump) | `one-cli-call`, `role-summary-shown`, `at-most-40-lines`, `at-most-6000-chars`, `no-id-dump` |
| `pm-check-spec` | `/muster:pm check` on a fixture spec quotes spec-lint's verdict (ISSUES, EXP-01.2 defined twice) and changes nothing | `spec-lint-ran`, `verdict-quoted`, `blocker-quoted`, `no-pass-claim`, `spec-unchanged` |
| `content-routes-pipeline` | a blog-post outcome at `/muster:plan` routes to the `blog-post` pipeline: `pipeline-args`, no `muster:make-plan`, and the pipeline does not run before approval | `preflight-ran`, `routed-to-pipeline`, `pipeline-args-ran`, `no-code-planning`, `pipeline-not-run`, `names-the-pipeline` |
| `fence-denies-in-run` | with `.muster/run-active` and `forbidden-actions` present, the PreToolUse hook denies `git push` ("publish") before it runs | `push-attempted`, `hook-denied`, `git-never-ran` |
| `fence-allows-outside-run` | without the markers, the same command reaches git | `push-attempted`, `hook-did-not-deny`, `git-ran` |
| `idle-no-hook-output` | a session that never invokes muster gets no session hook output and no skill call | `bash-ran`, `no-session-hook-output`, `no-muster-skill`, `plain-answer` |

Every case runs once on haiku, with free graders only (regex and tool checks, no judge model),
and `--ablation none`: the cases check muster's own behavior, so a no-plugin baseline arm would
only add cost. Use `--runs 3` to check a case for flakiness.

Limit: the eval trace records SessionStart hook output (a `hook_response` event), but not the
`additionalContext` that a PreToolUse or UserPromptSubmit hook returns (probed on 2.1.319 with
a throwaway plugin). `idle-no-hook-output` therefore covers the session hooks and skill calls,
and the hook's silent allow outside a run stays covered by the hook unit tests.

## Running

```bash
npm run eval:plugin                       # the whole suite, about $0.15 and 11 minutes with -j 4
npm run eval:plugin -- --tag fence        # arguments after -- go to `claude plugin eval`
npm run eval:plugin -- --case pm-check-spec --keep-temp
npm run eval:plugin -- --check            # check the environment and print the command only
```

`scripts/plugin-eval.mjs` sets the defaults: `--eval-dir eval/plugin`, `--trust-plugin` and
`--scaffold` (our own suite, and the scaffolds only write fixture files), `--ablation none`,
`--judge-model haiku`, `--max-cost-usd 3`, `--no-publish`, and
`--allow-tools Bash Write Edit Workflow`. Results go to `eval/plugin/results/<timestamp>/`
(`aggregate-result.json`, `report.html`), which git ignores. The exit code is
`claude plugin eval`'s: 0 means every case scored 1.0.

Environment the wrapper handles, all found on Linux/WSL with 2.1.319:

- Granting Bash runs it under Claude Code's OS sandbox. On Linux that needs `bubblewrap` and
  `socat` on PATH ("sandbox required but unavailable: ... socat not installed"). Native Windows
  has no sandbox backend, so use WSL2.
- The sandbox refuses to start when a PATH entry cannot be examined ("a PATH directory could not
  be examined for keychain credential helpers (EACCES)"). WSL's `/mnt/c/...` entries do this, so
  the wrapper drops unreadable PATH entries.
- The sandbox hides `/home` and `/tmp` except the plugin and the PATH directories, so a node under
  `/home` that links libraries outside its bin directory cannot start, which makes
  `runtime/muster.sh` fail. Homebrew's node is one. The wrapper puts the running node's real bin
  directory, plus the Homebrew prefix, first on PATH.
- The sandbox denies writes to all of `/tmp`, which also makes a run workspace under `/tmp`
  read-only to Bash (preflight fails with `EROFS`). The wrapper sets `TMPDIR` to
  `~/.cache/muster-plugin-eval`; `MUSTER_PLUGIN_EVAL_TMPDIR` overrides it.
- The sandbox masks dotfiles in the workspace (`.bashrc`, `.mcp.json`, `.vscode`, ...) with
  device nodes. The git scaffolds ignore them so preflight sees a clean tree.

## Adding a case

Add `cases/<name>/case.yaml` (the whole case in one file: `execution.prompt` and `graders:`),
plus a `set -euo pipefail` bash scaffold beside it if the workspace needs files. Keep it to one
run on haiku with free graders. A `tool_used` grader's `input_match` and a `trace` regex see
JSON-encoded text, so a quote inside a command or tool result is `\"`. Run the case alone with
`--keep-temp` and read `out/trace.jsonl` in the kept directory before trusting a grader. Then
`npm test` checks the format.

A failing `plan-runs-command` can cost much more than a passing one. In the negative control
below, the workflow ran on its default seats (opus planner and checker) and cost $1.65.
`--max-cost-usd` is checked only before each run starts, so it does not stop a run that is
already going.

## Last recorded run

2026-11-10, Claude Code 2.1.319, haiku, `npm run eval:plugin -- -j 4`, WSL2 (Ubuntu) with
socat taken from the distro package:

```text
CASE                      SCORE PASS% RUNS COST
content-routes-pipeline   1.00  100%  1    $0.01
fence-allows-outside-run  1.00  100%  1    $0.00
fence-denies-in-run       1.00  100%  1    $0.00
idle-no-hook-output       1.00  100%  1    $0.00
plan-runs-command         1.00  100%  1    $0.11
pm-check-spec             1.00  100%  1    $0.01
skills-list-compact       1.00  100%  1    $0.01
7 case(s) · 632s · $0.15
```

`plan-runs-command` takes most of the time (627 s), because it runs the real `muster:make-plan`
workflow (planner and checker, both pinned to haiku) in the background. The other six cases
finish in 5-33 s each.

Negative control: the stage-3 bug was restored temporarily (a copy of `make-plan.js` named
`plan`). The model then called `Workflow({name:"muster:plan", args:"<raw outcome>"})` as its
only tool, with no orchestrator and no preflight. `plan-runs-command` scored 0.43, below the 1.0
threshold. That run also showed that the first version of `plan-workflow-not-launched`,
which checked only the Skill tool, passed without testing anything. It now checks the Workflow
tool too.
