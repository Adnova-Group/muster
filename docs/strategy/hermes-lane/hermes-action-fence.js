// hermes-action-fence.js — SPIKE scaffolding for the hermes-runner-lane-spike
// item (see ../hermes-runner-lane.md). Deliberately lives under docs/strategy/,
// NOT plugin/hooks/: plugin/ is muster's *published* Claude Code plugin surface
// (npm `files`, pinned byte-identical by test/claude-parity.test.js) and
// plugin/hooks/hooks.json wires Claude Code PreToolUse/SessionStart/
// UserPromptSubmit only -- Claude Code never reads this file, no real Hermes
// host exists to read it either, and shipping inert spike code inside the
// published plugin surface would be exactly the kind of bloat this spike's own
// dispatching context (native-delegation.md: "faster and less bloated") argues
// against. This module is not imported by src/cli.js, src/harness.js,
// plugin/hooks/hooks.json, or any shipped dispatch path -- reachable only from
// its own test (../../../test/hermes-lane.test.js). It exists purely as a
// testable, isolated demonstration of one leg of the design: how muster's
// action-class fence decision (plugin/hooks/action-guard.js's classifyAction,
// already wired into plugin/hooks/pre-tool-use.js for Claude Code) would
// translate onto Hermes's OWN `pre_tool_call` hook contract, if a real Hermes
// host ever pointed its config.yaml `hooks:` block at a script built on this
// shape. No live Hermes host was reachable to verify this end-to-end
// (docs/research/hermes.md: no ~/.hermes, no `hermes` binary on this machine)
// -- designed + unit-tested against fixtures only, never exercised against a
// running Hermes process.
//
// Why this module emits {"action":"block","message":...} rather than
// pre-tool-use.js's hookSpecificOutput/permissionDecision JSON verbatim:
// docs/research/hermes.md section 7 (the dedicated Hooks section) documents
// pre_tool_call's OWN canonical veto response as
// `{"action": "block", "message": ...}` [src: hermes-hooks] -- unambiguous
// under every reading of the source, so this module targets it. Separately,
// hermes.md's augmentation table (section 10) and closing verdict (section 11)
// state more broadly that "`pre_tool_call` block hooks ... accept the
// Claude-Code `{"decision":"block","reason"}` shape verbatim," which section 7's
// own prose frames as "shell-hook block responses" generally rather than
// re-stating against pre_tool_call by name -- the two passages aren't fully
// reconciled within hermes.md itself. This module does not depend on resolving
// that internal ambiguity: it only emits the one shape every section of
// hermes.md agrees pre_tool_call understands.
//
// Scope: only the forbidden-ACTION-CLASS fence (the one hard deny muster's
// Claude Code hook can emit) is mapped here -- not the border invitation
// (warn-only drift nudge), which has no `pre_tool_call` analog: that hook
// point is documented as returning either a block or nothing, with no
// "allow-with-context" response shape (context injection instead lives at
// `pre_llm_call`, a different event). See the "warn mode -> null" behavior
// below: this is a documented port gap, not an oversight.
//
// classifyAction is imported, not re-implemented -- reused directly from
// plugin/hooks/action-guard.js (a cross-directory import; only production code
// INSIDE plugin/hooks/ avoids importing from outside it -- test files already
// reach into plugin/hooks/ the same way, e.g.
// test/hook-pre-tool-use-action-fence.test.js).

import { classifyAction } from "../../../plugin/hooks/action-guard.js";

// mapActionFenceToHermes(payload, forbiddenClasses, mode)
//   payload:          a PreToolUse-shaped call payload (tool_name, tool_input)
//                      -- the same shape action-guard.js already classifies.
//   forbiddenClasses: array of class strings from this run's
//                      .muster/forbidden-actions (caller reads that file; this
//                      function stays pure and takes no filesystem input).
//   mode:              "deny" | "warn" | "off" -- mirrors MUSTER_ACTION_GUARD.
//
// Returns Hermes's canonical pre_tool_call block response
// ({action: "block", message: <string>}) when the call classifies into a
// forbidden class AND mode is not "off"/"warn"; otherwise null (no block --
// Hermes's documented default when a hook has nothing to veto). Any mode value
// other than the recognized "off"/"warn" -- including an unrecognized/typo'd
// string -- falls through to the deny branch, matching
// plugin/hooks/pre-tool-use.js's own MUSTER_ACTION_GUARD handling
// (`if (actionGuard === "warn") {...} else if (actionGuard !== "off") { deny }`):
// fail-CLOSED on an unrecognized value, so a typo cannot silently disable the
// fence. forbiddenClasses is validated defensively (non-array/missing ->
// null, never throws) since a caller-supplied value.
export function mapActionFenceToHermes(payload, forbiddenClasses, mode = "deny") {
  const cls = classifyAction(payload);
  if (!cls) return null;
  if (!Array.isArray(forbiddenClasses) || !forbiddenClasses.includes(cls)) return null;

  if (mode === "off") return null;
  if (mode === "warn") {
    // Documented port gap: pre_tool_call has no allow-with-context response.
    // A real port would need to route this text through `pre_llm_call`'s
    // `{"context": ...}` injection instead (docs/research/hermes.md section 7).
    // Out of scope for this bounded spike -- fails open (no block) here.
    return null;
  }

  return {
    action: "block",
    message:
      `Action class "${cls}" is forbidden for this run — this tool call would perform a ${cls} action. ` +
      `If this class should not be forbidden: remove its line from .muster/forbidden-actions. ` +
      `To soften or disable this check: set MUSTER_ACTION_GUARD=warn or off.`,
  };
}
