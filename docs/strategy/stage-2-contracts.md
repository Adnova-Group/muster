# Stage 2 interface contracts

The interfaces shared by the parallel stage-2 tracks. Workflows, agents, CLI steps and commands
must agree on these names and shapes. Grounding:
- `docs/strategy/2026-11-gsd-gap-analysis.md` (the target architecture);
- `docs/research/claude-code-live-probes-2026-11.md` (what Workflow and hooks actually do).

## Agents (plugin/agents/)

| Agent file | Role | Source | Replaces |
|---|---|---|---|
| `muster-planner.md` | Writes PLAN.md for a run | gsd `agents/gsd-planner.md` (heavy adaptation) | router skill + crew manifest |
| `muster-plan-checker.md` | Checks PLAN.md against binding dimensions | gsd `agents/gsd-plan-checker.md` (heavy) | plan-checklist rendering, spec gate |
| `muster-executor.md` | Implements one task in its worktree, commits atomically, self-checks | gsd `agents/gsd-executor.md` + `muster-builder.md` | `muster-builder.md` (deleted) |
| `muster-verifier.md` | Goal-backward verification with honest abstain | gsd `agents/gsd-verifier.md` (heavy) | — (new seat) |
| `muster-reviewer.md` | Code review of one task's commit range | gsd `agents/gsd-code-reviewer.md` (medium) | current muster-reviewer body |

`muster-strategist`, `muster-investigator`, `muster-surgeon` and `muster-improver` stay. What
happens to `muster-runner` is decided in the command rewrite (go-backlog folds into go). The
`wsh-*` specialists stay; the planner names them per task via `agentHint`.

Every adapted agent:
- has no gsd-tools / gsd_run calls;
- has no `.planning/` paths, using `.muster/runs/<id>/` instead;
- has no `@~/.claude/gsd-core/...` includes;
- keeps gsd's protocol text verbatim wherever it produces measured behavior (honest abstain, revision loop, failing-direction);
- has a one-line `description`, an `effort:` field, and `upstream:` provenance.

## Run directory (committed on the work branch)

```
.muster/runs/<runId>/
  CONTEXT.md          # interview decisions, gray areas resolved
  PLAN.md             # planner output (tasks, deps, waves, agentHint, verify commands)
  SUMMARY-<taskId>.md # executor self-check summary per task
  VERIFICATION.md     # verifier output
  STATE.md            # derived by `muster next --run <id>`, never hand-narrated
  continue-here.md    # pause/handoff note
```

These stay gitignored, local only: `.muster/run-active` and `.muster/forbidden-actions`, which the
action fence reads, and `.claude/worktrees/`.

## Workflow scripts (plugin/workflows/)

- `plan.js`: args `{runId, outcome, contextPath, candidates}`. Runs planner → plan-checker, looping
  at most 3 revisions and escalating when the issue count stops falling. Returns
  `{runId, planPath, verdict, revisions, issues[]}`.
- `build.js`: args `{runId, waves:[[{taskId, title, agentHint, files, verify}]], base}`. Runs each
  wave as `parallel()` executors with `isolation:"worktree"`, then reviewer and fixer, looping at
  most 2 times, then the verifier once per run. Returns `{runId, tasks:[ExecResult & {review}],
  verification}`.
- `backlog.js`: args `{items:[{itemId, runId, waves}]}`. Runs items sequentially through the same
  stages, inlined, because Workflow nesting is one level only.

Every `agent()` call:
- is wrapped so that one schema failure records `{status:"error"}` rather than killing the run;
- sets `model` / `effort` from args (the tier map is computed by the CLI);
- has an idempotent builder brief: check git state before acting.

The main thread calls the workflows as `Workflow({name:"muster:plan"|"muster:build"|"muster:backlog", args:{…}})`. It resumes with `{name, resumeFromRunId}`, never with `scriptPath`.

## Result schemas (JSON Schema, in plugin/workflows/schemas.js)

- **ExecResult:** `{taskId, status: "done"|"blocked"|"error", branch, commit, worktree,
  filesChanged:[string], testsRun:[string], testsPassed:boolean, selfCheck:"PASSED"|"FAILED",
  deviations:[string]}`
