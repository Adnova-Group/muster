# Research: agent-definition patterns for a dispatchable lifecycle agent

Input for the `muster-runner` agent (drives ONE work item through the full lifecycle when
dispatched as a subagent). Every pattern below is judged against muster's principles:
glass-box, TDD, review-gate (explicit PASS, fixes always re-reviewed), fail-loud,
code-over-model. Clean-room rule applied: mechanisms are adapted, text is never copied
from non-MIT/Apache sources.

Sources reviewed: 9 (minimum required: 5).

## License posture

| Source | License | Usable how |
|---|---|---|
| wshobson/agents | MIT | mechanisms + text adaptable |
| VoltAgent/awesome-claude-code-subagents | MIT | mechanisms + text adaptable |
| obra/superpowers | MIT | mechanisms + text adaptable |
| humanlayer/12-factor-agents | Apache-2.0 (code) / CC BY-SA (prose) | mechanisms; avoid prose copying |
| Anthropic subagents docs (code.claude.com/docs/en/sub-agents) | proprietary | mechanisms only |
| Anthropic "Building Effective Agents" | proprietary | concepts only |
| contains-studio/agents | none found | mechanisms only, never text |
| disler/infinite-agentic-loop | none found | mechanisms only, never text |
| hesreallyhim/awesome-claude-code | CC BY-NC-ND 4.0 | pointer index only, no derivation |

## 1. wshobson/agents (MIT) — https://github.com/wshobson/agents

The pack muster already vendors as `wsh-*`. Frontmatter quartet (`name`, `description`,
`model`, `tools`), description ending in a trigger clause ("Use PROACTIVELY for ...").

- ADOPT — trigger clause at the end of the description: it is the documented
  auto-delegation mechanism and feeds `muster match` token search.
- ADOPT — explicit per-agent `tools` allowlist (read-only reviewers): enforced
  constraint, not prompt-hoped; code-over-model.
- ADOPT — model-tier routing per role (heavy for judgment, cheap for mechanical):
  muster's `modelForRole` already encodes this.
- ADOPT (skeleton only) — a single numbered "response approach" procedure: the one
  load-bearing body section.
- REJECT — 100+-line "Capabilities" laundry lists: token-heavy persona padding with no
  behavioral force. Muster's vendored copies already prune these.

## 2. Anthropic subagents documentation — https://code.claude.com/docs/en/sub-agents

