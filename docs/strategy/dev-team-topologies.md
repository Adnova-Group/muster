# Dev-team topologies

The crew muster dispatches to build software, and the team shapes it runs them in. This doc covers
what changed on 2026-11-10 (the dev-team track of revival stage 3), why, and the evidence behind it.
The contracts it extends are in `docs/strategy/stage-2-contracts.md`, amendment 17.

## What is in place

| Workflow | What it adds | Invocation |
|---|---|---|
| `muster:build` (unchanged) | executor per task in its own worktree, one reviewer, at most 2 fix rounds, one verifier; specialist builders and bound skills (amendments 9-12) | `Workflow({name:"muster:build", args:<build-args.json>})` |
| `muster:team` (new) | build's stages plus four topologies, each applied only where it pays | `Workflow({name:"muster:team", args:<build-args.json>})`, same result shape, so `muster merge-wave` reads it unchanged |
| `muster:debug` (new) | competing-hypotheses root cause: read-only, no worktrees | `Workflow({name:"muster:debug", args:{symptom, repro?, context?, hypotheses?, maxHypotheses?, models?}})` |

`/muster:go` step 5 picks `muster:team` when a task has `tdd` or a wave has 2+ tasks.
`/muster:diagnose` step 3 runs `muster:debug` when two or more causes stay plausible.

### `muster:team` topologies

| Topology | Applies to (default) | Agents it adds | Off switch |
|---|---|---|---|
| **Test-first split** | tasks with `tdd: true` (`build-args` sets it from `tdd="true"` or `type="tdd"`) | `muster-test-writer` commits failing tests in an isolated worktree (`[run/task red]`); the planned builder then goes green **in the same worktree**; the reviewer checks `git diff <red> HEAD -- <test files>` and fails a deleted or loosened assertion; the builder must list any red-file edit as `[TestEdit]` | `topology.testFirst: "off"` (`"all"` splits every task) |
| **Specialist review seats** | tasks whose changed files, task files or title match a seat rule | up to 2 seats per task, in parallel with `muster-reviewer` in round 0 only | `topology.seats: "off"`, `topology.maxSeats`, or per task `reviewSeats: [...]` |
| **Wave integration check** | waves of 2+ tasks, after every task passed review | `muster-integration-checker` merges the wave on a scratch worktree, runs the suite, checks exports/imports/contracts and collisions; each blocker names the task(s) to fix; one routed fix round (scoped re-review per task), then one re-check | `topology.integrate: "off"` (`"all"` checks single-task waves too) |
| **Bounded fix loop** | every task | the re-review after a fix is **scoped** to the fix diff (each open finding ADDRESSED or NOT ADDRESSED, plus new breakage); the loop stops early when the open-finding count does not fall; the last allowed round runs on `models.escalate` when set | `topology.escalate: false` |

Seat rules (first matches win; agent types are frontmatter names):

| Seat | Pattern (files, title) | Agent type |
|---|---|---|
| security | auth, login, session, token, passw, secret, crypt, permission, oauth, jwt, csrf, cors, sanitize | `muster:backend-development-security-auditor` (wsh-security-auditor) |
| silent-failure | error, retry, fallback, catch, handler, client, adapter, queue, worker | `muster:prt-silent-failure-hunter` |
| types | `.d.ts`, `types/`, schema, `models/` | `muster:prt-type-design-analyzer` |
| tests | test/spec paths (skipped on tdd tasks: the test writer already owns the tests) | `muster:prt-pr-test-analyzer` |
| ux | `.tsx .jsx .vue .svelte .css .scss .html` | `muster:intent-vigil` |

A seat counts only when it returns FAIL on the exact commit with blocker/critical/high findings;
those join the primary findings with a `[seat]` prefix. A seat's PASS never overrides the primary
reviewer. An errored seat (for example a `prt-*` agent that is not installed) is recorded as
`NOT_COUNTED`. The `prt-*` agents are vendored by the complements track; until they land, those
seats record `NOT_COUNTED` and cost one failed spawn each.