- **ReviewResult:** `{taskId, verdict: "PASS"|"FAIL"|"ABSTAIN", commitReviewed, findings:[{severity,
  file, line, summary}], testsRun:[string], testsPassed:boolean}`
- **VerifyResult:** `{verdict: "PASS"|"GAPS"|"ABSTAIN", truths:[{claim, status, evidence}],
  gaps:[string]}`
- **CheckResult:** `{verdict: "PASS"|"ISSUES", issues:[{dimension, severity, required_property,
  summary}]}`

Verdicts are evidence, not truth. The main thread re-checks `commit` / `commitReviewed` exist and
re-runs `testsRun` before merging, through `muster merge-wave`.

## CLI steps (src/cli.js)

- `muster preflight <outcome> [--json]`: one call replacing scope, assess, fast-path, detect,
  capabilities, memory and validate. Prints a small JSON summary: scope, fast-path eligibility, tier
  map, top candidate agents, gsd/plugin detections. Full detail goes to a file.
- `muster merge-wave <runId> --result <build-result.json>`:
  1. verify every claimed commit exists on its branch;
  2. merge the branches in manifest order (`--no-ff`);
  3. re-run each task's `verify` / `testsRun`;
  4. remove the worktrees and branches;
  5. append to `.muster/runs/<id>/STATE.md`.

  Exits non-zero on any mismatch.
- `muster next --run <id>`: derives position from files on disk (which of CONTEXT, PLAN, SUMMARY-*,
  VERIFICATION exist) and prints the next action.
- `muster plan-lint <PLAN.md>`: deterministic gates ported from gsd (failing-direction, verify
  commands present, deps acyclic, files declared). Exit 1 with issues in the CheckResult shape.

## Amendments from the workflows track (live smoke, 2026-11-09)

1. **Trusted plan args.** The main thread writes the exact `muster:build` args to
   `.muster/runs/<id>/build-args.json` and **commits it before building**. `merge-wave` reads verify
   commands, merge order and titles only from that committed file. Agent-reported `testsRun` /
   `verify` are never executed; mismatches are reported in `notes`.
2. **SUMMARY files** are written by `merge-wave` from the ExecResult after a green merge. Executors
   do not write report files: in the smoke they declined to, citing Claude Code's subagent rule. The
   gsd self-check now lives in the returned `selfCheck` and the commits/files it verifies.
3. **Models:** `args.models[seat] = {model, effort}` for the seats
   planner | checker | executor | reviewer | verifier. Unset keys are omitted, so agents inherit.
   `muster preflight` computes `models`.
4. **Agent types** are `muster:muster-<name>`. Fixers reuse `muster-executor` with a fix brief.
   `agentHint` goes into the brief as a domain lens, not as the agent type.
5. **plan.js** returns `{runId, planPath, verdict: PASS|ISSUES|ERROR, revisions, issues, escalated:
   null|cap|stall|planner|checker|conflict, conflict?}`. Only blocker and warning issues bind a
   revision or count toward the stall rule, so info-only results PASS. A planner summary starting
   `REVISION_CONFLICT` escalates as `conflict` for the user. The planner returns
   `{status, planPath, taskCount, summary}`.
   The checker runs `muster plan-lint` itself; there is no separate lint stage.
6. **build.js** runs waves sequentially. A failed wave blocks later waves, and verification is then
   recorded as ABSTAIN. Wave N>1 executors first merge the earlier waves' reviewed commits. The
   verifier works in `.claude/worktrees/verify-<runId>` and writes VERIFICATION.md into the main
   checkout. The review cap is 2 fix rounds.
7. **Optional fields:** ReviewResult finding `line` is optional and `severity` is a free string;
   CheckResult `required_property` is optional.
8. **Task ids in PLAN.md** use `<task id="...">`, `taskId:` or `- id:`. STATE.md is a header that
   `next --run` rewrites, above a `## Log` section that only `merge-wave` appends to.

`merge-wave` removes a worktree only if all of these hold: its real path is under
`.claude/worktrees/`; the porcelain listing shows the task branch checked out there; that branch is
merged; and the worktree is clean. It never unlocks a worktree or uses `--force`, and it deletes
branches with `branch -d` only.

## Sync model (vendor/)

- `vendor/manifest.yaml` gsd source: `ref: 9385f46`, `tag: v1.20.1`. Each item records `{from,
  to, mode: adapted|verbatim|watch, baseBlob, issues:[…]}`.
