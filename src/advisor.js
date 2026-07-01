// advisor.js — pure advisor-core: validators + budget decision (wave 1).
//
// Pure functions, no LLM calls, no Math.random / Date.now, no file I/O.
// I/O (STATE ledger append) is the orchestrator's job in wave 2.

// ---------------------------------------------------------------------------
// validateAdviceRequest
// ---------------------------------------------------------------------------

/**
 * Validate an advice request object, sibling to validateFusionMap (fusion.js).
 * Returns { ok: boolean, errors: string[] }.
 *
 * Required: question (non-empty string), context (string), decisionType (string).
 * Optional: options (array).
 */
export function validateAdviceRequest(req) {
  if (!req || typeof req !== "object" || Array.isArray(req)) {
    return { ok: false, errors: ["request: must be a non-null, non-array object"] };
  }
  const errors = [];
  if (!("question" in req)) {
    errors.push("question: required field is missing");
  } else if (typeof req.question !== "string" || req.question.trim() === "") {
    errors.push("question: must be a non-empty string");
  }
  if (!("context" in req)) {
    errors.push("context: required field is missing");
  } else if (typeof req.context !== "string") {
    errors.push("context: must be a string");
  }
  if (!("decisionType" in req)) {
    errors.push("decisionType: required field is missing");
  } else if (typeof req.decisionType !== "string") {
    errors.push("decisionType: must be a string");
  }
  if ("options" in req && !Array.isArray(req.options)) {
    errors.push("options: must be an array when present");
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// validateAdviceResponse
// ---------------------------------------------------------------------------

/**
 * Validate an advice response object.
 * Returns { ok: boolean, errors: string[] }.
 *
 * Required: recommendation (non-empty string), rationale (string).
 */
export function validateAdviceResponse(res) {
  if (!res || typeof res !== "object" || Array.isArray(res)) {
    return { ok: false, errors: ["response: must be a non-null, non-array object"] };
  }
  const errors = [];
  if (!("recommendation" in res)) {
    errors.push("recommendation: required field is missing");
  } else if (typeof res.recommendation !== "string" || res.recommendation.trim() === "") {
    errors.push("recommendation: must be a non-empty string");
  }
  if (!("rationale" in res)) {
    errors.push("rationale: required field is missing");
  } else if (typeof res.rationale !== "string") {
    errors.push("rationale: must be a string");
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// consultBudget — mirrors loopState (loop.js) cap pattern
// ---------------------------------------------------------------------------

/**
 * Read the max-consults limit from env.
 * Default: 3. 0 = never-consult (budget immediately exhausted).
 * Negatives are invalid and clamp to the default 3.
 * Same guard as fuse's minDisagreementThreshold: Number.isFinite && n >= 0.
 */
function maxConsultsLimit() {
  const raw = process.env.MUSTER_ADVISOR_MAX_CONSULTS;
  if (raw !== undefined && raw !== "") {
    const n = parseInt(raw, 10);
    // 0 = never-consult (consults < 0 is never true so consult is always false);
    // negatives are invalid and clamp to default.
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 3;
}

/**
 * Budget decision for advisor consults.
 * Pattern mirrors loopState (src/loop.js): cap IS the contract.
 *
 * @param {{ consults: number, maxConsults?: number }} opts
 *   consults    — number of consults already made this run
 *   maxConsults — override the env/default cap (caller-supplied)
 *
 * @returns {{ consult: boolean, reason: string }}
 *   { consult: true,  reason: 'consult'          } while consults < maxConsults
 *   { consult: false, reason: 'budget-exhausted' } when cap is hit or exceeded
 */
export function consultBudget({ consults, maxConsults = maxConsultsLimit() }) {
  if (consults < maxConsults) return { consult: true, reason: "consult" };
  return { consult: false, reason: "budget-exhausted" };
}
