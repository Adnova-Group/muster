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
  assert.equal(paths.length, 137);
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
  // `Workflow` tool, names `src/wave-dispatch.js`'s new `resolveCodexWaveDispatch` (spawn_agent
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
  assert.equal(hash.digest("hex"), "07f5dda08bd69287dc7fc18dabdf4dd21e45bab9a6aea9fcec80c209fbbb6681");
});
