// src/plan-surface.js -- plan-surface capability check for /muster:plan and
// /muster:plan-backlog's approve-first gate (backlog item `native-plan-mode-parity`).
//
// Which native plan surface does the CURRENT harness expose to route the Crew Manifest /
// batch-plan approval through, before falling back to the universal AskUserQuestion prose gate?
// This mirrors the DECLARED-signal shape already used elsewhere in this codebase for a
// capability that cannot be auto-probed from a deterministic CLI/test process --
// readInstalledCowork's `nativePluginRide` (src/harness.js) and the `--codex` capabilities flag
// (src/cli.js) both take a caller-supplied signal rather than probing a live harness. The caller
// (a command file's own runtime-detection step -- an in-session hook signal, MUSTER_RUNTIME, or
// an explicit CLI flag) supplies the runtime identifier; this module only judges the static,
// per-harness SELECTION -- does this harness expose a native plan surface at all, and which one
// -- never whether a given live session is presently in that mode. That finer, session-scoped
// check ("is permission_mode actually plan right now") is prose discipline in the command files
// themselves (plugin/commands/plan.md, plan-backlog.md), the same way Claude Code's existing
// "session is already in native plan mode" branch already is.
//
// Per-harness evidence:
//   - claude-code: ExitPlanMode / native plan mode (Shift+Tab, a /plan-prefixed prompt, or
//     --permission-mode plan) [docs/research/claude-code-cli.md §6].
//   - codex: hook payloads report `permission_mode` including the value "plan"
//     [docs/research/codex-cli.md §4.2], and the bundled system skill set independently includes a
//     "plan" skill [docs/research/codex-cli.md §5.2]. Separately, a turn's `item.started`/
//     `item.completed` stream names "plan updates" as a first-class item kind alongside messages/
//     reasoning/commands [docs/research/codex-cli.md §1] -- the research doc documents these as
//     three independent facts and nowhere claims invoking the bundled skill is what emits that
//     item kind, so this entry cites them as separately-verified native primitives (a real named
//     plan skill to author content through, plus real item-stream visibility for plan-shaped
//     work), not one asserted mechanism -- do not describe or imply a causal link between them.
//     Codex has no documented ExitPlanMode-equivalent call that programmatically submits approval,
//     so the actual approve/adjust/cancel decision still rides Codex's AskUserQuestion binding on
//     top of the native plan artifact (see plan.md).
//   - hermes: a protected, hardcoded, permanent built-in `plan` skill powers a `/plan`
//     slash-command flow [docs/research/hermes.md §4], and `/goal` completion contracts
//     (`outcome`/`verification`/`constraints`/`boundaries`/`stop_when`) let the goal_judge model
//     require concrete verification evidence before declaring an outcome done
//     [docs/research/hermes.md §4]. Hermes's own docs name no blocking plan-approval mode
//     (hermes.md's augmentation table: "Partial -- approve-first must be enforced by muster's
//     own skill flow + clarify"), so the front-door block still rides Hermes's `clarify` tool.
//   - cowork: the documented 5-step task loop has no exposed task-graph, plan object, or
//     dependency ordering -- "the plan is prose in the agent's head"
//     [docs/research/claude-cowork.md §2]. No native surface exists; the whole approve-first
//     flow degrades to muster's own prose (AskUserQuestion has no Cowork equivalent either, so
//     this is the sprint-protocol's existing in-chat human-ask degradation, not a new gap).
//
// A note on the `primitive` field: it names the native AUTHORING mechanism for the plan artifact
// (if any) -- never the approval UI. Every harness's actual approve/adjust/cancel decision still
// funnels through an AskUserQuestion-shaped surface (AskUserQuestion itself, or Hermes's `clarify`
// tool) except Claude Code's own ExitPlanMode, which is uniquely both the artifact call AND the
// approval gate in one native primitive. `primitive: null` (cowork, and the generic fallback's
// `"AskUserQuestion"`) means no native AUTHORING mechanism exists, not that no approval flow does.
//
// This module makes NO harness calls, reads no environment, and touches no filesystem -- pure
// selection logic over a caller-supplied string, exactly so it stays unit-testable without a
// live plan-capable session (see test/plan-surface.test.js).

const CC_CITE = "docs/research/claude-code-cli.md §6";
const CODEX_CITE = "docs/research/codex-cli.md §1, §4.2, §5.2";
const HERMES_CITE = "docs/research/hermes.md §4";
const COWORK_CITE = "docs/research/claude-cowork.md §2";

const PLAN_SURFACES = {
  "claude-code": {
    surface: "native",
    primitive: "ExitPlanMode",
    detail: "call ExitPlanMode with the rendered plan (Crew Manifest / batch plan) as its `plan` argument",
    cite: CC_CITE
  },
  codex: {
    surface: "native",
    primitive: "plan-skill+permission-mode",
    detail: 'while the session\'s permission_mode is "plan", invoke the bundled system `plan` skill with the rendered plan as its content; independently, Codex\'s own item model already tracks "plan updates" as a first-class item kind in the turn\'s event stream (two separately-documented native primitives, not one asserted mechanism)',
    cite: CODEX_CITE
  },
  hermes: {
    surface: "native",
    primitive: "plan-skill+goal-contract",
    detail: "author the rendered plan through the protected built-in `plan` skill's /plan flow, then encode the manifest's success criteria as a /goal completion contract (outcome/verification/constraints/boundaries/stop_when)",
    cite: HERMES_CITE
  },
  cowork: {
    surface: "prose",
    primitive: null,
    detail: "no exposed plan-mode object or task-graph primitive exists -- degrade to muster's own prose approve-first flow",
    cite: COWORK_CITE
  }
};

const FALLBACK = {
  surface: "prose",
  primitive: "AskUserQuestion",
  detail: "fall back to the AskUserQuestion selection UI (Approve & run / Adjust the plan / Cancel)",
  cite: "plugin/commands/plan.md"
};

// resolvePlanSurface(runtime) -> { runtime, surface, primitive, detail, cite }
//
// `runtime` is the caller-supplied, DECLARED harness identifier (never auto-probed here):
// "claude-code" | "codex" | "hermes" | "cowork". Anything else -- undefined, empty, unrecognized
// (e.g. a bare Agents SDK runner lane) -- resolves to the universal AskUserQuestion prose
// fallback, never a thrown error: an unknown harness must always still get an approve-first gate.
export function resolvePlanSurface(runtime) {
  const key = typeof runtime === "string" ? runtime.trim().toLowerCase() : "";
  const entry = PLAN_SURFACES[key];
  if (!entry) return { runtime: key || "unknown", ...FALLBACK };
  return { runtime: key, ...entry };
}
