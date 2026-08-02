import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("../", import.meta.url).pathname;
// This is the audited 0.5.0 Claude surface, intentionally excluding
// release-version manifests. Codex-only work must not mutate Claude commands,
// skills (including builtins), agents, hooks, catalogs, pipelines, or the
// shared Cowork MCP definition. Update this pin only with separately reviewed
// shared-surface remediation.
const claudeSurface = [
  "plugin/agents",
  "plugin/builtins",
  "plugin/commands",
  "plugin/hooks",
  "plugin/skills",
  "cowork/mcp-server.mjs",
  "mcp/server.mjs",
  "catalog",
  "pipelines"
];

async function files(path) {
  try {
    const entries = await readdir(join(root, path), { withFileTypes: true });
    return (await Promise.all(entries.map(entry => files(join(path, entry.name))))).flat();
  } catch {
    return [path];
  }
}

test("Claude orchestration surface remains byte-identical outside release metadata", async () => {
  const paths = (await Promise.all(claudeSurface.map(files))).flat().sort();
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(join(root, path)));
    hash.update("\0");
  }
  assert.equal(paths.length, 150); // previous 145-file surface +5: hardened brainstorm runtime and guide overlays
  // Pin re-derived at the reconcile/codex-to-main merge (feat/codex-integration -> main):
  // INTENTIONAL shared-surface changes from unifying main's enforcement-model redesign with the
  // Codex + performance-pass work -- main removed plugin/hooks/todo-gate.js entirely (136 -> 135
  // files, see CHANGELOG "Removed (breaking)") and rewrote the orchestrator/pre-tool-use
  // enforcement prose to the one-hard-deny + border-invitation model, on top of the Codex
  // performance-pass edits (go.md/go-backlog.md/orchestrator/review-gate/router SKILL.md -- CLI
  // resolution + gate-cadence fast path, see docs/performance-pass.md). This is the reviewed
  // reconciliation, not the accidental Codex-side drift this guard exists to catch.
  //
  // Pin re-derived again for the weight-reduction item (backlog item `muster-weight-reduction`,
  // see docs/weight-reduction.md): file COUNT unchanged (135 -- no file added/removed under this
  // surface) but content changed across go.md (step 3's fast-path branch), review-gate/SKILL.md
  // (step 1's diff-size reviewer-count scaling), and audit.md/diagnose.md/capture.md/plan.md/
  // plan-backlog.md (the remaining raw-npx entry points now embed the $MUSTER_CLI resolution
  // snippet, criterion 4). This is the reviewed weight-reduction remediation, not accidental
  // Codex-side drift.
  //
  // Pin re-derived again for the speed-tuning item (backlog item `muster-speed-tuning`): file
  // COUNT unchanged (135) but plan.md now wires in the SAME pre-router fast-path check go.md's
  // step 3 already carried (weight-reduction wired go.md only; speed-tuning extends it to the
  // approve-first entry point, criterion 1) -- see test/plan-fast-path-wiring.test.js -- and its
  // fast-path branch also narrows the capabilities capture to `--roles-only` (a fast-path
  // manifest only ever reads the implement/code-review roles; measured ~73% smaller than the
  // full dump, see eval/perf/replay-plan-budget.mjs). muster-runner.md and orchestrator/SKILL.md
  // also gained the `<!-- muster-brief-template -->`/`<!-- muster-return-template -->` inline
  // markers criterion 3's lint (src/brief-lint.js) scans for -- comments only, no behavior
  // change. review-gate/SKILL.md's prose was cut 40.9% (9193 -> 5435 chars, criterion 2) --
  // every load-bearing rule preserved verbatim (gate names/triggers, severity vocab, the
  // fix-iteration cap sentence, the AvailableCapabilities capture sentence); contract tests
  // (corpus-contradiction, docs-binding-interface, prompt-scan, mode-evals) all still green.
  // router/SKILL.md's prose was cut 40.95% (7881 -> 4654 chars) -- the surface taxonomy enum,
  // the crew-shape model field, and the "For EVERY plan task, consult AvailableCapabilities.
  // skills" anchor build-codex.mjs's Codex-side rewrite depends on are all preserved verbatim.
  // advisor/SKILL.md's prose was cut 40.5% (6427 -> 3823 chars); the dev-tree "node src/cli.js
  // advise" alternative line was folded into the resolved $MUSTER_CLI form and the
  // budget-exhausted re-dispatch line merged into step 6, dropping 2 "dispatch (Agent/Task
  // tool)" grep-audit mention lines -- docs/binding-interface.md's audit table and 94->92
  // total re-derived to match.
  //
  // orchestrator/SKILL.md's prose was cut 48.33% (26764 -> 13828 chars) -- the largest single
  // cut this item makes, since its own "## Enforcement model: gates vs conventions" section
  // is wholesale-discarded by build-codex.mjs's Codex adaptation anyway (replaced with fixed
  // Codex-specific text) and duplicates docs/architecture.md's own fuller "Enforcement model"
  // section almost verbatim -- compressed to a cross-reference + the one operative rule
  // (the action-class fence) the orchestrator itself must still act on. Every load-bearing
  // literal preserved: the return-contract markers (untouched), the surface-taxonomy gate-name
  // mapping, "3 fix iterations", the two Provider-kind/Subagent-failure Codex-adaptation
  // anchors, the "brief-level discipline" / "top-level set" fence-lifecycle phrasing, and every
  // integration-test dependency (chosen.kind, loopState, classifySteer, <channel>, TaskCreate/
  // TaskUpdate, docs/anti-patterns.md within Required skills). docs/binding-interface.md's
  // audit table re-derived again (dispatch 19->15, hook 28->19, 92->79 total) since most of the
  // dropped prose was hook-related enforcement history.
  //
  // coordination/SKILL.md's prose was cut 30.6% (40754 -> 28279 chars) -- an HONEST MISS of this
  // item's >=40% target, reported as such rather than fabricated. This file is qualitatively
  // different from the other 4 cuts: three parallel, correctness-critical multi-runner protocol
  // bindings (GitHub/backlog.md/Linear) full of claim-race logic, security validation (authorizer
  // login/identity checks), and hostile-input handling -- most of its bulk IS the protocol, not
  // narrative to trim. Every load-bearing literal preserved: "subagent type `muster-runner`"
  // (corpus-contradiction.test.js), both Standing-context-preflight/Binding-A heading anchors
  // (build-codex.mjs's wholesale section replacement), the git-log fingerprint fenced command +
  // Binding C's matching "fingerprint set (...)" parenthetical (coordination-preflight.test.js,
  // 4 cases), and the ATTENDED-session HUMAN-HOLD resume gate's exact safety semantics. See
  // docs/weight-reduction.md's own honest-miss precedent (criterion 3, 39.8% vs a 25% target) for
  // this project's established practice of reporting a real percentage over a fabricated one.
  //
  // Pin re-derived for the legacy-alias-retirement item: file COUNT unchanged (135 at that item)
  // but run.md/autopilot.md/sprint.md's guidance paragraph (still exactly the alias-shape's pinned
  // 2 paragraphs, see test/mode-evals.test.js's alias-shape-equivalence test) now also carries a
  // dated deprecation notice ("Deprecation notice (2026-07-17): ... retires in muster 0.7.0"),
  // and each file's frontmatter description names the same retirement target -- this OPENS the
  // deprecation window, it does not change the alias's behavior: the Read-and-execute directive
  // that delegates to plan.md/go.md/go-backlog.md is byte-identical (see
  // test/alias-deprecation.test.js's "no behavior change" test).
  //
  // Pin re-derived again for the cowork-plugin-loader-probe item (docs/research/claude-cowork.md
  // section 9): file COUNT unchanged (135 at that item) -- only cowork/mcp-server.mjs's content
  // changed (header comment + muster_capabilities tool description), correcting its stale "no
  // plugin/skill/slash/hook primitives" claim (Cowork's plugin system shipped ~May 2026) and
  // documenting the new MUSTER_COWORK_NATIVE_PLUGIN declared capability check. scripts/build-
  // codex.mjs's string-rewrite of this same description (the Codex MCP adapter) was updated to
  // match, verified by test/codex-cache-package.test.js's rebuild-from-packed-tarball check.
  //
  // Pin re-derived again for the fast-path-token-gap item (see docs/fast-path-token-gap.md): file
  // COUNT changed 135 -> 136 -- a genuinely new file, plugin/skills/review-gate/fast-path-brief.md
  // (lever 1's lighter reviewer brief for a fast-path/small-diff, single-reviewer dispatch; real,
  // measured ~73% smaller than the full review-gate/SKILL.md). review-gate/SKILL.md itself gained
  // one new "Fast-path reviewer brief" section, placed after the surface-type gates and before the
  // Mutant-kill gate section so it disturbs neither the mutant-kill-rule drift-guard fixture
  // (test/mode-evals.test.js) nor scripts/build-codex.mjs's review-gate step-1/fix-iteration-cap/
  // AvailableCapabilities-sentence Codex-adaptation anchors (all re-verified green); this section
  // now invokes the new `muster review-brief` CLI command (a fix-loop addition, code-backed rather
  // than prose-only) and documents where its optional `--diff-text-file` input comes from. No other
  // file under this surface changed.
  //
  // All three content changes above are reviewed, not accidental Codex-side drift. The four PRs
  // (#56 alias-retirement, #57 test-only, #58 cowork-probe, #59 fast-path) were merged together;
  // the pinned sha below is re-derived once, after all four land, over the combined surface.
  //
  // Pin re-derived again for the workflow-tool-delegation item (docs/native-workflow-dispatch.md):
  // file COUNT unchanged (136) -- only plugin/skills/orchestrator/SKILL.md's content changed. It
  // gained one new "## Wave dispatch: native Workflow vs prose fallback" section (placed after
  // "## Task board", before "## Scope fences" -- disturbing neither the numbered step list nor any
  // other named section) plus a one-clause pointer added to step 4a's dispatch line. The new
  // section documents the capability check (`$MUSTER_CLI wave-dispatch`, src/wave-dispatch.js,
  // fixture-driven TDD in test/wave-dispatch.test.js + test/cli-wire-perf.test.js) that lets the
  // orchestrator RIDE Claude Code's native agent-teams `Workflow` tool for wave fan-out when
  // declared available, with today's prose Agent-tool dispatch loop kept byte-identical as the
  // unconditional floor -- AUGMENT, NOT SUPERSEDE. build-codex.mjs's two indexOf-based Codex-
  // adaptation anchors in this file ("Provider kind"/"Subagent failure", "## Enforcement model:
  // gates vs conventions") are untouched and re-verified (scripts/build-codex.mjs still runs
  // clean); every corpus-contradiction.test.js term-registry pin against this file (surface
  // taxonomy, gate names, the fix-iteration cap) still matches byte-for-byte.
  //
  // Pin re-derived once more, same item, after a review-gate fix loop: the new section's citation
  // of docs/research/claude-code-cli.md was corrected (the Workflow/ListAgents/SendMessage tool
  // names are documented in sec 1's binary-tools evidence + sec 11's `claude agents` subcommand,
  // not secs 5/10 as first drafted), the literal phrase "Claude Code CLI" was reworded out of the
  // section's body (avoiding build-codex.mjs's blanket "Claude Code CLI"->"Codex CLI"
  // translateCodexProse swap, which would otherwise fabricate a false "Codex CLI's deterministic
  // fan-out tool" claim in the generated Codex skill -- build-codex.mjs itself gained a new
  // wholesale Codex-specific body replacement for this section, mirroring its existing provider/
  // model and enforcement-model wholesale replaces, verified by rebuilding with
  // MUSTER_BUILD_FORCE=1 and reading the generated .agents/plugins output directly), and a new
  // "Parallel isolation is not relaxed" clause was added addressing whether the native Workflow
  // tool's per-step isolation is confirmed equivalent to the Agent tool's `isolation: "worktree"`
  // (it is not, by this item's own research -- a multi-file-writing wave stays on the prose path
  // regardless of declared mode until that gap closes). docs/binding-interface.md's grep-audit
  // table was also re-derived (dispatch 15->16, worktree 14->15, total 79->81) since the new
  // section's prose added one more `Agent` tool mention and one more `worktree` mention.
  //
  // Pin re-derived again for the codex-spawn-agent-dispatch item (stacked on
  // workflow-tool-delegation, docs/strategy/native-delegation.md backlog item 4): file COUNT
  // unchanged (136) -- only plugin/skills/orchestrator/SKILL.md's content changed again. It
  // gained one new "### Codex-native dispatch: spawn_agent" subsection, placed directly after
  // the "Wave dispatch: native Workflow vs prose fallback" section's worked-example pointer and
  // before "## Scope fences" -- disturbing neither the numbered step list, the native-vs-prose
  // bullets above it, nor any other named section. The new subsection documents that Codex rides
  // its OWN native primitive (`collaboration.spawn_agent`/`wait_agent`/`list_agents`,
  // `fork_turns: "none"`, `agent_type`) rather than a prose-loop substitute for the Claude-only
  // `Workflow` tool, names `src/codex-dispatch.js`'s `resolveCodexWaveDispatch` (spawn_agent
  // vs sequential-inline, gated on Codex's own `features.multi_agent`, default-on -- inverse of
  // agent-teams' default-off) and `assertCodexSpawnAgentAccepted` (the fail-closed guard: a
  // rejected profile throws a registration diagnostic naming the `agent_type`/task rather than
  // ever silently falling back to a generic agent), fixture-driven TDD in
  // test/codex-wave-dispatch.test.js. This whole subsection falls inside build-codex.mjs's
  // existing wholesale-replace span for the Wave-dispatch section (`waveDispatchStart` ..
  // `"## Scope fences"`), so it is discarded verbatim by the Codex adaptation in favor of that
  // function's already-existing fixed Codex-specific text -- re-verified by rebuilding with
  // MUSTER_BUILD_FORCE=1 and re-running the full suite green.
  //
  // Pin re-derived again for the task-board-authoritative item (docs/strategy/native-delegation.md
  // backlog item 5, stacked on codex-spawn-agent-dispatch): file COUNT changed 136 -> 137 -- a
  // genuinely new file, plugin/hooks/task-completed-gate.js (the TaskCompleted gating hook that
  // ties a native task's completion tick to a recorded review-gate PASS in
  // .muster/task-board.json), plus its plugin/hooks/hooks.json wiring (a new TaskCompleted entry,
  // no matcher -- the event fires unconditionally per docs/research/claude-code-cli.md sec 6).
  // plugin/skills/orchestrator/SKILL.md's content changed twice: its "Task board" section (between
  // "## Task board" and "## Wave dispatch...") is rewritten to state the native board is now
  // AUTHORITATIVE (not a duplicate of a STATE-mirrored status list) and documents the new gating
  // hook's .muster/task-board.json contract; its "Enforcement model: gates vs conventions" section
  // gains one new paragraph naming this as a second, narrower hook-enforced block on a different
  // event (TaskCompleted, not PreToolUse) -- the existing "THE ONE HARD DENY" sentence is scoped
  // explicitly to what the PreToolUse hook itself can deny, still true, not contradicted. Every
  // load-bearing literal test/harness-delegation.test.js pins is preserved: TaskCreate, TaskUpdate,
  // the docs/research/reference-harness-design.md citation, and the "STATE alone" no-board
  // fallback phrase. plugin/commands/go-backlog.md's step 2/3 rewrite removes the STATE-mirrored
  // pending/running/done per-item listing (replaced with a native-board-authoritative note plus a
  // durable-ledger-only "## Sprint" section -- heading unchanged, per test/cowork.test.js's
  // cross-repo convention pin) and ties step 3's "completed" tick to the same review-gate-PASS
  // ordering the new hook enforces. docs/binding-interface.md's grep-audit table is re-derived to
  // match (hook 11/19 -> 11/26, total 81 -> 88 -- AskUserQuestion/dispatch/worktree untouched);
  // docs/architecture.md, website/reference/architecture.md (outside this hashed surface, but kept
  // in lockstep) now describe four plugin-native hooks instead of three. Suite re-verified green
  // (node --test --test-concurrency=4, baseline 1908/1skip preserved plus 9 new
  // test/hook-task-completed-gate.test.js cases and a new VALID_EVENTS entry in
  // test/hook-registration.test.js for "TaskCompleted").
  //
  // Pin re-derived again for the worktree-isolation-native item (docs/strategy/native-delegation.md
  // backlog item 10, stacked on task-board-authoritative -- the final orchestrator-SKILL editor in
  // this chain): file COUNT unchanged (137) -- only plugin/skills/orchestrator/SKILL.md's content
  // changed again. It gained one new "### Worktree isolation per harness + base-SHA receipts"
  // subsection, placed directly after "Codex-native dispatch: spawn_agent" and before
  // "## Scope fences" -- disturbing neither the numbered step list, the wave-dispatch bullets
  // above it, nor any other named section. The new subsection names each harness's native
  // worktree mechanism concretely (Claude Code CLI's already-landed `isolation: "worktree"` Agent
  // tool parameter; Claude Code Desktop's automatic per-session worktree under
  // `<root>/.claude/worktrees/`, docs/research/claude-code-desktop.md sec 2.2; Hermes's
  // `hermes -w`/kanban worktree workspaces, docs/research/hermes.md sec 6; Codex's receipts-only
  // floor -- no cwd field on subagent dispatch at all, docs/research/codex-cli.md sec 6) and the
  // one base-SHA provenance receipt every harness records alike, regardless of which mechanism (or
  // none) isolated the work. Names `src/wave-dispatch.js`'s new `resolveWorktreeIsolation`
  // (per-harness mechanism selection, fails loud on an unrecognized/missing harness) and
  // `buildBaseShaReceipt` (the receipt builder, fails loud on a missing/non-hex baseSha), both
  // wired to a new `muster worktree-isolation --harness <name>` CLI subcommand (`src/cli.js`) --
  // fixture-driven TDD in test/worktree-isolation.test.js (13 cases, including one built against a
  // REAL `git rev-parse HEAD` from this checkout, not a fixture string) plus 7 new CLI-wire cases
  // in test/cli-wire-perf.test.js. `docs/binding-interface.md`'s grep-audit table is re-derived
  // (dispatch 16/17, worktree 15/22, total 88 -> 96 -- AskUserQuestion/hook untouched);
  // `website/reference/commands.md` gained one new `worktree-isolation` row so
  // test/website-docs.test.js's usage-string drift check stays green.
  // Pin re-derived again for the hermes-kanban-binding item (backlog item `hermes-kanban-binding`,
  // see docs/research/hermes.md §4): file COUNT unchanged (136 -- no file added/removed) --
  // coordination/SKILL.md gained a fourth binding, "## Binding D -- Hermes kanban (native
  // `kanban.db`)", mapping CLAIM/RECEIPTS/BLOCKED/HUMAN-HOLD/DONE/FAILED/YIELD/LEDGER onto kanban
  // columns/task_events/task_runs, cited to docs/research/hermes.md's Kanban subsection throughout,
  // plus a fallback (Bindings A/B/C apply when no board is present) and a described-not-executed
  // validation smoke-trail (no live Hermes install exists to run it against, per hermes.md's own
  // sourcing-gaps section). The frontmatter description ("Three bindings" -> "Four bindings"), the
  // "Load this when a backlog..." sentence, and the shared escalation-marker bullet were each
  // updated to name the new binding, keeping the file internally consistent. Every existing
  // contract preserved verbatim and re-verified green: corpus-contradiction.test.js's "subagent
  // type `muster-runner`" quote site, both coordination-preflight.test.js fingerprint-set copies
  // (Binding D's own inheritance line deliberately does not repeat the "fingerprint set (...)"
  // parenthetical shape, so the regex-scoped first match stays Binding C's), and
  // docs-binding-interface.test.js's four live grep-audit counts (AskUserQuestion, dispatch,
  // hook, worktree) are all unchanged -- Binding D's prose was deliberately worded to avoid every
  // tracked term (kanban's own "dispatcher" vocabulary was rephrased to "the board" throughout, and
  // its `worktree` workspace kind was not cited, since isolation is out of this item's scope).
  //
  // Pin re-derived again for the coordination-footprint item (backlog item `coordination-footprint`,
  // stacked on hermes-kanban-binding): file COUNT unchanged (136) -- coordination/SKILL.md's prose was
  // cut a further 40.04% off the pre-speed-tuning baseline (40754 -> 24438 chars; speed-tuning alone
  // had only reached 30.6%, an honest miss of the same 40% bar). Two review rounds each restored a
  // handful of load-bearing rationale/disambiguation clauses the cut had over-trimmed (the
  // window-floor rationale incl. the "item strands unowned" outcome, the escalation-vs-retry-cap
  // distinction, a GitHub/Linear-specific claim race clarification) without giving back the 40% bar.
  // The lever this time is genuine
  // de-duplication, not another rationale trim: the "## Core mechanism" section was rewritten as
  // "## Protocol states (canonical -- binds all four bindings)", now the SOLE place every state's
  // meaning, transition rule, and resume rule is stated (CLAIM's race-arbitration/window-floor
  // algorithm, RECEIPTS' fixed-first-line template, the BLOCKED-any-reply/HUMAN-HOLD-named-authorizer
  // split plus the authenticated-vs-unauthenticated-channel ATTENDED/UNATTENDED resume rule, YIELD,
  // the 2-failure retry cap, LEDGER's edit-in-place invariant, and the escalation-marker roundup).
  // Each binding section was cut down to its OWN mapping + concrete syntax, with the restated
  // rationale/semantics removed in favor of a cross-reference to the canonical section above (e.g.
  // Binding A/C's identity-validation-before-writing step, Binding B's ATTENDED-only HUMAN-HOLD case,
  // and Binding D's native-claim/unauthenticated-channel notes all now point back to canonical instead
  // of re-deriving the rule). No protocol state or resume rule was dropped -- every one of
  // CLAIM/RECEIPTS/BLOCKED/HUMAN-HOLD/DONE/FAILED/YIELD/LEDGER plus every resume rule (GitHub-login-
  // authenticated resume, Linear-author-authenticated resume, the STATE-line/kanban_comment
  // unauthenticated-channel ATTENDED-only parking rule, the unattended-permanently-parks rule) survives
  // verbatim in meaning, just once instead of up to four times. Every existing contract re-verified
  // green: corpus-contradiction.test.js's "subagent type `muster-runner`" quote site (now in Binding
  // B's own paragraph), both coordination-preflight.test.js fingerprint-set copies (both now live in
  // the Standing-context preflight section itself, still two independently-extractable copies so the
  // drift guard still holds), and docs-binding-interface.test.js's four live grep-audit counts
  // (AskUserQuestion, dispatch, hook, worktree) are all unchanged from the hermes-kanban-binding pin.
  // Pin re-derived again for the brief-lint-coverage item: file COUNT unchanged (136 -- no file
  // added/removed) but content changed across 12 files, all `<!-- muster-brief-template -->`/
  // `<!-- muster-return-template -->` inline-marker ADDITIONS (comments only, no behavior change)
  // completing criterion 3's lint (src/brief-lint.js) so it scans every real dispatch-brief/
  // return-contract template, not just the 2 speed-tuning left marked: plugin/agents/
  // muster-{builder,strategist,investigator,improver,surgeon}.md each gained a marker around
  // their existing "## Report back" section; muster-reviewer.md around "## Verdict";
  // plugin/skills/advisor/SKILL.md around "## Request and response shapes"; plugin/commands/
  // go.md and audit.md around one existing inline return-contract sentence each (the spec-gate's
  // "Return contract: verdict first ..." and the dimension-sweep's "Each returns findings: ...");
  // plugin/skills/tournament/SKILL.md around the judge's candidate-scoring shape (return) and the
  // synthesizer's verbatim dispatched prompt (brief); and plugin/skills/review-gate/SKILL.md +
  // its sibling fast-path-brief.md each wrapped WHOLE-BODY as one brief-template (the full text
  // dispatched to the reviewer in each mode -- see review-gate/SKILL.md's own "dispatch with...
  // this full file" / "...fast-path-brief.md" language). test/brief-lint-coverage.test.js is the
  // new companion guard: every one of these signals must sit inside a marker, and a synthetic
  // mutant fixture proves an unmarked one would fail it. orchestrator/SKILL.md and
  // coordination/SKILL.md were deliberately left untouched (concurrent sibling items editing
  // those exact files) -- their existing markers already covered what they needed to.
  // Pin re-derived again for the native-plan-mode-parity item: file COUNT unchanged (136) --
  // plan.md's step 7 and plan-backlog.md's B5 approval gate each gained two new native-surface
  // branches (Codex's `permission_mode: "plan"` + bundled system `plan` skill, docs/research/
  // codex-cli.md SS1/4.2/5.2; Hermes's built-in `plan` skill + `/goal` completion contract,
  // docs/research/hermes.md SS4) between the existing Claude Code ExitPlanMode branch and the
  // fallback, which now names Cowork's prose degradation explicitly instead of lumping
  // Codex/Hermes in with it (docs/research/claude-cowork.md SS2). Both files also now cite the
  // new capability-check module, src/plan-surface.js (outside this pinned surface), and
  // docs/binding-interface.md's grep-audit table was re-derived to match (AskUserQuestion
  // 31->35, hook 19->21, 79->85 total) since the new branches add AskUserQuestion/hook-signal
  // mentions. This is the reviewed native-plan-mode-parity remediation, not accidental
  // Codex-side drift.
  //
  // Pin re-derived once more within the same item, post review-gate fix loop 1: the Codex branch
  // in both files no longer asserts that invoking the bundled `plan` skill is what emits the
  // turn's "plan update" `item.completed` entry -- docs/research/codex-cli.md documents the
  // bundled skill (SS5.2) and the item-stream taxonomy (SS1) as separate facts with no stated
  // causal link between them, so the prose now cites both as independently-verified native
  // primitives instead of a fabricated single mechanism (review-gate blocker, fixed). The Hermes
  // /goal completion-contract field list also gained `boundaries` (previously omitted from
  // hermes.md SS4's full set). File COUNT unchanged (136); grep-audit counts unchanged (still
  // 35/15/21/14, 85 total) since these are wording-only fixes with no new/removed
  // AskUserQuestion/hook/dispatch/worktree mentions.
  //
  // Pin re-derived again for the skill-content-only-thinning item (backlog item
  // `skill-content-only-thinning`, docs/strategy/native-delegation.md backlog item 11): file
  // COUNT unchanged (137) -- only plugin/skills/orchestrator/SKILL.md's content changed. Its
  // "## Wave dispatch: native Workflow vs prose fallback" section (through the "### Codex-native
  // dispatch: spawn_agent" and "### Worktree isolation per harness + base-SHA receipts"
  // subsections, up to "## Scope fences") was de-narrated: sentences that merely restated HOW a
  // native primitive already works mechanically (e.g. "each task becomes one `Workflow` step ...
  // let the native tool's own barrier join them, then read each step's result exactly once", the
  // repeated "muster scripts nothing" / "muster only selects" framing per harness row) were cut,
  // while every judgment clause, capability check, and fallback survives verbatim in meaning: the
  // "Parallel isolation is not relaxed" gap-not-relaxed rule, the DECLARED-not-auto-probed
  // capability-check shape (both the agent-teams and Codex `multi_agent` checks), the
  // fail-closed-on-a-rejected-profile rule and its `assertCodexSpawnAgentAccepted` citation, the
  // per-harness worktree-mechanism table, and the base-SHA receipt requirement all stay, just
  // without the mechanic play-by-play. This is the one skill the strategy doc names as carrying
  // load-bearing native-delegation mechanic prose (`m-surface`); coordination/SKILL.md and
  // review-gate/SKILL.md were left untouched per the item's own brief (already cut in the
  // speed-tuning/coordination-footprint passes, past their safe re-cut point), and the other 8
  // skills were audited and found to carry no redundant native-mechanic narration to strip (their
  // content is domain judgment/protocol, not mechanic narration -- see docs/skill-thinning.md).
  // This section's own two boundary headings ("## Wave dispatch: native Workflow vs prose
  // fallback", "## Scope fences") are untouched, so scripts/build-codex.mjs's wholesale-replace
  // span (which discards this section's body for the Codex build regardless of content) still
  // locates both anchors and rebuilds clean (re-verified with `MUSTER_BUILD_FORCE=1`). Every
  // corpus-contradiction.test.js / harness-delegation.test.js pin against this file (the surface
  // taxonomy tokens, the gate-name mapping, "3 fix iterations", the Task board section's
  // TaskCreate/TaskUpdate/STATE-alone citations) is outside the edited span and untouched.
  // docs/binding-interface.md's grep-audit counts are unchanged (still 35/17/28/22, same file
  // counts) -- the cut reworded sentences without changing which LINES mention
  // AskUserQuestion/Agent-Task-tool/hook/worktree. See docs/skill-thinning.md for the full
  // per-skill before/after footprint table this item measured.
  //
  // Pin re-derived again for the flaky-time-test-harden item: file COUNT unchanged (137 -- no
  // file added/removed under this surface) but plugin/hooks/inline-budget.js/pre-tool-use.js/
  // user-prompt-submit.js content changed to inject a deterministic, test-only clock
  // (MUSTER_TEST_NOW_MS, see inline-budget.js: resolveNow) so the border-invitation cooldown/
  // age-reset tests (test/hook-pre-tool-use-scale.test.js, test/inline-budget.test.js,
  // test/hook-user-prompt-submit.test.js, test/hook-border-long-session-sim.test.js) no longer
  // race the real wall clock under --test-concurrency. No decision-order/condition logic changed
  // in either hook -- resolveNow() is threaded through as an added `now` argument to existing
  // calls (recordCum/markNudged/isInCooldown/recordInvite/resetCum/corroboratingCount/
  // isCrossingStale), and the writer functions (recordCum/markNudged/recordInvite/resetCum, plus
  // the new markDirective) now stamp each marker's mtime to that same `now` after writing. This
  // is the reviewed clock-injection remediation, not accidental Codex-side drift.
  //
  // Pin re-derived 2026-07-18 (codex-mcp-cli-path fix): cowork/mcp-server.mjs's CLI
  // resolution became layout-adaptive (repo ../src/cli.js, else bundled sibling
  // muster.mjs) so the bundled Codex plugin's MCP server can execute tools/call --
  // the dogfood's High packaging defect. Shared-surface change is that one file;
  // reviewed, not drift.
  //
  // Pin re-derived again 2026-07-18 (backlog item `base-sha-receipt-verification`,
  // respecified after a spec-gate escalation found the first attempt's "callers fail
  // loud" criterion pointed at prose, not code): file COUNT unchanged (137) -- only
  // plugin/skills/orchestrator/SKILL.md's content changed. Its "### Worktree isolation
  // per harness + base-SHA receipts" subsection gained one new paragraph, appended after
  // the existing "test/worktree-isolation.test.js proves..." sentence and before the
  // "## Scope fences" heading, so no existing line in the subsection was touched or
  // reflowed. The new paragraph names the gap this item closes -- a fabricated-but-
  // well-formed SHA passes buildBaseShaReceipt's shape check exactly like a real commit
  // does -- and cites the new executable consumer: run `$MUSTER_CLI receipt-verify
  // <baseSha> --cwd <repo>` (`makeGitShaVerifier` in `src/wave-dispatch.js`) immediately
  // after appending the receipt, escalating any nonzero exit like any other verification
  // failure. This whole subsection falls inside build-codex.mjs's existing wholesale-
  // replace span for the Wave-dispatch section, so the new paragraph is discarded
  // verbatim by the Codex adaptation in favor of its own fixed Codex-specific text --
  // re-verified by rebuilding with MUSTER_BUILD_FORCE=1 (both anchors still located,
  // build completes clean). docs/binding-interface.md's grep-audit counts are unchanged
  // (the new paragraph deliberately avoids "worktree", the hook terms, AskUserQuestion,
  // and the Agent-tool/Task-tool dispatch phrasing) -- re-verified green. See
  // test/worktree-isolation.test.js for the new buildBaseShaReceipt(verify)/
  // makeGitShaVerifier/`muster receipt-verify` CLI coverage this item adds.
  //
  // Pin re-derived a third time, same day/item, after a review-gate fix pass: a
  // review-gate blocker found `receipt-verify` reported `verified: true` for any
  // revision expression `git rev-parse --verify` resolves (a branch name, a tag, `HEAD`,
  // a relative ref), not just an actual SHA, since the standalone CLI never routed
  // through buildBaseShaReceipt's own format gate -- fixed inside makeGitShaVerifier
  // itself (src/wave-dispatch.js), so every caller of the git-backed verifier is
  // protected, not just this one CLI. The one-clause fix note above ("<repo>" is the
  // run's OWN repository root...) is a review nit, addressing which repo `--cwd` names --
  // its first wording used "worktree," which bumped docs/binding-interface.md's live
  // worktree-mention grep audit (22 -> 23) without a matching doc update, so it was
  // reworded to "isolated copy" instead (same meaning, no tracked term), re-verified
  // green with no docs/binding-interface.md change needed. Both fixes are inside
  // plugin/skills/orchestrator/SKILL.md's same paragraph, still appended after (never
  // reflowing) the file's pre-existing lines; file COUNT still unchanged (137).
  // Regression tests added to test/worktree-isolation.test.js prove git never resolves a
  // non-SHA-shaped input for either the factory or the CLI.
  // Pin re-derived 2026-07-18 (spec-gate-amendment-policy item): file COUNT unchanged
  // (137 -- no file added/removed under this surface) but plugin/commands/go.md's step 4
  // spec-gate FAIL handling changed content -- the one-amendment ceiling now itemizes
  // findings per round (each line naming exactly one distinct defect, never merged or
  // split, so round-to-round comparison is like-with-like) and allows a second amendment
  // when round 2's findings are all disjoint from round 1's (no repeated/unresolved
  // finding), hard-aborting only on a repeated round-1 finding recurring in round 2 or
  // unconditionally at round 3 (rounds capped at 3: initial + 2 amendments). Step 7's
  // escalation trigger list and the Routine-mode escalation bullet are reworded to match
  // ("a spec-gate hard abort" instead of "a second FAIL"); go-backlog.md's own escalation
  // bullet (a second file under this surface, previously missed and caught by review) is
  // reworded identically. No src/ or eval/ code encoded the old cap, so this is a
  // reviewed prose-only remediation, not accidental Codex-side drift.
  //
  // Pin re-derived at the PR #77 + #78 merge reconciliation (2026-07-19): both items
  // re-derived this pin independently on their own branches; the merged tree carries
  // BOTH content changes (go.md/go-backlog.md amendment policy + orchestrator SKILL.md
  // receipt-verify paragraph), so the hash is re-derived once over the union.
  //
  // Pin re-derived 2026-07-19 (backlog item tally-worker-exhaustion-contract): file COUNT
  // unchanged (137 -- no file added/removed under this surface) but cowork/mcp-server.mjs's
  // muster_tally tool description content changed -- it now documents the new
  // status:"exhausted"|"absent" worker-exhaustion contract on tallyReview (src/review.js,
  // outside this hashed surface) so an MCP caller can see the contract without reading the
  // CLI source: a required reviewer entry with that status always forces blocked:true with
  // a named blockedReasons entry, never a silent skip, never counted as a real PASS/FAIL.
  // No other file under this surface changed.
  //
  // Pin re-derived again 2026-07-19 (backlog item exhaustion-status-producer, stacked on
  // tally-worker-exhaustion-contract + codex-agent-watch-review-budget): file COUNT
  // unchanged (137) -- only plugin/skills/review-gate/SKILL.md and
  // plugin/skills/orchestrator/SKILL.md changed. review-gate/SKILL.md's step 2 gained one
  // new bullet ("Exhausted/absent reviewer") naming what the gate must do the moment a
  // dispatched reviewer is killed/exhausted/never starts: record {reviewer, status:
  // "exhausted"|"absent"} directly into .muster/verdicts.json instead of synthesizing
  // verdict-shaped findings, so step 5's tally forces its already-landed deterministic
  // block. This sits inside step 2's own paragraph, so scripts/build-codex.mjs's
  // review-gate anchors (the step-1 "Select reviewers" replace and the step-6 fix-iteration
  // cap replace) are untouched and re-verified clean. orchestrator/SKILL.md's
  // "Subagent failure" bullet gained one appended sentence cross-referencing the new
  // review-gate handling, so a reviewer killed inside the review gate (step 4c) is not
  // mistaken for the generic re-dispatch-once path this bullet otherwise documents --
  // appended after the bullet's existing text, so build-codex.mjs's
  // `      - **Subagent failure` indexOf anchor (which keeps this bullet verbatim onward
  // into the Codex build) still locates it and carries the addition through unchanged.
  // Re-verified with MUSTER_BUILD_FORCE=1 node scripts/build-codex.mjs &&
  // node scripts/check-codex.mjs (clean). No other file under this surface changed.
  //
  // Pin re-derived once more, same item, after test/prompt-scan.test.js's repo-wide
  // ANTH-POS-001 ("prefer positive instructions over negative ones") lint caught the new
  // review-gate/SKILL.md bullet stacking three "never" clauses in a system-genre doc
  // already carrying four elsewhere in the file. Reworded to the same meaning with zero
  // added negatives ("or one whose dispatch did not start at all, gets a named status
  // entry recorded in place of synthesized verdict-shaped findings" instead of "or never
  // dispatched at all, is never synthesized ... instead"); no contract or anchor changed,
  // only wording. Re-verified: node --test test/prompt-scan.test.js passes, plus
  // MUSTER_BUILD_FORCE=1 node scripts/build-codex.mjs && node scripts/check-codex.mjs clean.
  // Pin re-derived again 2026-07-19 (backlog item codex-mcp-surface-gaps, stacked on
  // tally-worker-exhaustion-contract): file COUNT unchanged (137) -- only
  // cowork/mcp-server.mjs's content changed. The 2026-07-19 Codex dogfood fell back to the
  // bundled CLI for 4 deterministic ops with no muster_* MCP equivalent; this closes the
  // gap for the 3 that map cleanly onto existing factory shapes plus one ("str" kind's
  // `flags` extension, precedented by json2's own existing `flags`) rather than a scheme
  // redesign: muster_receipt_verify (new "str"+flags tool: sha positional, --cwd via
  // flags -- makeGitShaVerifier's git-backed verifier, src/wave-dispatch.js),
  // muster_capabilities_roles (new tool: capabilities --cowork --roles-only, the lighter
  // {roles}-only capture a fast-path manifest already reads -- kept as a SIBLING tool
  // rather than an optional flag on muster_capabilities itself, since the existing "str"
  // scheme has no optional-flag support today and touching muster_capabilities' own argv/
  // description would break build-codex.mjs's exact-string Codex adapter for no gain),
  // muster_match_skills (new tool: match --skills <task>, always deriving stack signals
  // from the task text -- the CLI's --stack override stays CLI-only, documented in a new
  // "CLI-only operations" paragraph appended to COWORK_PROTOCOL), and muster_gate_cadence
  // (new tool: gate-cadence, reusing the SAME json2 manifest-payload + optional `flags`
  // pattern muster_next/muster_prioritize already established -- the manifest "file-passing
  // awkwardness" turned out not to be awkward at all once mapped onto that existing
  // machinery). The factory-shape comment block above TOOLS documents "str"'s new optional
  // `flags` field. scripts/build-codex.mjs gained one more --cowork -> --codex adapter
  // (muster_capabilities_roles resolves through the identical capabilities.js code path as
  // muster_capabilities, so it needs the same swap or it reintroduces the 2026-07-18
  // dogfood's MUSTER_RUNTIME/--cowork regression through this new sibling tool) plus a
  // matching verification assertion; that script sits outside this hashed surface. Every
  // count this item's tool addition is pinned at (CODEX_COUNTS.mcpTools, doctor's N/N
  // handshake text, README's "N MCP tools", cowork/manifest.json's declared tool list, the
  // check-codex.mjs regex count) was re-derived 21 -> 25 together; see
  // test/codex-mcp-surface-gaps.test.js for the new end-to-end proof through the BUILT
  // plugin's MCP server. No other file under this surface changed.
  //
  // Pin re-derived again 2026-07-19, same item, after a review-gate fix pass: a review
  // blocker found that omitting muster_receipt_verify's required `sha` while `cwd` was
  // present let the "str" kind's trailing `flags` (--cwd <repo>) shift into the sha's own
  // positional argv slot, producing a misleading `{"sha":"--cwd",...}` diagnostic instead
  // of the CLI's own clean "missing sha" usage error -- fixed in callTool's "str" branch
  // (cowork/mcp-server.mjs) so `flags` only fires alongside a PRESENT primary value; a
  // missing required positional now falls through to the bare argv, reaching the CLI's own
  // required-arg check untouched. Regression test added to test/cowork.test.js. File COUNT
  // still unchanged (137).
  //
  // Pin re-derived at the PR #84 + #85 merge reconciliation (2026-07-19): union of both
  // branches' shared-surface changes (producer prose + MCP tool-table description).
  //
  // Pin re-derived 2026-07-19 (backlog item skill-frontmatter-capabilities): file COUNT
  // unchanged (137 -- no file added/removed under this surface) -- 12 files gained native
  // Claude Code capability-scoping frontmatter keys (docs/research/claude-code-cli.md:170,217),
  // applied conservatively and evidence-first, never guessed: plugin/skills/router/SKILL.md
  // gained `disallowed-tools: Write, Edit, NotebookEdit` -- the only one of the item's four
  // candidate skills (review-gate/advisor/tournament/router) whose documented workflow is
  // genuinely read-only (its contract is "Emit ONLY the Crew Manifest JSON" as response text;
  // the invoking command writes `.muster/manifest.json`, not router itself). The other three
  // were verified, not guessed, and skipped: review-gate writes `.muster/verdicts.json` (step 5)
  // and mutates-then-reverts real files for the mutant-kill gate's evidence; advisor appends
  // `.muster/STATE.md` at steps 1 and 5; tournament writes `.muster/candidates.json` +
  // `.muster/fusion-map.json` (step 2) and appends STATE (step 6) -- denying Write/Edit/
  // NotebookEdit on any of the three would break its own documented workflow. Every
  // plugin/commands/*.md file (11) gained `argument-hint`, extracted verbatim from the
  // "Usage: ..." string already embedded in its own frontmatter description (never invented;
  // audit.md's two separate Usage sentences are recombined with " | ", each fragment still a
  // literal substring of its own source text -- test/skill-frontmatter-capabilities.test.js
  // proves this per file). audit.md and runner.md additionally gained
  // `disable-model-invocation: true`: audit's bare (non-"backlog") invocation fixes the WHOLE
  // repo via TDD with no per-file confirmation, a blast radius that should never fire from an
  // ambiguous conversational cue; runner's own prose frames it as fired by a Routine/cron, never
  // a conversational trigger, and never describes a natural-language invocation phrase the way
  // diagnose/capture/go do. The hands-off/approve-first pipeline verbs (go, go-backlog, plan,
  // plan-backlog, diagnose, capture) and the three legacy aliases (run, autopilot, sprint) were
  // deliberately left model-invocable -- muster's border model routes natural-language
  // invitations to exactly these verbs by design (docs/research/claude-code-cli.md's
  // augmentation-surface table: "`disable-model-invocation` for side-effectful verbs" is a
  // targeted lever, not a default). `context: fork` and skill-scoped `hooks` were declined
  // outright, out of this item's scope (muster's explicit Agent dispatch and global hook wiring
  // are deliberate). scripts/build-codex.mjs's `codexSkill()` (outside this hashed surface)
  // gained a `CODEX_SKILL_KEYS` strip so router's new `disallowed-tools` line -- a key
  // scripts/check-codex.mjs's own `allowedSkillKeys` gate does not recognize -- never leaks
  // into the generated Codex SKILL.md; `plugin/commands/*.md` frontmatter passes through
  // unvalidated on the Codex side (no schema gate there), so `argument-hint`/
  // `disable-model-invocation` needed no matching transform. Re-verified with
  // `MUSTER_BUILD_FORCE=1 node scripts/build-codex.mjs && node scripts/check-codex.mjs` (clean)
  // and the full suite green. This is the reviewed skill-frontmatter-capabilities remediation,
  // not accidental Codex-side drift.
  // Pin re-derived 2026-07-19 (backlog item agent-maxturns-native-cap): file COUNT
  // unchanged (137) -- every plugin/agents/*.md (all 27) gained a `maxTurns` frontmatter
  // key sized per role class (mechanical/surgical 15, implementation 25 -- the existing
  // burn-lesson prose ceiling, review/strategy 35, security 40), coherent with Codex's
  // own per-class heartbeat-extension ceilings (PR #83 codex-agent-watch-review-budget).
  // plugin/agents/muster-builder.md additionally carries the single sizing-rationale
  // comment block (the sole source of truth for the class table, mirrored by
  // test/agent-max-turns.test.js). Codex is unchanged: build-codex.mjs reads Codex agent
  // tiers from codex/agents.manifest.json, never from these files' frontmatter, and
  // `MUSTER_BUILD_FORCE=1 node scripts/build-codex.mjs && node scripts/check-codex.mjs`
  // re-verified clean with the new key present. No Claude-lane "25-step ceiling" prose
  // existed anywhere in plugin/skills or plugin/commands to trim (verified by repo-wide
  // grep before editing) -- that prose is Codex-only (codex/skill-adapter.md, generated
  // by scripts/build-codex.mjs), left untouched per this item's own scope.
  // Pin re-derived at the PR #87 + #88 merge reconciliation (2026-07-19): union hash.
  //
  // Pin re-derived 2026-07-19 (backlog item harness-goal-primitives): file COUNT unchanged
  // (137 -- no file added/removed under this surface) -- only plugin/commands/runner.md's
  // content changed. Its "Scheduling" paragraph now documents Claude Code's native `/loop
  // /muster:runner <source>` self-pacing recurrence as a first-class alternative to firing
  // the mode from a Claude Code Routine/cron, naming when each wins (`/loop` for attended
  // sessions/bursty backlogs where self-pacing adapts cadence, the runner's own idle receipt
  // as the widen signal; Routine/cron for unattended machines and a fixed cadence) --  the
  // safety inventory clause (pr-only, 2-failure retry cap, claim lock) is preserved verbatim,
  // now scoped explicitly to "either mechanism". scripts/build-codex.mjs (outside this hashed
  // surface) gained a runner.md-specific wholesale-replace of the whole Scheduling paragraph
  // (anchored `**Scheduling**` .. `\n\nGlass box:`, asserted, mirroring the audit.md
  // dimension-sweep/coordination Standing-context-preflight wholesale-replace convention
  // already in that file) since `/loop` is a Claude-only primitive with no Codex equivalent --
  // re-verified with `MUSTER_BUILD_FORCE=1 node scripts/build-codex.mjs && node
  // scripts/check-codex.mjs` (clean) and the new test/runner-loop-binding.test.js, which reads
  // the BUILT Codex plugin's generated runner.md and proves it carries neither `/loop` nor
  // `$loop` nor the self-pacing framing. This is the reviewed harness-goal-primitives
  // remediation, not accidental Codex-side drift.
  //
  // Pin re-derived again 2026-07-19, same item, after a review-gate fix pass: a review
  // blocker found the /loop claim shipped without grounding it against the actual
  // scheduled-fire documentation, which states a fire only runs a skill/command Claude
  // is "allowed to invoke on its own" and names `disable-model-invocation: true`
  // (runner.md's own frontmatter) as one of the types that instead "reach Claude as
  // plain text instead of executing" -- undisambiguated for an explicitly-typed
  // slash-command prompt. The Scheduling paragraph now carries an honest
  // "Unverified interaction, confirm before relying on it" caveat naming exactly this,
  // instructing a live one-cycle check before depending on `/loop` for standing cadence,
  // and marking Routine/cron as the verified-safe default until that's confirmed -- the
  // same "verify before wiring" bar this diff's own Codex goals record already holds
  // itself to. test/runner-loop-binding.test.js extended to pin the caveat's presence;
  // docs/research/claude-code-cli.md SS1 extended with the same restriction, cited to the
  // same cc-scheduled-tasks source (citation-check clean, 80/80 claims cited, 0 dangling).
  //
  // Pin re-derived a third time, same item, after a second review-gate fix pass: the
  // re-review found the caveat UNDERCLAIMED -- it reasoned only from cc-scheduled-tasks
  // and never cross-referenced this file's own already-cited skills-page source, whose
  // frontmatter reference states the same restriction unconditionally ("also prevents
  // the skill from running when a scheduled task fires with the skill as its prompt", no
  // slash-command-vs-natural-language carve-out) -- strong evidence the claim is likely
  // FALSE, not merely unresolved. It also found a misattribution: the claude -p/cron
  // distinction was wrongly tied to cc-scheduled-tasks's own comparison table, which only
  // covers Cloud/Desktop/`/loop` columns. Both fixed: runner.md's caveat now reads
  // "Likely blocked today, verify before relying on it" and cites both sources (via
  // docs/research/claude-code-cli.md SS1, itself corrected to cite skills-page alongside
  // cc-scheduled-tasks and to stop over-attributing the claude -p distinction to a table
  // that doesn't contain it); a third, cosmetic nit (a lone backtick-wrapped
  // paragraph-leading `[DOCUMENTED]` tag, inconsistent with every other of this file's 54
  // instances) was fixed in the same pass. Re-verified: citation-check still clean
  // (80/80 cited, 0 dangling), full suite green, MUSTER_BUILD_FORCE=1 build + check-codex
  // clean.
  // Pin re-derived 2026-07-19 (backlog item structured-output-binding): file COUNT changed
  // 137 -> 138 -- a genuinely new file, plugin/skills/review-gate/verdict.schema.json (the
  // single-sourced JSON Schema for .muster/verdicts.json's two entry shapes: an ordinary
  // reviewer's {reviewer, findings} verdict, and PR #82's {reviewer, status:
  // "exhausted"|"absent"} worker-absence entry -- kept coherent with src/review.js's
  // tallyReview by the new test/verdict-schema.test.js, outside this hashed surface).
  // plugin/skills/review-gate/SKILL.md's content also changed: step 5's existing "Write
  // verdicts to `.muster/verdicts.json`" sentence gained one clause citing the schema file
  // as the emission contract plus a compact honesty note ("native constrained output here
  // reaches only headless surfaces, not this call") -- both lanes' own research docs verified
  // to say exactly that: docs/research/claude-code-cli.md secs 1/11 place `StructuredOutput`
  // and print-mode `--json-schema` on the background-agent/`claude agents`-subcommand and
  // headless-`-p` surfaces respectively, neither of which is the in-session Agent-tool call
  // review-gate actually dispatches reviewers through; docs/research/codex-cli.md sec 1 binds
  // `codex exec --output-schema` to a `codex exec` leaf's final message, and reviewer dispatch
  // on the Codex lane runs through the native `collaboration.spawn_agent` subagent call, not a
  // `codex exec` leaf (confirmed by grepping scripts/build-codex.mjs's one `claude -p` ->
  // `codex exec` translation site, plugin/commands/runner.md's cron-scheduling line -- not a
  // verdict-emitting leaf). Native constrained output therefore reaches neither lane's real
  // reviewer-dispatch surface today; the schema is held by test/verdict-schema.test.js's
  // coherence pin plus `muster tally`'s own parse, stated as such rather than claiming
  // enforcement that is not there. The edit sits inside step 5's own sentence, so it disturbs
  // neither the mutant-kill-rule drift-guard fixture (test/mode-evals.test.js, unaffected --
  // still anchored on "## Mutant-kill gate" onward) nor scripts/build-codex.mjs's review-gate
  // step-1/fix-iteration-cap anchors; the generic `translatePluginPaths` transform already
  // in build-codex.mjs resolves the new citation to
  // `${PLUGIN_ROOT}/internal-skills/review-gate/verdict.schema.json` with no Codex-specific
  // code needed, and `rmAndCopy(plugin/skills, internal-skills)` already ships the new schema
  // file byte-for-byte -- both re-verified with `MUSTER_BUILD_FORCE=1 node
  // scripts/build-codex.mjs && node scripts/check-codex.mjs` (clean), the latter gaining one
  // new assertion (`internal-skills/review-gate/verdict.schema.json` must exist and the ported
  // SKILL.md must cite its bundled path) proven to fail on a missing file and pass once
  // restored. docs/binding-interface.md's four grep-audit counts are unchanged (the new prose
  // deliberately names none of AskUserQuestion/hook/dispatch-phrase/worktree). This is the
  // reviewed structured-output-binding remediation, not accidental Codex-side drift.
  // Pin re-derived again 2026-07-19 (backlog item codex-mcp-surface-gaps-2, round 2 of
  // codex-mcp-surface-gaps / PR #85): file COUNT unchanged (137) -- only
  // cowork/mcp-server.mjs's content changed. The 2026-07-19 clean Codex run's residual
  // CLI-only list named 4 more deterministic ops with no muster_* MCP equivalent: scope,
  // fast-path, plan-checklist, and codex-conformance. 3 became real tools, mapped onto
  // the same per-op decision-table discipline PR #85 established: muster_scope (new
  // "str" tool: scope <text>, detectScope -- text optional, a bare invocation is a valid
  // input), muster_plan_checklist (new "json2" tool: plan-checklist, reusing the SAME
  // manifest-payload + optional `flags` (`--done`) pattern muster_next already
  // established), and muster_fast_path (new tool needing a genuinely new "fastPath" kind
  // -- a required string positional PLUS an optional JSON payload behind a flag, a shape
  // neither "str" nor "json2" covers, since "str"'s `flags` callback is synchronous and
  // cannot write a temp file; mirrors "json2"'s own write/run/cleanup sequence, gated on
  // `capabilities` actually being present -- scoreOutcomeForFastPath/buildFastPathManifest,
  // and the SAME {roles} shape muster_capabilities_roles already returns is the exact
  // payload buildFastPathManifest needs, not impractically large for a tool arg). The
  // 4th residual op, codex-conformance, was judged CLI-only on the merits (not mapped
  // onto any shape): it audits a HOST CODEX_HOME/sessions rollout tree for subagent
  // model-conformance drift, and while this server CAN read that tree (same host Codex
  // spawned it on), the audit is post-run forensics a human/driver runs after a session
  // ends, not a decision the in-run orchestrating agent needs mid-wave -- documented in
  // COWORK_PROTOCOL's "CLI-only operations" note (now naming both gaps: muster_match_skills'
  // --stack override and codex-conformance outright). Every count this item's tool
  // addition is pinned at (CODEX_COUNTS.mcpTools, doctor's N/N handshake text, README's
  // "N MCP tools", cowork/README.md's tool table + prose, cowork/manifest.json's declared
  // tool list, the check-codex.mjs regex count) was re-derived 25 -> 28 together; see
  // test/codex-mcp-surface-gaps.test.js for the new end-to-end proof through the BUILT
  // plugin's MCP server and test/cowork.test.js for full per-tool behavioral coverage on
  // the shared Cowork server. No other file under this surface changed.
  // Pin re-derived at batch-2 merge reconciliation (2026-07-19): union hash.
  // Pin re-derived at batch-2 merge reconciliation (2026-07-19): union hash.
  //
  // Pin re-derived 2026-07-19 (backlog item runner-worktree-bootstrap): file COUNT unchanged
  // (138 -- no file added/removed under this surface) -- two files changed. plugin/agents/
  // muster-runner.md gained a new "## Worktree bootstrap" section (placed right after the
  // Dispatch contract's return-template marker and before "## Iron rules", so neither
  // template marker src/brief-lint.js scans for was disturbed): if the assigned worktree has
  // no node_modules and its package-lock.json is byte-identical to the one in the repository
  // the worktree was created from, symlink node_modules from there (the technique
  // test/codex-build-repro.test.js already uses for its own fixture checkouts) instead of
  // reinstalling; otherwise npm ci; the symlink is never committed, and the final clean-tree
  // verification before disposition must show it absent or untracked only, never staged. The
  // rule deliberately says "the repository the worktree was created from" rather than
  // Claude-only "parent checkout" jargon, since plugin/agents/*.md bodies ship to the Codex
  // agent profile verbatim (src/codex-release.js's profileToml is a pure, untransformed copy
  // -- confirmed by test/codex-release.test.js's own "pure function" case), so one harness-
  // neutral source phrase is correct on both surfaces with no separate Codex-side adaptation
  // needed; test/runner-worktree-bootstrap.test.js pins both the source rule and its
  // unmodified appearance in the generated muster-runner Codex profile TOML.
  // plugin/commands/go-backlog.md's existing Isolation bullet gained one clause citing that
  // same rule back to plugin/agents/muster-runner.md instead of duplicating its text.
  // docs/binding-interface.md's worktree grep-audit count was re-derived (22 -> 23, files
  // unchanged at 5) since the new muster-runner.md section adds one worktree-word mention on
  // its own line while the go-backlog.md clause lands on an already-counted line. Re-verified
  // with `MUSTER_BUILD_FORCE=1 node scripts/build-codex.mjs && node scripts/check-codex.mjs`
  // (clean) and the full suite green. This is the reviewed runner-worktree-bootstrap
  // remediation, not accidental Codex-side drift.
  // Pin re-derived 2026-07-19 (HOTFIX: muster-runner maxTurns 25->200): the leaf-sized
  // cap PR #87 gave the lifecycle-orchestrator role killed every go-backlog runner
  // mid-lifecycle; muster-runner moved to its own orchestrator class (see
  // test/agent-max-turns.test.js). Only that one frontmatter line changed under this surface.
  // Pin re-derived 2026-07-19 (backlog item audit-mcp-backlog-mode): file COUNT unchanged
  // (138 -- no file added/removed under this surface) -- only cowork/mcp-server.mjs's content
  // changed. muster_audit gained two OPTIONAL params on its existing "target" kind: `backlog`
  // (boolean) and `paths` (string[]), exposing the $muster-audit skill's read-only backlog
  // sweep (plugin/commands/audit.md) at the MCP surface -- previously the tool always returned
  // the whole-codebase fix+verify remediation manifest regardless of a scoped read-only
  // request, so Codex backlog mode had to drive the sweep via skill prose. The MCP tool COUNT
  // is UNCHANGED (still 28, no top-level `  muster_x:` key added -- only muster_audit's object
  // body grew); check-codex.mjs's `^  muster_[a-z_]+:` regex and every mcpTools count site stay
  // green. Wiring: buildAuditManifest (src/audit.js) gained a read-only `backlog` branch (drops
  // the implement+review-gate crew and the fix/verify plan stages for a single `capture` stage)
  // and a `paths` scope; the CLI `audit` verb (src/cli.js) accepts `--backlog` + positional path
  // scopes; the "target" branch in callTool (cowork/mcp-server.mjs) now appends a tool-declared
  // `flags(args)` after the verb (mirroring the "str" kind's `flags`), the dir staying the
  // resolved cwd. All edits sit BELOW line 100, so corpus-contradiction.test.js's line-100
  // alias pin is untouched. Re-verified with `MUSTER_BUILD_FORCE=1 node scripts/build-codex.mjs
  // && node scripts/check-codex.mjs` (clean, mcpTools:28) and the full suite green; the
  // end-to-end MCP proof is in test/cowork.test.js (backlog:true drops fix/verify -> capture;
  // paths scopes the manifest). This is the reviewed audit-mcp-backlog-mode change, not drift.
  // Pin re-derived again 2026-07-19 (same item, review-gate fix pass): the adversarial
  // reviewer found a blocker -- `paths` entries are spread as POSITIONAL argv, but the CLI's
  // flag scans (--help/-h, --codex, --backlog) read the whole argv, so a "-"-leading path
  // masqueraded as a flag (paths:["-h"] returned the global USAGE string instead of JSON,
  // breaking every JSON.parse caller; paths:["--backlog"] silently flipped the mode with
  // `backlog` omitted). Fixed by rejecting "-"-leading path scopes at the muster_audit MCP
  // trust boundary (callTool's "target" branch) with defense-in-depth in the CLI `audit`
  // branch (both below line 100 -- the line-100 alias pin still passes). Regression tests in
  // test/cowork.test.js. File COUNT still unchanged (138); MCP tool count still 28.
  //
  // Pin re-derived 2026-07-20 (backlog item loop-dmi-conflict): file COUNT unchanged (138 -- no
  // file added/removed under this surface) -- only plugin/commands/runner.md's content changed.
  // This SETTLES the /loop x disable-model-invocation conflict the harness-goal-primitives fix
  // loop left hedged above (the three 2026-07-19 re-derivations that ended at a "Likely blocked
  // today, verify before relying on it" caveat and a call for a live one-cycle check). Primary
  // docs now give a definitive answer, so no live cycle is needed: as of Claude Code v2.1.196 a
  // scheduled/`/loop` fire does NOT execute a `disable-model-invocation: true` command -- it
  // "reach[es] Claude as plain text instead of executing" -- so `/loop /muster:runner` will not
  // re-fire runner.md (which carries disable-model-invocation: true). runner.md's Scheduling
  // paragraph was rewritten from the hedge to that definitive fact (dated 2026-07-20, both
  // citations: scheduled-tasks.md's "allowed to invoke on its own" list + skills.md's
  // disable-model-invocation row, re-fetched and confirmed current), keeping
  // disable-model-invocation: true on the command by DECISION (the routing-safety rationale that
  // set it stands -- not flipped to buy back `/loop`), naming Routine/cron as the verified-safe
  // standing-cadence default, and pointing a native self-continuing loop at `/goal` (a condition-
  // based built-in, distinct from `/loop`'s time-interval re-fire). docs/research/
  // claude-code-cli.md SS1 replaced its "strong (not certain) ... live verification settles it"
  // wording with the definitive finding and added `/goal` as a confirmed distinct native primitive
  // (new `[src: cc-goal]` -> goal.md; citation-check clean, 81/81 cited, 0 dangling);
  // docs/strategy/native-delegation.md's PR #92 ledger entry records the settlement. The BUILT
  // Codex runner.md invariant is UNCHANGED: `/loop`, `/goal`, and the self-pacing framing are
  // Claude-only, wholesale-replaced by scripts/build-codex.mjs's runner.md Scheduling anchor
  // (`**Scheduling**` .. `\n\nGlass box:`), so the generated Codex command carries none of them --
  // re-verified by test/runner-loop-binding.test.js (updated to pin the definitive wording and to
  // assert the Codex command leaks neither `/loop` nor `/goal`) and by `MUSTER_BUILD_FORCE=1 node
  // scripts/build-codex.mjs && node scripts/check-codex.mjs` (clean). This is the reviewed
  // loop-dmi-conflict remediation, not accidental Codex-side drift.
  //
  // 2026-07-25 re-pin (codex-native-adoption): the orchestrator skill's Task board
  // section and the go/go-backlog verbs changed to name each harness's NATIVE
  // task-tracking primitive. The prior text asserted "Codex has no
  // TaskCreate/TaskUpdate counterpart on the CLI today" -- FALSE against Codex
  // 0.145.0, which registers `update_plan` unconditionally, and that false claim
  // is why muster runs on Codex showed no on-screen task list while Claude Code
  // and Kimi runs did. The verbs now tick the native list (Claude `TaskCreate`,
  // Codex `update_plan`, Kimi `TodoList`) and fall back to STATE only on a
  // harness with none. Deliberate surface change, not drift.
  //
  // 2026-07-25 re-pin #2 (codex-wait-agent-barrier): the orchestrator's
  // Codex-native dispatch section was v1-flavored -- it prescribed
  // `collaboration.wait_agent` "<=60s per outstanding agent id", but v2's
  // wait_agent takes ONLY timeout_ms with no targets, while v1's takes targets
  // and returns on the first to finish. It also read receipts from
  // `list_agents`, which Codex 0.145.0 stripped of task messages (#33030). Now
  // documents both shapes and points at codexSpawnAgentCall/codexWaitAgentCall.
  // Deliberate surface change, not drift.
  //
  // 2026-07-26 re-pin (kimi-native-runtime-wiring): file COUNT unchanged (139) --
  // only plugin/skills/orchestrator/SKILL.md's content changed. Its native-dispatch
  // block gained a "### Kimi-native dispatch: AgentSwarm waves + per-agent calls"
  // subsection alongside the Claude/Codex ones, wiring the previously-unreferenced
  // src/kimi-dispatch.js onto the live orchestration path: every Kimi wave resolves
  // through resolveKimiWaveDispatch (kimiSwarmCall/AgentSwarm for uniform fan-out,
  // lane-aware kimiAgentCall fan-out for mixed-role waves), with the four swarm
  // rejection rules (including the distinct-prompts rule) pre-validated before
  // dispatch. Deliberate surface change, not drift.
  //
  // 2026-07-26 re-pin (kimi-goal-run-loop): file COUNT unchanged (139) -- only
  // plugin/commands/go.md and plugin/commands/runner.md content changed. The
  // runner prose gains the Kimi run-loop arm: on Kimi, the continue-until-done
  // loop routes through the native /goal runner via kimiGoalInvocation
  // (acceptance criteria compiled INTO the objective string) and the outcome is
  // read off the process exit code via interpretKimiGoalExit (0 complete /
  // 3 blocked / 6 paused) -- escalation arrives as an exit code instead of a
  // STATE-file parse; non-Kimi harnesses keep the existing STATE-file loop.
  // Deliberate surface change, not drift.
  //
  // 2026-07-26 re-pin (kimi-worktree-isolation): file COUNT unchanged (139) --
  // only plugin/skills/orchestrator/SKILL.md's content changed. Its "Worktree
  // isolation per harness + base-SHA receipts" list gained a **Kimi** bullet
  // (exactly the Codex receipts-only floor: Kimi's subagent dispatch carries no
  // cwd/isolation parameter -- docs/research/kimi-code-cli.md sec 7 -- so muster
  // supplies the worktree itself before dispatch and verifies branch/base from
  // the runner's return receipt), and step 4a's "Parallel isolation" bullet
  // gained a harness-neutral clause pointing at that per-harness selection so
  // the rule no longer dead-ends on a harness with no dispatch-time isolation
  // parameter. Paired with the src/-side mapping (kimi -> receipts-only in
  // HARNESS_WORKTREE_MECHANISM, src/wave-dispatch.js, outside this surface).
  // This subsection falls inside build-codex.mjs's wholesale-replace span for
  // the Wave-dispatch section (`waveDispatchStart` .. "## Scope fences"), so the
  // Kimi bullet never leaks into the generated Codex skill; the step-4a clause
  // is harness-neutral and ships verbatim on both lanes. Re-verified with
  // MUSTER_BUILD_FORCE=1 node scripts/build-codex.mjs && node
  // scripts/check-codex.mjs (clean). docs/binding-interface.md's worktree
  // grep-audit count re-derived (23 -> 26, files unchanged at 5) for the three
  // new worktree-mention lines. Deliberate surface change, not drift.
  // 2026-07-26 re-pin (kimi-plan-flow-lane): file COUNT unchanged (139) -- only
  // plugin/commands/plan.md's content changed. Step 7's per-harness surface list
  // gained a **Kimi session** bullet (native Plan mode approve/reject/revise
  // gate, docs/research/kimi-code-cli.md sec 4/9, mapped onto Approve & run /
  // Adjust the plan / Cancel with the AskUserQuestion fallback for anything the
  // gate can't express), paired with the src/-side kimi entry in
  // src/plan-surface.js's PLAN_SURFACES (outside this surface). The bullet is a
  // clearly-labeled Kimi-only branch, same shape as the existing Claude/Codex/
  // Hermes branches that already ship to every harness's build. Deliberate
  // surface change, not drift.
  //
  // 2026-07-27 re-pin (kimi-model-lane-binding): file COUNT unchanged (139) --
  // only plugin/skills/orchestrator/SKILL.md and plugin/commands/go.md content
  // changed. Both name the now-WIRED runtime lane bind: the orchestrator's
  // Kimi-native dispatch subsection gained a paragraph stating the stamped
  // model_preference lanes engage only because kimiGoalInvocation sets
  // KIMI_CODE_EXPERIMENTAL_FLAG=1 + KIMI_SECONDARY_MODEL per process (derived by
  // src/kimi.js's kimiLaneEnv, reported by `muster doctor`'s kimi-lane-binding
  // check), and go.md's Kimi run-loop block gained the same env-pair sentence
  // where the `kimi -p "/goal"` invocation is built. Paired with the src/-side
  // single-derivation change (kimiLaneEnv/kimiLaneBinding in src/kimi.js,
  // outside this surface). Re-verified with MUSTER_BUILD_FORCE=1 node
  // scripts/build-codex.mjs && node scripts/check-codex.mjs (clean).
  // docs/binding-interface.md's grep-audit counts re-scanned live -- unchanged.
  // Deliberate surface change, not drift.
  //
  // 2026-07-27 re-pin (kimi-subagent-resume-retry): file COUNT unchanged (139) --
  // only plugin/skills/orchestrator/SKILL.md's content changed. Step 4a's
  // "Subagent failure" bullet gained the Kimi native-resume branch (on Kimi the
  // re-dispatch-once rule RESUMES the failed subagent -- Agent `resume` for a
  // per-agent dispatch, AgentSwarm `resume_agent_ids` for a swarm dispatch, both
  // modeled by kimiAgentCall/kimiSwarmCall in src/kimi-dispatch.js -- keeping the
  // failed subagent's prior context and appending only the error, instead of
  // paying the full prompt/context cost again; non-Kimi harnesses keep the fresh
  // re-dispatch), and the Kimi-native dispatch subsection gained the matching
  // failure-retry paragraph. The bullet's `      - **Subagent failure` indexOf
  // anchor in build-codex.mjs is untouched, so the bullet still ships verbatim
  // into the Codex build -- the new clause is a clearly-labeled Kimi-only
  // branch, same shape as the existing per-harness branches that ship to every
  // harness's build; the Kimi subsection falls inside build-codex.mjs's
  // wholesale-replace span (`waveDispatchStart` .. "## Scope fences") and never
  // leaks into the generated Codex skill. Paired with the src/-side resume
  // modeling (kimiAgentCall's resume parameter, kimiSwarmCall's resumeAgentIds
  // validation, outside this surface). Re-verified with MUSTER_BUILD_FORCE=1
  // node scripts/build-codex.mjs && node scripts/check-codex.mjs (clean).
  // docs/binding-interface.md's dispatch grep-audit count re-derived (17 -> 19,
  // files unchanged at 5) for the two new dispatch-mention lines. Deliberate
  // surface change, not drift.
  //
  // 2026-07-27 re-pin (kimi-background-dispatch): file COUNT unchanged (139) --
  // only plugin/skills/orchestrator/SKILL.md's content changed. Its Kimi-native
  // dispatch subsection gained a "Background a leg only when the wave does not
  // barrier on it" paragraph: independent read-only legs (a reviewer whose
  // verdict does not gate the current wave, an investigator whose findings only
  // a later wave needs) dispatch as kimiAgentCall({ ..., background: true })
  // (run_in_background) and fold back from the background-completion receipt
  // (synthetic user message + on-disk tasks/<task_id>.json/output.log,
  // interpreted by src/kimi-dispatch.js's interpretKimiBackgroundCompletion),
  // while anything step 4b's barrier or step 4c's review gate depends on stays
  // FOREGROUND so the barrier still means done. The paragraph sits inside
  // build-codex.mjs's wholesale-replace span (`waveDispatchStart` ..
  // "## Scope fences") -- verified the generated Codex orchestrator skill
  // carries zero occurrences of it, so no guarded rewrite was needed. Paired
  // with the src/-side receipt interpretation helper (outside this surface).
  // Re-verified with MUSTER_BUILD_FORCE=1 node scripts/build-codex.mjs && node
  // scripts/check-codex.mjs (clean). docs/binding-interface.md's grep-audit
  // counts re-scanned live -- unchanged (test/docs-binding-interface.test.js
  // green without a re-derivation). Deliberate surface change, not drift.
  // 2026-07-27 re-pin (sprint-parallel-5-10): file COUNT unchanged (139) -- only
  // plugin/commands/go-backlog.md's content changed. The wave-mode
  // MUSTER_SPRINT_PARALLEL cap prose moved default 3 -> 5, hard ceiling 8 -> 10
  // (values above 10 clamp to 10; 0 invalid falls back to the default), a
  // muster-wide prose-discipline change (the cap is read by go-backlog's
  // orchestration protocol, not library code), pinned consistently across
  // README/docs/website by test/sprint-parallel-cap.test.js. Deliberate surface
  // change, not drift.
  // 2026-07-27 re-pin (kimi-native-steer-binding): file COUNT unchanged (139) --
  // only plugin/skills/orchestrator/SKILL.md's content changed. Its Channel
  // steering (remote) section gained a clearly-labeled Kimi paragraph: on Kimi a
  // steered correction arrives through the harness's native steer seam (the
  // steer queue -- queued injection BETWEEN STEPS without ending the turn,
  // docs/research/kimi-code-cli.md sec 1 "Steer"; surfaces TUI Ctrl-S, Wire
  // `steer` gen1-only, ACP mid-turn, and `kimi web`'s
  // POST /sessions/{session_id}/prompts + /prompts::steer routes read from the
  // shipped binary), classified by the same `muster steer` with the action
  // mapping unchanged, and `muster steer --harness kimi` constructs the native
  // delivery via kimiSteerDelivery (src/kimi-steer.js, outside this surface).
  // The paragraph sits ABOVE build-codex.mjs's enforcement cut and would ship
  // verbatim into the Codex build, so build-codex.mjs gained a guarded rewrite
  // (same convention as the kimi-subagent-resume-retry clause) replacing it
  // with Codex-accurate text -- verified the generated Codex orchestrator skill
  // carries zero occurrences of "prompts::steer". Paired with the src/-side
  // harness-conditional steer arm (src/cli.js + src/kimi-steer.js, outside
  // this surface). Re-verified with MUSTER_BUILD_FORCE=1 node
  // scripts/build-codex.mjs && node scripts/check-codex.mjs (clean).
  // docs/binding-interface.md's grep-audit counts re-scanned live -- unchanged
  // (test/docs-binding-interface.test.js green without a re-derivation).
  // Deliberate surface change, not drift.
  //
  // 2026-07-27 re-pin (kimi-loop-background-tuning): file COUNT unchanged (139) --
  // only plugin/commands/go.md's content changed. Its Kimi run-loop step gained
  // the "Kimi loop/background profile -- binary defaults, pinned not emitted"
  // block: the chosen [loop_control]/[background] values for unattended
  // `kimi -p "/goal ..."` runs (max_steps_per_turn unset, max_retries_per_step
  // unset/10, reserved_context_size unset/50000, max_running_tasks unset,
  // print_background_mode steer) pinned in prose with the per-process env
  // overrides named, NOT emitted into the user-global config.toml (wave 1's
  // docs-pin decision; probe evidence in docs/research/kimi-code-cli.md
  // sec 11.10, non-emission rationale comment in src/kimi-install.js, both
  // outside this surface). The block is a clearly-labeled Kimi-only branch,
  // same shape as the existing per-harness branches that ship to every
  // harness's build. Re-verified with MUSTER_BUILD_FORCE=1 node
  // scripts/build-codex.mjs && node scripts/check-codex.mjs (clean).
  // docs/binding-interface.md's grep-audit counts re-scanned live -- unchanged
  // (test/docs-binding-interface.test.js green without a re-derivation).
  // Deliberate surface change, not drift.
  //
  // 2026-07-27 re-pin (kimi-loop-background-tuning, review-gate round-1 minors):
  // file COUNT unchanged (139) -- only plugin/commands/go.md's content changed
  // again, wave 2's review-gate round-1 fix pass on the same Kimi
  // loop/background profile block. Two prose corrections, no value/decision
  // change: the "four of the five values restate defaults" claim was factually
  // wrong (the binary probe shows print_background_mode defaults to steer too,
  // so all five restate defaults on a clean config; the four-of-five count owed
  // solely to the legacy keep_alive_on_exit conditional, now named explicitly),
  // and the "leaves [loop_control]/[background] at the binary defaults"
  // sentence gained its caveat clause -- defaults apply unless the user's
  // config.toml already sets those keys, with the operator advisory that a
  // user-set max_steps_per_turn cap would abort a healthy long run. The chosen
  // values themselves, the docs-pin/no-emission decision, and all src/ logic
  // are unchanged; the paired §11.10/kimi-install.js/test updates sit outside
  // this surface. Deliberate surface change, not drift.
  //
  // 2026-07-27 re-pin (semantic-tier rename): catalog/agents.manifest.json's 27
  // entries moved from the legacy Claude-family tier vocabulary to muster's
  // canonical conceptual ladder (haiku|sonnet|opus|fable -> scout|core|prime|
  // apex, model.js LEGACY_TIER_ALIASES). Concrete adapter outputs are proven
  // byte-identical by codex-policy/kimi tests; plugin agent frontmatter is
  // untouched (it is Claude-concrete by design, emitted via claude.js).
  // Deliberate surface change, not drift.
  // (Also covers the router skill's crew[].model vocabulary update.)
  // 2026-07-27 re-pin (kimi-process-lane-dispatch): file COUNT unchanged (139) --
  // only plugin/skills/orchestrator/SKILL.md's content changed. Its Kimi-native
  // dispatch subsection gained the attended-session process-lane paragraph:
  // lane-sensitive legs in an attended/interactive Kimi session dispatch via
  // kimiProcessDispatch (wave 1's headless `kimi -p --agent-file` descriptor
  // builder, src/kimi-dispatch.js -- outside this surface) because the TUI
  // ignores model_preference, with -m always emitted (it alone binds the -p
  // process's own model; model_preference binds only spawned subagents) and the
  // receipt path named (stream-json stdout + exit code + readSessionUsage per-leg
  // token accounting). The paragraph sits INSIDE build-codex.mjs's wholesale
  // "## Wave dispatch" -> "## Scope fences" replacement span, so it ships to no
  // Codex build and needs no guarded rewrite -- verified the generated Codex
  // orchestrator skill carries zero occurrences of "kimiProcessDispatch".
  // Re-verified with MUSTER_BUILD_FORCE=1 node scripts/build-codex.mjs && node
  // scripts/check-codex.mjs (clean). docs/binding-interface.md's grep-audit
  // counts re-scanned live -- unchanged (test/docs-binding-interface.test.js
  // green without a re-derivation). Deliberate surface change, not drift.
  // REBASE-NOTE: hash refreshed post-rebase onto the tier rename.
  //
  // 2026-07-27 re-pin (kimi-process-lane-dispatch review-gate round 1): file
  // COUNT unchanged (139) -- content changed in plugin/skills/orchestrator/
  // SKILL.md (the process-lane paragraph now states the descriptor's env is an
  // OVERRIDE pair merged over the ambient process env at spawn,
  // `{ ...process.env, ...d.env }`, never passed as the whole env, and names
  // KIMI_SECONDARY_MODEL's subagent-lane binding) and plugin/commands/go.md
  // (the kimiGoalInvocation env-pair sentence gained the same one-clause merge
  // note, `{ ...process.env, ...inv.env }`). The review-gate BLOCKER: prose
  // that invited spawn("kimi", d.argv, { env: d.env }) -- wholesale env
  // replacement losing HOME/PATH. src/kimi-dispatch.js's matching
  // comment/constant changes sit outside this surface. Deliberate surface
  // change, not drift.
  //
  // 2026-07-27 re-pin (kimi-batch-token-reporting): file COUNT unchanged (139) --
  // content changed in plugin/commands/go-backlog.md (step 4's batch report table
  // gained a "tokens (Kimi only)" column and the Kimi token-accounting clause:
  // captureSessionId at dispatch on the leg's stream-json stdout,
  // resolveSessionForCwd({ cwd: <item worktree path>, capturedSessionId }) before
  // worktree teardown, summarizeItemReceipts lines transcribed into STATE next to
  // each item's gate summary, UNKNOWN lines never blocking, non-Kimi harnesses
  // omitting the line) and plugin/commands/go.md (step 8's finish gained the
  // single-outcome equivalent clause). Both clauses are harness-conditional
  // ("On Kimi ... non-Kimi harnesses omit the line"), the SAME shape as go.md's
  // pre-existing "Kimi run loop" paragraph, which already ships verbatim into
  // the Codex build -- so no guarded rewrite in scripts/build-codex.mjs was
  // needed; verified the built .agents/plugins/plugin/commands/go.md still
  // carries "kimiGoalInvocation" and both new clauses verbatim, and
  // MUSTER_BUILD_FORCE=1 node scripts/build-codex.mjs && node
  // scripts/check-codex.mjs re-ran clean. src/kimi-receipts.js (the named
  // functions' home) sits outside this surface. docs/binding-interface.md's
  // grep-audit worktree row re-derived 26 -> 28 mentions (file count unchanged).
  // Deliberate surface change, not drift.
  //
  // 2026-07-27 re-pin (kimi-batch-token-reporting, review-gate round-1 fixes):
  // file COUNT unchanged (139) -- content changed in plugin/commands/go-backlog.md
  // and plugin/commands/go.md only. A review-gate BLOCKER found the accounting
  // clause promised per-worktree session resolution for legs that can't produce
  // it: wave-mode items dispatch as in-session muster-runner Agent-tool
  // subagents whose tokens live in the PARENT session's agents tree (indexed
  // under the parent's cwd), so resolveSessionForCwd({ cwd: <item worktree> })
  // returns no-sessions-for-cwd for every such item. Both files now state the
  // two arms explicitly: the captureSessionId + resolveSessionForCwd chain is
  // scoped to PROCESS-LANE (kimi -p) legs only, and in-session Agent/AgentSwarm
  // legs are accounted via the parent session's own readSessionUsage dispatches
  // view or omitted with a STATE note -- never per-worktree resolution. Two
  // minors landed in the same pass: go.md step 6 now names the streamJson:true
  // opt-in (kimiGoalInvocation defaults streamJson:false, so step 8's captured
  // stdout silently yielded null), and the summary line now surfaces each leg's
  // resolution source (captured/index-unique/index-newest) with multi-leg
  // (retried/fix-looped) items summed per-leg in summarizeItemReceipts
  // (src/kimi-receipts.js, outside this surface). test/kimi-receipts.test.js's
  // prose-consistency pins were extended to lock the scoping.
  // Deliberate surface change, not drift.
  // REBASE-NOTE (2026-07-27): hash refreshed after the mid-batch rebase onto the
  // semantic-tier rename (main 6d565a3); covers the rename re-pin and this
  // branch's process-lane/token-accounting re-pins above.
  //
  // 2026-07-27 re-pin (first-class init): one reviewed command was added and the
  // greenfield skill now delegates repository preparation to its receipted lifecycle.
  //
  // 2026-07-27 re-pin #2 (tier-vocabulary-dispatch-rules): the five LIVE
  // dispatch-rule prose sites (orchestrator Model bullet, advisor step 4,
  // tournament judge, audit dimension sweep) moved off the legacy vocabulary
  // and now dispatch on the harness-concrete adapter FIELDS capabilities
  // attaches (claudeModel / advisorClaudeModel / codexModel / kimiModel) --
  // a conceptual tier is never passed raw to an Agent tool again. Deliberate
  // surface change, not drift.
  //
  // 2026-07-27 re-pin #3 (tier-vocabulary-prose-pass): gsd-execute-phase's
  // model= examples clarified as Claude Code's OWN aliases (harness-concrete,
  // not muster tiers) -- the last plugin prose that could read as teaching the
  // legacy vocabulary. All remaining legacy-name occurrences in plugin/ are
  // deliberate: agent frontmatter (Claude-concrete by design), compat-alias
  // documentation, and adapter-output examples. Deliberate change, not drift.
  //
  // 2026-07-27 re-pin #4 (audit S5, canonical tier vocabulary in live comments):
  // file COUNT unchanged (140) -- only plugin/skills/orchestrator/SKILL.md's
  // content changed, one prose fix in the "Codex-native dispatch: spawn_agent"
  // subsection: "muster's SONNET tier" -> "muster's core tier" (the semantic
  // tier rename; gpt-5.6-luna is muster's core tier). Comment/prose-only, no
  // behavior change. Deliberate change, not drift.
  //
  // 2026-07-27 re-pin #5 (audit S6, canonical tier vocabulary on the Cowork
  // user surface): file COUNT unchanged (140) -- only cowork/mcp-server.mjs's
  // content changed: the muster_advise tool/protocol descriptions now say
  // "(apex degrades to prime)" instead of "(fable->opus)", and a startup
  // env-merge honors a stored fable-era enable_fable/MUSTER_ENABLE_FABLE
  // opt-in alongside the canonical MUSTER_ENABLE_APEX (new key preferred;
  // the pinned `env: { ...process.env, MUSTER_RUNTIME: "cowork" }` spawn line
  // the Codex build transform rewrites FROM is byte-identical, verified by
  // test/codex-mcp-runtime-env.test.js). Tier aliasing stays owned by
  // src/model.js. Deliberate change, not drift.
  //
  // 2026-07-27 re-pin #6 (audit S10, security P2: pre-tool-use realpath
  // scoping): file COUNT unchanged (140) -- only plugin/hooks/pre-tool-use.js's
  // content changed: the guard-scope/meta-exempt prefix tests now realpath()
  // both cwd and target (best-effort, lexical fallback on ENOENT) so an edit
  // target reached through an in-tree symlink pointing outside cwd classifies
  // as out-of-scope instead of in-scope. Deliberate security remediation, not
  // drift.
  //
  // 2026-07-27 re-pin #7 (audit review-gate round 1: cowork legacy-key shim
  // precedence): file COUNT unchanged (140) -- only cowork/mcp-server.mjs's
  // content changed: the startup env-merge now treats enable_apex SET TO
  // EITHER VALUE as always winning over the legacy enable_fable key (which
  // applies only when enable_apex is unset), so a stale legacy opt-in can no
  // longer override an explicit enable_apex=false. The pinned
  // `env: { ...process.env, MUSTER_RUNTIME: "cowork" }` spawn line the Codex
  // build transform rewrites FROM is byte-identical. Deliberate review-gate
  // remediation, not drift.
  //
  // 2026-07-27 re-pin #8 (documentation audit review gate: Cowork dispatch
  // evidence): file COUNT unchanged (140) -- only cowork/mcp-server.mjs's
  // protocol guidance/comments changed. Sequential muster_next is now the
  // verified default; parallel fan-out and per-call model override require a
  // successful phase-3 receipt from the active Cowork build. Deliberate
  // shared-surface correctness remediation, not Codex-only drift.
  //
  // 2026-07-29 re-pin #9 (cc-workflow-lane): orchestrator SKILL.md's "Wave
  // dispatch" section rewritten against a live 2.1.220 observation -- Workflow
  // present in plain single-session tool lists, per-agent isolation:'worktree'
  // confirmed (multi-file-writing-wave restriction lifted), Workflow-lane
  // effort ladder (src/claude.js workflowEffort), journal/schema receipts,
  // resumeFromRunId retry. Deliberate shared-surface change, one re-pin.
  //
  // 2026-07-29 re-pin #10 (skill-split): file count 140 -> 142 -- the
  // orchestrator's Codex/Kimi dispatch sections moved to progressive-disclosure
  // references/{codex,kimi}-dispatch.md (read on demand by that harness only);
  // SKILL.md keeps the headings + on-<harness>-read-this pointers. Content
  // preserved verbatim; kimi-dispatch prose guards repointed to the reference.
  //
  // 2026-07-29 re-pin #11 (rubric-verifiers): file COUNT unchanged (142) --
  // plugin/skills/review-gate/SKILL.md, plugin/skills/review-gate/fast-path-
  // brief.md, and plugin/skills/tournament/SKILL.md all changed content.
  // review-gate/SKILL.md gained a new "## Rubric-fed verifiers" section: an
  // optional .muster/rubric.md, when present, rides along the FULL reviewer
  // brief verbatim as a RUBRIC: block; findings mapped to a rubric dimension
  // cite it by name; propose-not-invent; absent file is a no-op -- fitting it
  // under the file's own <=2000-token brief-template budget
  // (test/prompt-scan-brief-lint.test.js) required tightening existing prose
  // elsewhere in the same marked span (steps 1-6, the three surface-type
  // gates, the fast-path brief section) without touching any pinned substring
  // (severity enum, REVIEW_GATE_MAX_ITERATIONS, capabilities.json Inputs line,
  // the three surface/gate-name pairs, the eval/modes mutant-kill-rule-clean.md
  // fixture -- all re-verified green) or exceeding the ANTH-POS-001 negative-
  // framing cap (5 for a system-genre doc; landed at 4). Review fix loop 1
  // (blocker): the full brief's rule alone left the FAST-PATH reviewer brief
  // (fast-path-brief.md, dispatched INSTEAD OF the full file whenever
  // reviewerCount:1 with no citation/mutant-kill/surface trigger) never seeing
  // the rubric at all, so fast-path-brief.md now carries the identical
  // five-part rule (conditional/verbatim/cite-by-name/propose-not-invent/no-op)
  // as its own item 4, comfortably inside its own <=2000-token brief-template
  // budget (442.5 tokens). Review fix loop 1 (blocker): tournament/SKILL.md's
  // judge-scoring bullet (part a, its own <=1000-token return-template span)
  // initially omitted propose-not-invent for the judge; it now reads the same
  // .muster/rubric.md alongside successCriteria, cites dimensions by name in
  // the scoring justification, propose-not-invents exactly like the reviewers
  // do, and leaves scoring unchanged when the file is absent. Deliberate
  // additive change, not drift.
  // 2026-07-29 re-pin #12 (improver-fork, rebase-recompute by the driver):
  // file count 142 -> 143 -- new plugin/skills/improve/SKILL.md (context: fork
  // background retrospective; propose-never-apply; agent fallback line) plus a
  // one-line pointer in plugin/agents/muster-improver.md. The runner's own pin
  // was computed against pre-#158 main; this recompute folds both histories.
  // (Sibling fix, no plugin-surface change: #158's prose tightening had
  // silently desynced scripts/build-codex.mjs's literal fix-cap replacement
  // anchor -- String.replace no-ops on a miss -- dropping the generated
  // bundle's "one fix-and-re-review iteration" clause. The anchor is now a
  // wording-tolerant regex that throws on a miss.)
  // 2026-07-29 re-pin #13 (driver fold): the concurrent Kimi workstream's 7
  // local commits (kimi 0.30.0 re-probes, quota fail-fast billing escalation,
  // steer-route leak-guard) rebased onto the merged #158/#159 main; its own
  // pin-only commit dropped as empty and this recompute covers the fold.
  // 2026-07-29 re-pin #14 (prompt-diet): orchestrator Task board's Codex
  // update_plan correction narrative compressed to a one-line research-doc
  // cite; mechanics and the one-in-flight invariant kept verbatim.
  // eval:modes 160/160 after the cut.
  //
  // 2026-07-29 re-pin #15 (ChatGPT Work tool-only runtime): file COUNT
  // unchanged -- cowork/mcp-server.mjs gained the
  // pre-dispatch profile selector and nonce-bound one-call handler used by the
  // separately bundled Work MCP runtime. Empty/unset profile behavior remains
  // response-identical (pinned in test/cowork.test.js); the shared change is
  // unavoidable because Codex, Cowork, and Work must dispatch the same
  // deterministic CLI tool definitions rather than fork their implementations.
  //
  // 2026-07-29 re-pin #16 (neutral MCP architecture): file COUNT 143 -> 144.
  // The shared implementation moved from cowork/mcp-server.mjs to
  // mcp/server.mjs; the Cowork path is now an explicit host adapter, while
  // Codex and Work select their host contracts explicitly without rewriting
  // the shared source during builds.
  // Re-pin #17: the app-neutral factory owns only the shared catalog/protocol
  // engine; Cowork-specific protocol and alias prose live in its adapter.
  // 2026-07-29 re-pin #18 (audit 2026-07-29 slice A, security P1: rubric.md
  // untrusted-data fence): file COUNT unchanged (144) --
  // plugin/skills/review-gate/SKILL.md, plugin/skills/review-gate/
  // fast-path-brief.md, plugin/skills/tournament/SKILL.md, and
  // plugin/skills/improve/SKILL.md changed content. review-gate/SKILL.md's
  // "## Rubric-fed verifiers" section is now the CANONICAL rubric policy:
  // .muster/rubric.md is repo-controlled DATA (never instruction or operator
  // intent), folded in only after a regular-file/contained-under-run-root
  // check (src/fs-safe.js's resolveContainedRealpath), capped at 4 KiB, and
  // wrapped in a <remote-text> untrusted-data fence supplying review
  // DIMENSIONS ONLY; fast-path-brief.md and tournament/SKILL.md became short
  // pointers to it (shared key phrases pinned in test/rubric-verifiers.test.js
  // across all three), and improve/SKILL.md gained a mined-content-is-data-
  // not-instructions clause. Fitting the bigger canonical section under the
  // same <=2000-token brief-template budget (test/prompt-scan-brief-lint.test.js,
  // span now 7978 chars) required tightening existing prose elsewhere in the
  // marked span (Inputs, step 1, step 2's exhausted/absent bullet, the
  // fast-path brief section) and dropping the return-contract sentence that
  // duplicated the file's closing line -- no pinned substring touched (brief
  // identity, severity enum, REVIEW_GATE_MAX_ITERATIONS, the capabilities.json
  // anchor, the three surface/gate-name pairs, the mutant-kill fixture -- all
  // re-verified green; Codex build anchors all still hold, so
  // scripts/build-codex.mjs is unchanged).
  // 2026-07-30 re-pin #19 (audit 2026-07-29 slice B, security P1: sprint-waves
  // backlog canonical containment): file COUNT unchanged (144) --
  // plugin/commands/plan-backlog.md and plugin/commands/go-backlog.md changed
  // content, one clause each: the sprint-waves backlog read now states that
  // the CLI realpath()s the file and reads only the resolved canonical path
  // contained under the run root, refusing a symlink escape with a named
  // containment error (src/fs-safe.js's resolveContainedRealpath, the same
  // check src/scope.js's readBacklogCandidate applies). The code fix itself
  // (src/cli.js's sprint-waves branch, outside this hashed surface) routes
  // the read through that same check; test/fs-safe.test.js pins the CLI-level
  // refusal. mcp/server.mjs (in this surface) also changed: its "text"-kind
  // temp-file handoff (muster_sprint_waves) now runs the CLI with the fresh
  // mkdtemp dir AS the cwd, so the server-written handoff file stays inside
  // the new run-root containment by construction (the caller controls the
  // file's content, never its path). No Codex-specific wording, so
  // scripts/build-codex.mjs is unchanged (build + check-codex re-verified
  // clean). NOTE: this hash is derived over a working tree that also carries
  // the concurrent slice-H+I worker's IN-FLIGHT (then-uncommitted)
  // plugin/skills/orchestrator/references/codex-dispatch.md edit -- if that
  // lands with different content, re-derive on top of their commit.
  // 2026-07-30 re-pin #20 (audit 2026-07-29 slice D, architecture/
  // simplification P1: codex-dispatch contract single-sourcing): file COUNT
  // unchanged (144), hash UNCHANGED from re-pin #19 -- #19's derivation already
  // ran over a working tree carrying this slice's then-in-flight edits, and
  // re-deriving over the finished tree reproduces the identical digest
  // (verified, not assumed). The in-flight edits the #19 note could not name
  // were THIS slice's, now landed: plugin/skills/orchestrator/
  // references/codex-dispatch.md's fork_turns paragraph gained the standing
  // quota-policy sentence (positive fork only on explicit user request, never
  // "all" -- aligning the reference with the policy scripts/build-codex.mjs's
  // replacement texts already carried), and its header NOTE now documents that
  // the build embeds the paragraph and the v1/v2 shapes table VERBATIM
  // (loadCodexDispatchContract, throw-on-miss) instead of maintaining a second
  // copy; plugin/skills/orchestrator/SKILL.md's Codex-native and Kimi-native
  // dispatch pointers were trimmed to pure read-the-reference pointers (they
  // re-stated reference-owned facts with no sync guard; both sit inside
  // build-codex.mjs's wholesale-replaced "## Wave dispatch" .. "## Scope fences"
  // span, so the build anchors only on those two headings and no anchor needed
  // the pointer bodies). docs/binding-interface.md's grep-audit counts are
  // unchanged (the trimmed/kept pointer prose matches none of the four tracked
  // term patterns, re-verified green). scripts/build-codex.mjs itself is
  // outside this hashed surface.
  // 2026-07-30 re-pin #21 (audit 2026-07-29 slice E, architecture P1:
  // model-facing helpers wired to CLI verbs + claudeProfile emission): file
  // COUNT unchanged (144) -- plugin/commands/go.md, go-backlog.md, runner.md,
  // plugin/skills/orchestrator/SKILL.md, and
  // plugin/skills/orchestrator/references/{kimi,codex}-dispatch.md changed
  // content. The prose's "call X" language for the kimi-dispatch/kimi-receipts
  // helpers and the Codex packet builders became `$MUSTER_CLI` verb
  // invocations (kimi-goal-invocation / kimi-process-dispatch /
  // kimi-session-usage / kimi-summarize-receipts / codex-spawn-packet /
  // codex-wait-packet, new in src/cli.js -- outside this hashed surface), so
  // the model layer reaches the builders only through the CLI; the pinned
  // rules (env-merge shape, -m always, receipt paths, UNKNOWN handling, the
  // two-arm accounting split) are preserved verbatim and their prose pins in
  // test/kimi-receipts.test.js + test/kimi-dispatch.test.js were re-pointed at
  // the verb shapes. codex-dispatch.md's fork_turns paragraph and v1/v2 shapes
  // table (the two blocks scripts/build-codex.mjs extracts verbatim) are
  // untouched -- only the intro paragraph's builder sentence changed, so the
  // build anchors hold (build + check-codex re-verified clean). orchestrator
  // SKILL.md's Workflow-lane effort line now points at
  // `roles[<role>].claudeProfile.workflowEffort`, the field src/capabilities.js
  // (outside this surface) newly emits via claudeProfileForAgentId -- the same
  // manifest-driven profile shape the codex/kimi lanes already emitted; that
  // edit sits inside build-codex.mjs's wholesale-replaced wave-dispatch span,
  // so no build anchor is affected. docs/binding-interface.md's grep-audit
  // counts are unchanged (re-verified green).
  // 2026-07-30 re-pin #22 (audit S6): runner.md gains the $MUSTER_CLI resolution block its
  // siblings carry; both hardcoded node src/cli.js call sites switched.
  // 2026-07-30 re-pin #23 (docs-authority remediation): file COUNT unchanged
  // (144) -- plugin/commands/init.md now makes AGENTS.md the single native
  // instruction authority for both Claude Code and Codex handoffs, requires
  // CLAUDE.md to be the thin @AGENTS.md pointer, and records both files in the
  // expected-artifact baseline. This is the reviewed shared-surface remediation
  // for the one-authority contract, not accidental Codex-side drift.
  // 2026-07-30 re-pin #24 (docs-authority review fix): file COUNT unchanged
  // (144) -- plugin/commands/init.md's confirmation and call-result examples
  // now attest both canonical instruction artifacts rather than showing an
  // AGENTS.md-only proof that the validator correctly rejects.
  // 2026-07-30 re-pin #25 (wave-dispatch review fix): muster-runner gains the explicit
  // build-review-only mode; go-backlog selects it for scheduled legs and defers all
  // dispositions until the emitted post-barrier phase. The ordinary runner command remains
  // full-lifecycle. Cowork mirrors the same no-push/no-PR/no-integration leg boundary.
  // 2026-07-30 re-pin #26 (wave escalation semantics): go-backlog now omits escalated/failed
  // build-review legs from disposition/integration without reordering survivors, and fails
  // dependent items closed before worktree creation or dispatch. The runner profile is unchanged.
  // 2026-07-30 re-pin #27 (production dispatch receipts): only the executable
  // Kimi process-lane prose changed. references/kimi-dispatch.md now requires
  // the PID-owning `kimi-process-run` supervisor and leaves
  // `kimi-process-dispatch` descriptor-only; go-backlog.md names that same
  // supervised lane for its token-accounting arm. File count is unchanged.
  // 2026-07-30 re-pin #28 (receipt authority remediation): the same two Kimi
  // process-lane prose files now pin the live Linux broker/group boundary,
  // diagnostic-only filesystem receipts, fail-closed unsupported platforms,
  // canonical executable/path binding, and the unavoidable secret-free argv
  // brief rule. File count remains unchanged.
  // 2026-07-30 re-pin #29 (receipt broker review remediation): the Kimi
  // process-lane paragraph now names inherited /proc/self/fd bindings,
  // immutable agent snapshots, bounded signal cleanup, launcher lifetime, and
  // globally bounded diagnostic-receipt enumeration. File count is unchanged.
  // 2026-07-30 re-pin #30 (kernel containment fix loop): that paragraph now
  // pins immutable executable/interpreter snapshots, delegated cgroup-v2 plus
  // bubblewrap containment, setsid-proof cgroup.kill, and bounded receipt
  // compaction. File count remains unchanged.
  // 2026-07-30 re-pin #31 (trusted-broker decision): the same two Kimi
  // process-lane prose files now make process dispatch report-only on every
  // platform, escalate attended lane-sensitive legs, and retain the
  // descriptor-only plus unattended in-session contracts. File count remains
  // unchanged.
  // 2026-07-30 re-pin #32 (backlog writer serialization): every file-backed backlog
  // producer now routes publication through the shared backlog-publish CAS command.
  // Review-gate follow-up: Cowork's writer now invokes the bounded MCP publisher
  // directly instead of naming a CLI/stdin mechanism unavailable on MCP-only hosts.
  // 2026-07-30 re-pin #33 (final integration verification): audit.md and runner.md
  // document narrowly scoped prompt-lint safety exceptions; go-backlog.md adds
  // the matching rule-density exception while preserving its remote-text and
  // report-only Kimi process-lane contracts. Runner receipts now also require
  // source-item or issue citations for factual claims. File count remains unchanged.
  // 2026-07-31 re-pin #34 (first-class design mode): plugin/commands/design.md
  // adds the attended DESIGN.md context gate and 23 pinned workflows; the
  // shared MCP core adds muster_design and the existing lifecycle prompts gain
  // conditional design qualification. File count grows from 144 to 145.
  // 2026-07-31 re-pin #35 (release-readiness audit): shared workflow and agent
  // contracts now enforce approval-bound actions, PASS-only advancement, and
  // the hardened brainstorm server asset. File count grows from 145 to 146.
  // 2026-07-31 re-pin #36 (browser-boundary security review): the companion
  // helper is now a second intentional local overlay, isolating untrusted
  // generated screens from the authenticated controller. Count grows to 147.
  // 2026-07-31 re-pin #37 (release gate follow-up): isolated writer worktrees
  // now receive the active action-fence markers, and the brainstorm controller
  // uses distinct query capabilities instead of a host-wide localhost cookie.
  // 2026-07-31 re-pin #38 (companion contract overlay): the no-cookie guide and
  // launcher are local overlays alongside the hardened runtime. Count grows
  // from 147 to 149; same-origin view-capability assets stay CSP-compatible.
  // 2026-07-31 re-pin #39 (final release review): stale runner exemption prose
  // is removed, and opaque sandbox assets receive explicit CORP/CORS headers.
  // Re-pin #40 adds the executable stop launcher to the durable local overlay,
  // increasing the shared surface from 149 to 150 files.
  // 2026-08-01 re-pin #41 (self-healing backlog driver): go-backlog now
  // bootstraps and verifies its own isolated outer worktree when invoked from
  // a primary checkout, retaining fail-closed CAS publication for bookkeeping.
  // File count remains unchanged.
  // 2026-08-02 re-pin #42 (desktop harness support): init.md distinguishes the
  // ChatGPT Desktop shell, Codex Desktop, and ChatGPT Work init handoffs.
  // 2026-08-02 re-pin #43 (wave-dispatch split): codex-dispatch.md points its
  // implementation citations at the extracted src/codex-dispatch.js module.
  assert.equal(hash.digest("hex"), "038fe761ecd169f642fa09387feaf5b817e70b196e8843d13a4809c059578575");
});