- `vendor/upstream/gsd/<path>`: byte-exact upstream copies at the pin, never edited, used as the
  3-way merge base.
- `muster vendor update gsd --to <tag>` runs a 3-way `git merge-file` for adapted items and
  regenerates verbatim items. `watch` items appear in the report only.
- `vendor/reports/gsd-<tag>.md` is the per-item upstream diff report.
- `.github/workflows/upstream-watch.yml` runs weekly. It opens an issue when a new gsd release
  touches tracked files.

## Amendments from stage 3 (2026-11-10: wiring the dropped breadth back in)

9. **Specialists.** A task's `agent_hint` names a catalog agent id. `build-args` resolves a
   *dispatchable* one (not a workflow seat, not `readOnly` in the agent manifest, has Bash) to
   `agentType: "muster:<frontmatter name>"` (`src/specialists.js`; `wsh-debugger` runs as
   `muster:debugging-toolkit-debugger`). `build.js` dispatches that type for the build stage
   and puts the executor contract in the brief (branch check, tagged commit, no package
   installs, no SUMMARY file, ExecResult fields), since specialists do not carry it. Anything
   else runs `muster-executor` with the hint as a lens. Fixers stay `muster-executor`
   (amendment 4 unchanged).
10. **Skills.** A task's `skills="id, id"` binds builtin skills (`plugin/builtins/<id>/`).
    `build-args` writes `skills: [{id, path}]` with the absolute `SKILL.md` path; the builder
    reads each first and returns `skillsApplied: [{id, how, quote?}]` (optional in ExecResult);
    the reviewer gets the same skills and fails work that does not follow one; `build.js`
    reports bound skills without evidence as the task's `skillsMissing`. Path binding is
    deliberate: Workflow `agent()` has no skills option, frontmatter `skills:` preloading is
    per agent (not per task) and cannot load `disable-model-invocation` skills, and exposing
    the builtins as plugin skills would list 46 descriptions in every session.
    `muster plan-lint` blocks unknown skill ids, warns on unknown or non-dispatchable hints,
    and warns on a task with no `skills` attribute when a preflight `skillCandidates` entry
    scored >= 4 and matches the task (`skills=""` declines).
11. **preflight** also returns `skills`, `skillRoot`, `route` (`code` | `pipeline` | `ask`),
    `domain` and `pipeline`, and writes `skillCandidates` (with scores) to `preflight.json`.
    Seat tiers: planner, checker and verifier `prime`, executor and reviewer `core`.
12. **Worktree cap.** `build.js` starts at most `args.worktreeConcurrency` builders at once
    (default 3) to keep simultaneous `git worktree add` calls off `.git/config.lock`.
13. **Content pipelines.** `muster pipeline-args <runId>` writes `pipeline-args.json`
    (`{runId, outcome, contextPath?, pipeline:{id, title, gate}, phases:[{id, role, desc,
    skills}], artifactPath, models}`); `plugin/workflows/pipeline.js` runs the phases in order
    in the main checkout, then review + score as the gate (JS applies the floor and pass total;
    at most 2 revisions of the last author phase), then the remaining phases. It returns
    `{runId, pipeline, artifactPath, verdict: PASS|FAIL|ERROR, halted, revisions, score, review,
    phases}`; the main thread saves it as `pipeline-result.json`, which `next --run` reads.
14. **Worktree base (findings F1, probed live 2026-11-10 on 2.1.322).** In a scratch repo with a
    bare `origin` and one unpushed commit on the work branch, a Workflow
    `agent({isolation:'worktree'})` started at `origin/main` (the unpushed commit absent); with
    `{"worktree":{"baseRef":"head"}}` in `.claude/settings.local.json` it started at the local
    HEAD. Without a remote it falls back to local HEAD, which is why the stage-2 smokes passed.
    The base alone is not enough: `build-args.json` is committed after `base` is computed, so
    the base never contains PLAN.md. `build-args` therefore also records `branch` (the work
    branch), and the executor brief fast-forwards (`git merge --ff-only <branch>`, else the base)
    when PLAN.md is missing or the base is not an ancestor, then requires the base, blocking with
    `base mismatch` otherwise (never a reset), and
    preflight warns when `worktree.baseRef` is not `head` in a repo with a remote. A plugin
    `settings.json` cannot set `worktree`, so the setting stays the user's choice.
