# PLAN.md format

The planner writes one `PLAN.md` per run at `.muster/runs/<runId>/PLAN.md`. The plan-checker
agent runs `muster plan-lint` on it (there is no separate lint stage) and folds those issues into
its own CheckResult; `muster next --run` and `build.js` read task ids from `<task id="...">`; and
`build.js` executes it wave by wave. This document is the contract between them.

The format is gsd's plan format (gsd-core v1.20.1, `agents/gsd-planner.md` `<plan_format>`) with
one structural change. gsd splits a phase into several `NN-PLAN.md` files, each holding 2-3 tasks
and carrying `wave`, `depends_on`, `files_modified` and `agent_hint` in its frontmatter; the plan
is gsd's unit of execution. muster's unit of execution is the task: one executor runs one task in
one worktree. So muster keeps a single `PLAN.md` per run and moves those scheduling fields onto
each `<task>` as attributes. Everything else (element names, checkpoint shapes, `<fails_when>`,
`<reversibility>`, `<precondition>`, the threat register, `must_haves`) is unchanged, so gsd's
planner and checker text applies as written.

## Skeleton

```markdown
---
run: 2026-11-09-auth-login        # the runId; matches the .muster/runs/<runId>/ directory
type: execute                     # execute | tdd
autonomous: true                  # false when any task is a checkpoint:*
tracer: true                      # optional; false opts out of tracer-first (gsd --no-tracer)
decisions: [D-01, D-03]           # optional; CONTEXT.md decision IDs this plan implements
user_setup: []                    # optional; human-required setup (gsd format)
must_haves:
  truths: []                      # observable behaviours that prove the outcome
  artifacts: []                   # files that must exist
  key_links: []                   # critical connections between artifacts
  prohibitions: []                # what must NOT change (gsd prohibition probe)
---

<objective>
[What this run accomplishes]

Purpose: [Why it matters]
Output: [Artifacts created]
</objective>

<context>
@.muster/runs/2026-11-09-auth-login/CONTEXT.md
@src/path/to/relevant/source.js
</context>

<tasks>

<task id="01" type="tracer" wave="1" agent_hint="wsh-backend-architect" skills="wsh-nodejs-backend-patterns">
  <name>End-to-end "log in" through one path only</name>
  <files>src/routes/login.js, src/auth/session.js, test/login.e2e.test.js</files>
  <action>Wire POST /login through the session store to a signed cookie. One entry point, no
  other call sites. Real error handling on the single path.</action>
  <verify>
    <automated>npm test -- test/login.e2e.test.js</automated>
    <fails_when>non-zero exit, or "0 passing" in the summary line</fails_when>
  </verify>
  <done>Valid credentials return 200 and a session cookie; the e2e test is committed.</done>
</task>

<task id="02" type="auto" wave="2" depends_on="01" tdd="true">
  <name>Reject invalid credentials</name>
  <reversibility rating="reversible">Error shape is internal to the route.</reversibility>
  <files>src/auth/verify.js, test/verify.test.js</files>
  <behavior>
    - wrong password returns 401
    - unknown user returns 401 with the same body
  </behavior>
  <action>Compare with a constant-time check; never reveal which field was wrong.</action>
  <verify>
    <automated>node --test test/verify.test.js</automated>
    <fails_when>any "not ok" line, or a non-zero exit</fails_when>
  </verify>
  <done>Both cases return 401 with an identical body.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| client→API | untrusted credentials cross here |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-01 | Spoofing | src/auth/verify.js | high | mitigate | constant-time compare |
| T-SC | Tampering | npm installs | high | mitigate | no new dependencies |
</threat_model>

<verification>
[Run-level checks after every task merges]
</verification>

<success_criteria>
[Measurable completion]
</success_criteria>
```

## Frontmatter

| Field | Required | Meaning |
|---|---|---|
| `run` | yes | The runId. Replaces gsd's `phase` + `plan`. |
| `type` | yes | `execute` or `tdd`, as in gsd. |
| `autonomous` | yes | `false` when the plan has any `checkpoint:*` task. |
| `must_haves` | yes | Goal-backward criteria: `truths`, `artifacts`, `key_links`, and optionally `prohibitions`. |
| `tracer` | no | `false` opts out of tracer-first. Absent means tracer-first applies. |
| `decisions` | no | `D-NN` IDs from the run's CONTEXT.md that this plan implements. Replaces gsd's `requirements`. |
| `user_setup` | no | gsd's format, unchanged. |

