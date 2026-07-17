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
  assert.equal(paths.length, 136);
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
  // Pin re-derived again for the fast-path-token-gap item (see docs/fast-path-token-gap.md): file
  // COUNT changed 135 -> 136 -- a genuinely new file, plugin/skills/review-gate/fast-path-brief.md
  // (lever 1's lighter reviewer brief for a fast-path/small-diff, single-reviewer dispatch; real,
  // measured ~70% smaller than the full review-gate/SKILL.md). review-gate/SKILL.md itself gained
  // one new "Fast-path reviewer brief" section, placed after the surface-type gates and before the
  // Mutant-kill gate section so it disturbs neither the mutant-kill-rule drift-guard fixture
  // (test/mode-evals.test.js) nor scripts/build-codex.mjs's review-gate step-1/fix-iteration-cap/
  // AvailableCapabilities-sentence Codex-adaptation anchors (all re-verified green). No other file
  // under this surface changed. This is the reviewed fast-path-token-gap remediation, not accidental
  // Codex-side drift.
  assert.equal(hash.digest("hex"), "cec1e53f0335fcf1768016d4a9311091ccf2c31a9d3ac5863f946b9697b2bc85");
});