15. **Runtime limits (F8, F12, F13).** Up to 16 concurrent Workflow agents by default
    (`CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS`), 1,000 agents per run; the `Large workflow`
    warning (over 25 agents or 1.5M projected tokens) is advisory and expected for backlogs. In
    `claude -p`, background and cloud sessions, a usage limit fails the agent instead of pausing
    the run; the `agent()` wrapper records `{status:"error"}` and `/muster:go --run <runId>`
    retries. `CLAUDE_CODE_EFFORT_LEVEL`, `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`,
    `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL` and `CLAUDE_CODE_SUBAGENT_EFFORT` can replace
    `args.models[seat]`; preflight lists any that are set in `warnings`.
16. **Plan mode (F3, probed 2026-11-10).** Started with `--permission-mode plan`, the session
    declined the branch switch, the CONTEXT.md write and the Workflow call before any tool ran,
    citing plan mode. `/muster:plan` therefore leaves plan mode first (ExitPlanMode) instead of
    presenting the finished plan through it.
17. **Dev-team topologies** (`docs/strategy/dev-team-topologies.md`). `plugin/workflows/team.js`
    takes build's args plus `topology: {testFirst: auto|all|off, seats: auto|off, maxSeats,
    integrate: auto|all|off, escalate, seatRules}` and task fields `tdd` (set by `build-args` from
    `tdd="true"` or `type="tdd"`) and `reviewSeats`, and returns build's result plus per task
    `red`, `seats`, `integrationFix` and per run `topology` and `integration[]`, so `merge-wave`
    reads it unchanged (red commits are ancestors of the task commit on the same branch). Extra
    seats in `args.models`: `testWriter`, `integrator`, `escalate`. New schemas in `schemas.js`:
    RedResult, IntegrationResult, HypothesesResult, HypothesisResult. Its `<build-shared>` block is
    build.js's `<shared>` slice up to `reviewLoop`, byte for byte (tested); build.js is unchanged.
    `plugin/workflows/debug.js` takes `{symptom, repro?, context?, hypotheses?, maxHypotheses?,
    models.investigator}` and returns `{verdict: ROOT_CAUSE|COMPOUND|INCONCLUSIVE|ERROR,
    rootCause, contributing, ranking, hypotheses, investigations, challenges, next}`; it is
    read-only. `muster-test-writer` and `muster-integration-checker` are workflow seats in
    `src/specialists.js`, and the integration checker and `wsh-team-debugger` are `readOnly`,
    so no `agent_hint` builds with them. `wsh-code-reviewer` left the Claude plugin for
    `codex/frozen/agents/`.

## Amendments from PM stage B (2026-11-10: planning from a SPEC.md)

18. **Spec runs** (`docs/strategy/2026-11-pm-domain-design.md` "Plan integration",
    `docs/plan-format.md` "Planning from a spec"). `muster preflight` detects a SPEC.md in the
    outcome (or a backlog item's `{spec: path#REF-02}`), runs spec-lint in the same call and
    returns `spec: {path, anchor, status, ready, acs, invariants, evals, decisions,
    openQuestions}`; `clear` is `spec.ready` and `route` is `code`. New CLI steps:
    `muster spec-clarify <SPEC.md>` (one question round's answers on stdin, written under a dated
    `## Clarifications` session; a draft that now passes becomes `ready`), `muster spec-context
    <runId>` (CONTEXT.md gets the spec's D-NN verbatim and LOCKED, its non-goals as Deferred
    Ideas, and the spec's path and sha256; the command never hand-writes it) and `muster
    spec-trace <runId> [--accept <IDs>] [--coverage]` (the spec's Traceability block from
    PLAN.md `covers`/`proves` and the verifier's `## Acceptance` table; `status: shipped` when
    every ID is VERIFIED or accepted). `plan.js` takes `specPath` and passes the coverage rules
    to the planner and the delivery check to the checker on every round. PLAN.md gains `spec:`,
    `requirements:`, `ac:` on must-haves, `covers` on tasks and `proves` on `<automated>`;
    plan-lint's `spec_traceability` dimension applies only when `spec:` is set. Change-set and
    diff gates exclude `.muster/`.