Seat models: `args.models` accepts `testWriter`, `integrator` and `escalate` on top of build's
`executor`, `reviewer` and `verifier`. Result additions: per task `red`, `seats`,
`integrationFix`; per run `topology` and `integration: [{wave, verdict, checks, fixed, reason?}]`.

### `muster:debug`

1. **Hypothesize** (skipped when `args.hypotheses` is given): one `wsh-team-debugger` in generate
   mode returns 3-5 falsifiable hypotheses across failure-mode categories.
2. **Investigate**: one read-only investigator per hypothesis, in parallel (cap 5).
3. **Challenge**: only when 2+ hypotheses survive (CONFIRMED or PLAUSIBLE), a fresh investigator
   gets every report and tries to disprove each survivor. Workflow agents cannot message each
   other, so this round stands in for agent teams' debate.
4. **Arbitrate** in script code, never by an agent: status, then confidence, then supporting minus
   twice the contradicting evidence. One CONFIRMED (or a 10-point lead) is `ROOT_CAUSE`; two close
   CONFIRMED are `COMPOUND`; none is `INCONCLUSIVE`.

It returns `{verdict, rootCause, contributing, ranking, hypotheses, investigations, challenges,
next}`. The fix is not part of it: diagnose runs it as a one-task `tdd="true"` plan through
`muster:team`, so the regression test is written by someone other than the fixer.

## Roster

| Agent | Decision | Why |
|---|---|---|
| muster-planner, muster-plan-checker, muster-verifier | keep (descriptions trimmed by 63 bytes to pay for the new seats) | gsd-derived and measured; the planner already emits `tdd="true"` |
| muster-executor, muster-reviewer | keep | the builder/fixer and primary reviewer of both workflows |
| muster-strategist, muster-investigator, muster-surgeon, muster-improver | keep | different jobs (approach review, locating, 1-2 file edits, retrospectives); none is a team seat |
| **muster-test-writer** | **new**, adapted from gsd-core `gsd-nyquist-auditor` (MIT, merge-tracked; its adversarial stance is a verbatim region) | the independent test author of the test-first split; `red` and `cover` modes |
| **muster-integration-checker** | **new**, adapted from gsd-core `gsd-integration-checker` (MIT, merge-tracked; three verbatim regions) | per-wave cross-task wiring check; phases become wave tasks |
| **wsh-team-debugger** | **new**, adapted from wshobson `agent-teams/team-debugger` (MIT, merge-tracked at 9c61ab2) | the hypothesis investigator; TaskList/SendMessage removed, generate and challenge modes added |
| wsh-code-reviewer | **retired** to `codex/frozen/agents/` | duplicates muster-reviewer (rank 55 vs 50) and no workflow dispatches it (read-only, so routing never builds with it); its body is a tool-name list ("Trag, Bito, Codiga") rather than a method |
| wsh-debugger | keep | it is the `debug` role provider the frozen Codex lane's diagnose seed resolves, and routing made it a dispatchable builder; wsh-team-debugger ranks below it (45) |
| wsh-test-automator | keep | routing made it a dispatchable builder for test-only tasks; muster-test-writer ranks below it (45) and is a workflow seat, never a hint-dispatched builder |
| wsh-security-auditor | keep, now also the security seat | needs only a schema return in the seat brief |
| other wsh-* domain agents | keep | builders by hint since routing; see gaps |
| wsh-business-analyst, -content-marketer, -customer-support, -data-scientist | keep (out of dev scope) | knowledge-work breadth; candidates for the PM track to retire |
| intent-* | keep | intent-vigil doubles as the UX seat |

The three new agents set `"codex": false` in `catalog/agents.manifest.json`. muster-test-writer and
muster-integration-checker are `WORKFLOW_SEATS` in `src/specialists.js`; the integration checker and
the team debugger are `readOnly`, so no `agent_hint` makes any of them a builder. Description bytes:
+144 for the new agents, -61 for wsh-code-reviewer, -63 from trims, so the total is 3,984 of the
4,000-byte budget (it was 3,964); the budget was not raised.

