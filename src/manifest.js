import { lastColonSegment, impliedSurfaceForSkillId } from "./match.js";

const SOURCES = new Set(["installed", "builtin", "dynamic", "inline"]);
const MODES = new Set(["single", "tournament"]);
const MERGE_DISPOSITIONS = new Set(["merge-local", "merge-push", "pr", "keep", "ask"]);

// A label list is opaque here: strings that name files/globs for downstream orchestration
// (which task owns/must not touch which paths). No glob matching or overlap detection —
// just shape validation: an array of non-empty (post-trim) strings.
function isValidLabelArray(v) {
  return Array.isArray(v) && v.every((s) => typeof s === "string" && s.trim().length > 0);
}
// Model tiers a crew member may dispatch on. `fable` is the top tier (above opus),
// pre-accepted so a future fable-tier role validates without a schema change.
const MODEL_TIERS = new Set(["haiku", "sonnet", "opus", "fable"]);

// Fixed action-class vocabulary for the action-scoped fence (distinct from the
// path-scoped owns/frozen fences). A crew brief's effective forbidden set is the
// top-level forbiddenActions UNION the task's own forbiddenActions (additive,
// never subtractive) -- validated identically at both levels here.
const ACTION_CLASSES = new Set(["send", "sign", "submit", "publish", "purchase", "delete-remote"]);

// Shared surface taxonomy: the router assigns a task's `surface`, and the review
// gate keys its definition-of-done checks off the same value (design/UX pass for
// "ui", humanizer pipeline for "copy", live verification for "integration"). Both
// per-task fields below are OPTIONAL -- a manifest that omits them must still
// validate, so pre-existing manifests (authored before this schema addition)
// keep working unchanged.
const SURFACES = new Set(["ui", "copy", "integration", "none"]);

// Validate an optional per-task `skills: [{id, rationale}]` array. Each entry
// names a bound skill and why it was bound; malformed entries surface an error
// naming the task (by id, falling back to its task label) and the specific defect
// so a router/orchestrator author can find and fix the offending binding fast.
function validateSkillsArray(v, taskLabel, errors) {
  if (!Array.isArray(v)) {
    errors.push(`plan task "${taskLabel}".skills: must be an array of {id, rationale}`);
    return;
  }
  v.forEach((s, j) => {
    if (!s || typeof s !== "object") {
      errors.push(`plan task "${taskLabel}".skills[${j}]: must be an object with id and rationale`);
      return;
    }
    if (typeof s.id !== "string" || s.id.trim().length === 0)
      errors.push(`plan task "${taskLabel}".skills[${j}].id: required non-empty string`);
    if (typeof s.rationale !== "string" || s.rationale.trim().length === 0)
      errors.push(`plan task "${taskLabel}".skills[${j}].rationale: required non-empty string`);
  });
}

// Validate an action-class array under `label` (e.g. "forbiddenActions" or
// "plan[2].forbiddenActions"), pushing path-specific errors into `errors`.
// Non-array is a single shape error; each unknown-class entry gets its own
// indexed error so multiple bad entries are all surfaced, not just the first.
function validateActionArray(v, label, errors) {
  if (!Array.isArray(v)) {
    errors.push(`${label} must be an array of action-class strings`);
    return;
  }
  v.forEach((a, i) => {
    if (typeof a !== "string" || !ACTION_CLASSES.has(a)) {
      errors.push(`${label}[${i}]: unknown action class "${a}" (must be one of ${[...ACTION_CLASSES].join("|")})`);
    }
  });
}

export function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== "object") return { ok: false, errors: ["manifest must be an object"] };
  if (!m.outcome || typeof m.outcome !== "string") errors.push("outcome: required non-empty string");
  if (!Array.isArray(m.successCriteria) || m.successCriteria.length === 0)
    errors.push("successCriteria: required non-empty array");
  if (!Array.isArray(m.crew) || m.crew.length === 0) errors.push("crew: required non-empty array");
  else m.crew.forEach((c, i) => {
    for (const f of ["stage", "provider", "rationale", "evidence", "fallback"])
      if (!c[f]) errors.push(`crew[${i}].${f}: required`);
    if (!SOURCES.has(c.source)) errors.push(`crew[${i}].source: must be one of ${[...SOURCES].join("|")}`);
    // A non-inline member dispatches to a real provider on a real model — the model
    // must travel with it (else dispatch inherits the orchestrator's model). Inline
    // members run in-context and are exempt. A present model must be a known tier.
    if (c.source !== "inline" && !c.model) errors.push(`crew[${i}].model: required for non-inline members`);
    if (c.model && !MODEL_TIERS.has(c.model)) errors.push(`crew[${i}].model: must be one of ${[...MODEL_TIERS].join("|")}`);
  });
  for (const f of ["recommendations", "degradations"])
    if (!Array.isArray(m[f])) errors.push(`${f}: must be an array`);
  if (m.mergeDisposition !== undefined && !MERGE_DISPOSITIONS.has(m.mergeDisposition))
    errors.push(`mergeDisposition: must be one of ${[...MERGE_DISPOSITIONS].join("|")}`);
  if (m.forbiddenActions !== undefined) validateActionArray(m.forbiddenActions, "forbiddenActions", errors);
  if (!Array.isArray(m.plan) || m.plan.length === 0) errors.push("plan: required non-empty array");
  else {
    const ids = new Set();
    const multi = m.plan.length > 1;
    m.plan.forEach((p, i) => {
      if (!p.task) errors.push(`plan[${i}].task: required`);
      if (!MODES.has(p.mode)) errors.push(`plan[${i}].mode: must be single|tournament`);
      if (multi && !p.id) errors.push(`plan[${i}].id: required when plan has multiple tasks`);
      if (p.id) { if (ids.has(p.id)) errors.push(`plan[${i}].id: duplicate id "${p.id}"`); ids.add(p.id); }
      if (p.deps !== undefined && !Array.isArray(p.deps)) errors.push(`plan[${i}].deps: must be an array`);
      if (p.owns !== undefined && !isValidLabelArray(p.owns))
        errors.push(`plan[${i}].owns must be an array of non-empty strings`);
      if (p.frozen !== undefined && !isValidLabelArray(p.frozen))
        errors.push(`plan[${i}].frozen must be an array of non-empty strings`);
      if (p.forbiddenActions !== undefined) validateActionArray(p.forbiddenActions, `plan[${i}].forbiddenActions`, errors);
      const taskLabel = p.id || p.task || `plan[${i}]`;
      if (p.skills !== undefined) validateSkillsArray(p.skills, taskLabel, errors);
      if (p.surface !== undefined && !SURFACES.has(p.surface))
        errors.push(`plan task "${taskLabel}".surface: must be one of ${[...SURFACES].join("|")}`);
    });
    m.plan.forEach((p, i) => {
      for (const d of (p.deps || [])) if (!ids.has(d)) errors.push(`plan[${i}].deps: unknown dep "${d}"`);
    });
  }
  return { ok: errors.length === 0, errors };
}