Dropped from gsd's frontmatter: `phase`, `plan` (replaced by `run`), `wave`, `depends_on`,
`files_modified`, `agent_hint` (moved onto tasks), `requirements` (replaced by `decisions`),
`estimate` (muster computes cost from the tier map, not a calibration file).

## Tasks

Each `<task>` is one executor dispatch in its own worktree.

### Attributes

| Attribute | Required | Meaning |
|---|---|---|
| `id` | yes | Unique in the plan (case-insensitive), 1-64 chars of `[A-Za-z0-9._-]`, alphanumeric first. Use two-digit numbers: `01`, `02`. This is `build.js`'s `taskId` and names `SUMMARY-<id>.md`. |
| `type` | no | `auto` (default when absent), `tracer`, `tdd`, or `checkpoint:human-verify` / `checkpoint:decision` / `checkpoint:human-action`. |
| `wave` | yes | Integer ≥ 1. Tasks in one wave run in parallel. |
| `depends_on` | no | Comma- or space-separated task ids. Every dependency sits in an earlier wave. |
| `agent_hint` | no | One plugin agent id from the catalog (gsd's `agent_hint`, per task), e.g. `wsh-debugger`. Absent means the default executor. A dispatchable agent (not a workflow seat, not read-only, has Bash) builds the task itself: `build-args` resolves it to the Workflow `agentType` (`muster:<frontmatter name>`, so `wsh-debugger` runs as `muster:debugging-toolkit-debugger`) and the build brief carries the executor contract. Any other id stays a domain lens in the default executor's brief. |
| `skills` | no | Comma- or space-separated builtin skill ids (`plugin/builtins/<id>/`), e.g. `skills="sp-tdd, sp-debug"`. The builder Reads each `SKILL.md` before working and returns `skillsApplied: [{id, how, quote}]`; the reviewer checks the diff against the same skills, and not following one is a FAIL finding. `skills=""` records that the planner considered preflight's candidates and declined them. |
| `tdd` | no | `"true"` for a test-first task; pair it with `<behavior>`. |

### Wave rules

These are gsd's planner rules (`assign_waves`), applied per task:

- No dependencies: wave 1. Otherwise `wave = max(wave of each dependency) + 1`.
- Same-wave tasks have zero `<files>` overlap. A file shared with an earlier task pushes the later
  task to the next wave. In muster this is a hard rule: same-wave tasks run in separate
  worktrees, so a shared file is a guaranteed merge conflict.

### Elements (auto, tracer, tdd)

| Element | Required | Meaning |
|---|---|---|
| `<name>` | yes | Action-oriented task name. |
| `<files>` | yes | Exact repo-root-relative paths created or modified, comma- or newline-separated. Never empty. |
| `<action>` | yes | Specific directive prose. No fenced code blocks inside it. |
| `<verify>` | yes | Holds one or more `<automated>` commands, each followed by its `<fails_when>`. |
| `<done>` | recommended | Measurable acceptance state. |
| `<reversibility rating="reversible\|costly\|one-way">` | no | One-line rationale for a decision this task implements (gsd #1951). |
| `<precondition>` | no | One checkable fact the task assumes that ordering does not guarantee. |
| `<behavior>` | with `tdd="true"` | Bullet list of expected test behaviours. |
| `<read_first>` | no | Files the executor reads before acting. |

### The verify contract

Copied from gsd `references/failing-direction.md` and `planner-verify-command-grounding.md`:

- Every `<verify>` contains at least one non-empty `<automated>` command, runnable from the repo
  root in under about a minute.
- Each `<fails_when>` binds to the nearest preceding `<automated>` in the same task; a command's
  binding statement is the first one after it. N commands need N statements. Placeholders
  (`TBD`, `todo`, `n/a`, `none`, `unknown`, `tba`, `?`, `-`) are not failure signals.
- Paths in commands are repo-root-relative, never absolute. A `cd` or `npm --prefix` target must
  exist (or be created by a task's `<files>`) and hold the `package.json` / `Makefile` the
  command needs. Prefer `npm --prefix <dir> run <script>` to `cd <dir> && npm run <script>`.
- A count/match gate (`grep -q`, `grep -c`, `rg`, `test -f`) must fail at HEAD, before the work
  exists. One that already passes measures nothing. Anchor it to the text the task creates, or
  record the pre-change result in the command as `# baseline at HEAD: <result>` and assert a
  change from it.
- `MISSING — <test> must be created first` is gsd's Wave-0 sentinel. muster's merge step re-runs
  every verify command, so a sentinel must be replaced before its task merges; plan-lint flags it.

### Checkpoint tasks

gsd's shapes, unchanged (`references/checkpoints.md`). Each needs `<resume-signal>`, plus:

| Type | Also requires |
|---|---|
| `checkpoint:human-verify` | `<what-built>`, `<how-to-verify>` |
| `checkpoint:decision` | `<decision>`, `<options>` of `<option id="…">`; optional `auto_select="<id>"` on the task |
| `checkpoint:human-action` | `<action>`, `<instructions>`, `<verification>` |

A plan with any checkpoint sets `autonomous: false`. A task rated `one-way` is preceded by a
`checkpoint:decision`, unless CONTEXT.md already settles that decision.

### Tracer-first

gsd's default decomposition: the plan leads with exactly one `type="tracer"` task, the thinnest
path through every layer the run touches, with a real end-to-end `<verify>`. Every other task is
an expansion that runs in a later wave than the tracer. `tracer: false` in frontmatter opts out
when the architecture is already proven.

## Threat register

gsd's `<threat_model>` block, unchanged except the ID grammar. A run has no phase, so IDs are
`T-NN` (gsd's `T-{phase}-NN` is also accepted). IDs are unique within the plan. `T-SC`, the
supply-chain row, is reserved and not counted as a duplicate.

## Checking a plan

```
muster plan-lint .muster/runs/<runId>/PLAN.md [--json] [--root <repo>]
```

Output is a CheckResult: `{verdict: "PASS" | "ISSUES", issues: [{dimension, severity,
required_property, summary}]}`. Any issue makes the verdict `ISSUES`. The exit code is 0 when no
issue is a blocker, 1 when at least one is, and 2 when the plan was not evaluated (missing or
unreadable file, bad usage). Treat any exit other than 0 or 1 as "not evaluated", never as a pass.

The CLI checks `agent_hint` and `skills` against the plugin catalog (`src/specialists.js`) and
reads `preflight.json` from the PLAN.md's directory for the skill-candidate warning; `lintPlan()`
called without `catalog` / `skillCandidates` options checks only the id shapes.

`--root` (default: the current directory) anchors the filesystem probes. plan-lint is a
pre-execution gate: it compares gates against the tree as it is when you run it, so run it before
any task's work lands.

| Dimension | Blocker | Warning |
|---|---|---|
| `plan_structure` | missing/invalid frontmatter, missing required field, truncated file, unclosed fence or `<task>`, no tasks | unknown task type |
| `task_completeness` | missing id/name/action/verify/files, empty `<files>`, duplicate id, checkpoint fields, checkpoints with `autonomous` not false, a `skills` id that is malformed or not a builtin | missing `<done>`, malformed `agent_hint`, an `agent_hint` that is not a catalog agent or cannot execute (read-only, workflow seat), a task with no `skills` attribute when a preflight skill candidate scored ≥ 4 and matches the task's name and action |
| `nyquist_compliance` | `<verify>` with no `<automated>`; command with missing, blank or placeholder `<fails_when>` | orphan `<fails_when>`, MISSING sentinel |
| `verify_command_paths` | `cd`/`--prefix` target missing, or missing its manifest | dynamic path, target outside root, unreadable manifest, missing npm script |
| `verify_command_sanity` | gate already passes at HEAD | same, with a recorded baseline |
| `dependency_correctness` | unknown dependency, cycle, missing or invalid wave, wave not after a dependency, same-wave file overlap | wave later than dependencies and files require |
| `tracer_first` | | no tracer, several tracers, tracer not first, a task not after the tracer |
| `reversibility` | | unknown rating, one-way without a preceding checkpoint:decision |
| `threat_model` | duplicate threat ID | |

plan-lint never executes plan text. The already-passing probe only evaluates commands it can
decide by reading files (`test -f|-e|-d|-s`, `[ -f … ]`, and `grep`/`rg` of a literal pattern in
named files); anything else is left to the checker.