## Evidence

| Source | Stars / license / last push (2026-11-10, `gh api`) | Read | Taken |
|---|---|---|---|
| Claude Code docs: [agent-teams](https://code.claude.com/docs/en/agent-teams.md), [sub-agents](https://code.claude.com/docs/en/sub-agents.md), [workflows](https://code.claude.com/docs/en/workflows.md) | docs | full | "Debugging with competing hypotheses" is a named strongest use case; "The debate structure is the key mechanism here. Sequential investigation suffers from anchoring"; "Start with 3-5 teammates"; "Two teammates editing the same file leads to overwrites"; teams are experimental, "No nested teams"; Workflow: 16 concurrent agents, 1,000 per run, no mid-run input |
| Anthropic, [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) | article | full | multi-agent beat single-agent Opus 4 "by 90.2%" on research; "about 15× more tokens than chats"; "most coding tasks involve fewer truly parallelizable tasks than research"; each subagent needs "an objective, an output format, guidance on the tools and sources to use, and clear task boundaries" |
| Anthropic, [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) | article | full | "finding the simplest solution possible"; evaluator-optimizer (review loop), parallelization as sectioning (seats) and voting, orchestrator-workers |
| [wshobson/agents](https://github.com/wshobson/agents) `agent-teams`, `full-stack-orchestration` | 42,372 / MIT / 2026-11-09; pinned 9c61ab2 = HEAD | team-debugger, team-implementer, team-reviewer, parallel-debugging skill | team-debugger vendored; the ACH result-arbitration protocol became debug.js's scoring; team-reviewer's one-dimension-per-reviewer is the seat brief; team-implementer's file ownership is what plan waves already enforce (zero same-wave file overlap) |
| [obra/superpowers](https://github.com/obra/superpowers) subagent-driven-development | 315,282 / MIT / 2026-11-03 | SKILL.md, fix-loop.md, task-reviewer-prompt.md | scoped re-review (ADDRESSED / NOT ADDRESSED on the fix diff), escalation to a stronger model on late fix rounds, "Do Not Trust the Report", no reviewer-spawned reviewers. Not revived as a skill: muster:team now carries these mechanics in code |
| [open-gsd/gsd-core](https://github.com/open-gsd/gsd-core) v1.20.1 (9385f46) | MIT; local clone | integration-checker, nyquist-auditor, code-fixer, debugger, debug-session-manager | integration-checker and nyquist-auditor adapted. code-fixer (45 KB) overlaps muster-executor's fix brief; gsd-debugger (47 KB) is a single-agent long session that the hypothesis fan-out replaces |
| [VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents) | 26,455 / MIT / 2026-11-02 | debugger, surgeon-reviewer, qa-expert, test-automator | ideas only: most bodies are keyword lists with a "query context manager" step no harness has; surgeon-reviewer's "disprove each suspicion before reporting" is already muster-reviewer's adversarial stance |
| [bmad-code-org/BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD) | 55,192 / MIT (LICENSE file; the API says NOASSERTION because of a trademark notice) / 2026-11-08 | bmad-code-review step-02, edge-case-hunter, verification-gap | ideas: parallel review lenses that start together and record failed lenses (the seat NOT_COUNTED rule); verification-gap ("a gap finding is a request to add or change one test") is a candidate tests seat once prt-pr-test-analyzer is measured |
| [contains-studio/agents](https://github.com/contains-studio/agents) | 12,422 / no license / 2025-07-28 | directory listing only | nothing (no license: ideas-only, and none were needed) |
| vijaythecoder/awesome-claude-agents, 0xfurai/claude-code-subagents, iannuttall/claude-agents, lst97/claude-code-sub-agents | 4,405 / 1,023 / 2,038 / 1,707, all MIT | listings | nothing: stack-specific persona prompts with no protocol |
| [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) pr-review-toolkit | 46,673 / Apache-2.0 / 2026-11-10 | agent list, pr-test-analyzer | the three prt-* seats (vendored by the complements track) |
| AgentCoder, arXiv [2312.13010](https://arxiv.org/abs/2312.13010) | paper | abstract | programmer, test designer and test executor as separate agents: 96.3% / 91.8% pass@1 (HumanEval / MBPP, GPT-4) vs 90.2% / 78.9% for the prior best, at less token overhead |
| ImpossibleBench, arXiv [2510.20270](https://arxiv.org/abs/2510.20270) | paper | abstract | "an LLM agent with access to unit tests may delete failing tests rather than fix the underlying bug": the reason the builder may not edit red tests and the reviewer diffs them |

What the evidence does **not** show: no source measures the integration-check pass or diff-matched
review seats on coding tasks. They are mechanisms (gsd's integration audit, the docs' parallel
review example) adopted for a known failure mode of parallel worktrees, not measured wins. The
smoke below shows they run; whether they pay for their tokens needs a run-record comparison of
`muster:build` vs `muster:team` on real plans.

## Live smoke (2026-11-10)

Claude Code 2.1.319, `claude -p --model sonnet --plugin-dir plugin` (installed muster disabled),
every workflow seat on haiku, `topology.seats: "off"`. Scratch repo with no remote. The PLAN had
one wave of two tasks: task 01 `tdd="true"` (`slugify`), and task 02 (`formatTitle`, which
imports task 01's `slugify` and is told not to write its own).

| Agent (label) | Result |
|---|---|
| `red 01` (muster-test-writer, own worktree) | commit `22d0ea9` `test(01): ... [smoke1/01 red]`: `test/slugify.test.js` only (+78), `failingAsExpected: true` |
| `build 01` (muster-executor, green brief, no isolation) | commit `44585f7`, parent `22d0ea9`, same worktree `wf_...-1`: `src/slugify.js` only (+9); `git diff 22d0ea9 44585f7 -- test/` is empty |
| `build 02` (own worktree) | commit `3d136e1`; it reported that its test cannot pass alone (the import lands with 01) |
| `review 01 r0`, `review 02 r0` | PASS, 1 round each; 01's reviewer added a non-blocking note on `slugify(null)` |
| `integrate w1 r0` (muster-integration-checker) | merged both on a scratch worktree, ran the suite (7 tests pass when named) and returned PASS with two warnings: the fixture's `npm test` script and a stale `base` in the args; it removed its scratch worktree |
| `verify smoke1` | **GAPS**: `npm test` (`node --test test/`) fails on Node 26 with MODULE_NOT_FOUND. That is a defect in the smoke fixture's package.json, not in the run's code, and the verifier said so instead of guessing PASS |

7 agents. The session reported `total_cost_usd` 0.58 and `duration_ms` 43,208 for its final turn.
Seats and the routed integration fix are covered by the stubbed tests in
`test/workflows-team.test.js`, not by this live run.

## Integration notes for build.js

`muster:team` does not edit `build.js`. Its `<build-shared>` block is build.js's `<shared>` block
from the first line up to `reviewLoop`, byte for byte (`test/workflows-team.test.js` enforces it),
so routing's specialist dispatch, bound skills, worktree limiter and F1 sync step apply unchanged.
When build.js changes inside that slice, paste the same slice into team.js. Folding team into
build (a `topology` arg defaulting to the lean path) is possible later: the team stages are
self-contained functions after the block.

## Gaps

- **Specialist builders are generalist personas.** Since routing, a wsh-* agent can be a task's
  builder, but most bodies are capability lists written for chat ("Format the response as
  markdown: production-ready TypeScript/React code blocks"). The brief's contract lines override
  them; nobody has measured whether a persona builder beats muster-executor with the hint as a
  lens.
- **Seat selection is path matching**, not diff content: the script has no diff text. A seat
  could instead be chosen by the primary reviewer, at the cost of a second round.
- **No measured cost/benefit** for seats and integration checks yet (see Evidence).
- **prt-* seats depend on the complements track.**
