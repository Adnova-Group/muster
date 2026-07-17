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
//     [docs/research/codex-cli.md §4.2], the bundled system skill set includes a "plan" skill
//     [docs/research/codex-cli.md §5.2], and a turn's `item.started`/`item.completed` stream
//     names "plan updates" as a first-class item kind alongside messages/reasoning/commands
//     [docs/research/codex-cli.md §1]. Codex has no documented ExitPlanMode-equivalent call that
//     programmatically submits approval, so the actual approve/adjust/cancel decision still rides
//     Codex's AskUserQuestion binding on top of the native plan artifact (see plan.md).
//   - hermes: a protected, hardcoded, never-archivable built-in `plan` skill powers a `/plan`
//     slash-command flow [docs/research/hermes.md §4], and `/goal` completion contracts
//     (`outcome`/`verification`/`constraints`/`stop_when`) let the goal_judge model require
//     concrete verification evidence before declaring an outcome done
//     [docs/research/hermes.md §4]. Hermes's own docs name no blocking plan-approval mode
//     (hermes.md's augmentation table: "Partial -- approve-first must be enforced by muster's
//     own skill flow + clarify"), so the front-door block still rides Hermes's `clarify` tool.
//   - cowork: the documented 5-step task loop has no exposed task-graph, plan object, or
//     dependency ordering -- "the plan is prose in the agent's head"
//     [docs/research/claude-cowork.md §2]. No native surface exists; the whole approve-first
//     flow degrades to muster's own prose (AskUserQuestion has no Cowork equivalent either, so
//     this is the sprint-protocol's existing in-chat human-ask degradation, not a new gap).
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
    detail: 'while the session\'s permission_mode is "plan", invoke the bundled system `plan` skill with the rendered plan as its content, which surfaces as a native "plan update" item in the turn\'s event stream',
    cite: CODEX_CITE
  },
  hermes: {
    surface: "native",
    primitive: "plan-skill+goal-contract",
    detail: "author the rendered plan through the protected built-in `plan` skill's /plan flow, then encode the manifest's success criteria as a /goal completion contract (outcome/verification/stop_when)",
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