- ADOPT — description = capability sentence + explicit trigger ("Use immediately
  after ..."): the auto-invocation contract.
- ADOPT — `tools` allowlist; reviewers get no Write/Edit.
- ADOPT — imperative "When invoked: 1..N" opening: removes dithering at spawn.
- ADOPT — hard stop conditions (`maxTurns` concept): translate to a bounded fix-loop
  with loud escalation on cap, never a silent grind.
- ADOPT (concept) — worktree isolation as a first-class dispatch property: the runner
  demands an isolated branch/worktree before touching code.
- ADOPT cautiously — persistent agent memory: glass-box only if human-readable and in
  the repo; muster's per-item `.muster/STATE.md` is the compliant form.
- REJECT — relying on inherited tools (omitting `tools`): implicit grants are the
  opposite of a visible contract.

## 3. VoltAgent/awesome-claude-code-subagents (MIT) — https://github.com/VoltAgent/awesome-claude-code-subagents

- ADOPT (shape only) — machine-parseable progress/receipts structure (files touched,
  issues, verdicts): glass-box receipts; muster validates such shapes in code.
- ADOPT selectively — short per-domain review checklists: checklists beat vibes, but
  only if short enough to actually run.
- REJECT — "communication protocol" JSON messages to a fictional context manager:
  cargo-cult; simulating infrastructure that does not exist violates fail-loud.
- REJECT — "integration matrix" naming collaborator agents: aspirational
  cross-references the runtime does not honor; orchestration belongs to the
  orchestrator/coordination skills.

## 4. hesreallyhim/awesome-claude-code (CC BY-NC-ND) — https://github.com/hesreallyhim/awesome-claude-code

- ADOPT — instruction-budget / progressive-disclosure thinking (via its pointers):
  every line in an unattended agent's prompt competes for attention; gate rules must be
  short and absolute.
- REJECT — as a copy source: NoDerivatives license; index only.

## 5. obra/superpowers (MIT) — https://github.com/obra/superpowers

The richest source for lifecycle mechanics (subagent-driven-development,
requesting-code-review, finishing-a-development-branch skills).

- ADOPT — dual-verdict review gate: spec compliance AND code quality must both pass,
  explicitly; either failure loops. The strongest published form of the explicit-PASS
  gate.
- ADOPT — fix loop returns to the SAME reviewer for re-review until PASS: exactly
  muster's gates-always-re-verify rule, independently converged on.
- ADOPT — durable progress ledger with commit ranges, consulted before resume:
  "conversation memory does not survive compaction"; re-dispatching completed work is
  the most expensive observed failure. Muster form: per-item `.muster/STATE.md`.
- ADOPT — briefs/diffs/reports passed as file paths, never pasted prose: deterministic
  artifacts, context hygiene, and receipts in one move.
- ADOPT — BLOCKED as a first-class outcome; never silent retry with unchanged inputs:
  fail-loud escalation semantics.
- ADOPT — tests-pass as a hard precondition before disposition options exist.
- ADOPT — red-flags sections naming the exact rationalizations the model will attempt
  ("close enough on spec" is not done).
- ADOPT — destructive dispositions never auto-selected unattended.

## 6. contains-studio/agents (no license) — https://github.com/contains-studio/agents

- ADOPT (mechanism, clean-room) — worked trigger examples embedded in the description:
  few-shot triggers sharpen auto-delegation.
- ADOPT — explicit constraints + success metrics per agent: the agent carries its own
  definition of done.
- ADOPT (pattern, not content) — house philosophy threaded through every agent: for
  muster that thread is glass-box/TDD/gate/fail-loud/code-over-model.
- REJECT — 500+-word persona minimum: word-count floors encourage padding.

## 7. disler/infinite-agentic-loop (no license) — https://github.com/disler/infinite-agentic-loop

- ADOPT — filesystem-as-state reconnaissance: derive progress from the repo/branch/
  ledger on disk, never from conversation memory. Pure glass-box.
- ADOPT — standardized dispatch-prompt template (context + assignment + constraints):
  auditable receipts.
- ADOPT — wave sizing / batch caps for parallel fan-out (muster's waves already do).
- REJECT — LLM self-monitored "context capacity" loop conditions: models cannot
  reliably introspect remaining context; use deterministic counters. Code-over-model.
- REJECT — the infinite loop itself: a lifecycle agent needs a terminal state per item.

## 8. humanlayer/12-factor-agents (Apache-2.0) — https://github.com/humanlayer/12-factor-agents

- ADOPT — "own your control flow": mostly deterministic code with LLM decision points
  strategically placed. The thesis statement of code-over-model.
- ADOPT — small focused agents: lifecycle STAGES stay narrow (builder, reviewer) under
  one driver, not one mega-prompt doing everything inline.
- ADOPT (with guard) — compact errors into context for the fix loop, but raw failures
  must still land in receipts; lossy-only error handling violates fail-loud.
- ADOPT — contact humans via structured actions: escalation is a payload (STATE entry,
  board flip, question file), not free text in a summary.
- ADOPT — stateless-reducer resume: rebuild position from durable state.

## 9. Anthropic "Building Effective Agents" — https://www.anthropic.com/engineering/building-effective-agents

- ADOPT — workflows vs agents framing: a lifecycle driver is a WORKFLOW (fixed stage
  order it may not reorder) with agentic steps inside the gates.
- ADOPT — evaluator-optimizer loop: the review-gate fix loop, stated generally.
- ADOPT — explicit iteration caps with loud escalation on cap.
- ADOPT — poka-yoke interfaces: a PASS that cannot be emitted without attached
  evidence is a PASS worth trusting.

## Cross-cutting mechanisms adopted into muster-runner (ranked)

1. Explicit-PASS review gate with same-reviewer re-review fix loop (superpowers;
   Anthropic evaluator-optimizer) — the core of the def.
2. Durable glass-box ledger + filesystem reconnaissance on start/resume (superpowers;
   disler; 12-factor) — per-item `.muster/STATE.md`, receipts pasted not paraphrased.
3. Deterministic enforcement over prompt-hoping — muster CLI calls (`manifest validate`,
   `tally`, `doctor`) as the gate math; bounded fix loops; isolation precondition.
4. Artifacts-as-handoffs — briefs/diffs/review reports referenced as paths.
5. Description = capability + trigger clause, searchable via `muster match`.
6. BLOCKED/escalation as a first-class structured outcome; never silent retry.
7. Hard preconditions before disposition; destructive dispositions never auto-picked.
8. Red-flags list naming the rationalizations to refuse.
9. Imperative numbered procedure; no persona padding, no fictional protocols.