// Non-fatal advisories: a manifest can be structurally VALID yet signal a likely mistake.
// An all-inline crew almost always means capability resolution was skipped — builtins (e.g.
// `implement -> muster-builder`) resolve for nearly every role, so a hand-authored inline-only
// crew silently bypasses routing and runs everything in-context. muster fails loud, so surface it.
//
// `skillsInventory` is OPTIONAL (resolveCapabilities().skills, i.e. `{id, source,
// description}[]`) — it is the live inventory a bound plan[].skills[].id is checked
// against. When omitted, the bound-skill-id-resolves check is skipped entirely rather
// than assuming every binding is unresolved (existing callers that don't run
// resolveCapabilities() first get no false positives). Passing an explicit `[]` is a
// deliberate "nothing is installed" inventory and will flag every binding.
export function manifestWarnings(m, skillsInventory) {
  const warnings = [];
  const crew = Array.isArray(m?.crew) ? m.crew : [];
  if (crew.length > 0 && crew.every((c) => c && c.source === "inline")) {
    warnings.push(
      "crew: every member is source:inline — capability resolution was likely skipped. " +
        "Build the crew from `npx -y @adnova-group/muster capabilities` (builtins resolve roles like `implement -> muster-builder`); " +
        "a hand-authored all-inline crew bypasses routing."
    );
  }

  const plan = Array.isArray(m?.plan) ? m.plan : [];
  // Namespace-insensitive (lastColonSegment), matching every other id comparison
  // against a live inventory elsewhere in the codebase (see match.js). `null` means
  // "no inventory was supplied" -> the per-binding resolution check below is skipped.
  const inventorySegments = Array.isArray(skillsInventory)
    ? new Set(skillsInventory.map((e) => lastColonSegment(String(e?.id ?? "")).toLowerCase()))
    : null;

  plan.forEach((p, i) => {
    if (!p || typeof p !== "object") return; // shape errors are validateManifest's job
    const taskLabel = p.id || p.task || `plan[${i}]`;
    const skills = Array.isArray(p.skills) ? p.skills : [];

    // Bound-skill-id-resolves check: a hallucinated or uninstalled id passes
    // validateSkillsArray's shape check (non-empty id+rationale) but was never cross-
    // checked against what's actually resolvable -- do that here, non-fatally.
    if (inventorySegments) {
      skills.forEach((s, j) => {
        if (!s || typeof s.id !== "string" || !s.id.trim()) return; // shape errors handled by validateManifest
        if (!inventorySegments.has(lastColonSegment(s.id).toLowerCase())) {
          warnings.push(
            `plan task "${taskLabel}".skills[${j}].id "${s.id}": not found in resolveCapabilities().skills -- ` +
              "likely a hallucinated or uninstalled skill id (bound skills must resolve in the live inventory)."
          );
        }
      });
    }

    // Surface-mismatch check: this needs a stack signal to compare surface against,
    // and the manifest schema doesn't carry raw stack/keyword signals per task --
    // only the task's own bound skills. So this is scoped to what IS checkable from
    // manifest data alone: a task that binds a skill known to imply a ui/copy/
    // integration surface (the same groupings suggestSkillsForStack uses) but sets
    // surface explicitly to "none" told the review gate to skip a DoD check its own
    // crew composition says it needs. A task with NO surface field at all, or a
    // ui/copy/integration task-text signal with no corresponding skill bound, is a
    // real gap this cannot catch (no per-task stack signal lives in the manifest) --
    // see plugin/skills/router/SKILL.md's Surface assignment note for that residual limit.
    if (p.surface === "none") {
      const implied = [...new Set(
        skills
          .map((s) => (s && typeof s.id === "string" ? impliedSurfaceForSkillId(s.id) : null))
          .filter(Boolean)
      )];
      if (implied.length > 0) {
        warnings.push(
          `plan task "${taskLabel}": binds skill(s) implying surface ${implied.join("/")} but surface is set to ` +
            `"none" -- the review gate's ${implied.join("/")} definition-of-done check(s) will be skipped.`
        );
      }
    }
  });

  return warnings;
}
