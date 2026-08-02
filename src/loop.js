// Ralph-loop controller (the Ralph Wiggum technique): keep iterating an outcome until its success
// criteria are GENUINELY met (`done`), or the max-iterations cap is hit (then stop + escalate — never
// loop forever, never declare done falsely). The "self-reference" is that each iteration sees prior
// work in files + the run STATE.
export const TASK_MAX_ITERATIONS = 100;
export function loopState(options = {}) {
  const { iteration = 0, maxIterations = Number.POSITIVE_INFINITY, done = false } = options;
  if (done) return { continue: false, reason: "done" };
  const hasExplicitBudget = Object.hasOwn(options, "maxIterations");
  if (hasExplicitBudget
    && (!Number.isSafeInteger(maxIterations) || maxIterations < 1 || maxIterations > TASK_MAX_ITERATIONS)) {
    return { continue: false, reason: "invalid-max-iterations" };
  }
  if (iteration >= maxIterations) return { continue: false, reason: "max-iterations" };
  return { continue: true, reason: "iterate" };
}

export const DEFAULT_NO_PROGRESS_LIMIT = 2;
export const MAX_RECOVERY_CONTINUATIONS = 100;
export const TERMINAL_RECOVERY_REASONS = Object.freeze([
  "approval", "human-hold", "external-impossibility", "cancelled",
]);

function trailingIdenticalCount(outcomes) {
  if (outcomes.length === 0) return 0;
  const latest = outcomes.at(-1);
  let count = 0;
  for (let index = outcomes.length - 1; index >= 0 && outcomes[index] === latest; index -= 1) count += 1;
  return count;
}

export function progressAwareState({
  outcomes = [], done = false, terminalReason = null,
  noProgressLimit = DEFAULT_NO_PROGRESS_LIMIT,
  maxContinuations = MAX_RECOVERY_CONTINUATIONS,
} = {}) {
  if (done) return { continue: false, reason: "done", noProgressCount: 0 };
  if (terminalReason !== null) {
    if (!TERMINAL_RECOVERY_REASONS.includes(terminalReason)) {
      throw new TypeError(`invalid terminal recovery reason '${terminalReason}'`);
    }
    return { continue: false, reason: terminalReason, noProgressCount: 0 };
  }
  if (!Array.isArray(outcomes) || outcomes.some(outcome => typeof outcome !== "string" || outcome.length === 0)) {
    throw new TypeError("outcomes must be an array of non-empty fingerprint strings");
  }
  if (!Number.isInteger(noProgressLimit) || noProgressLimit < 1) {
    throw new TypeError("noProgressLimit must be a positive integer");
  }
  if (!Number.isInteger(maxContinuations) || maxContinuations < 1 || maxContinuations > MAX_RECOVERY_CONTINUATIONS) {
    throw new TypeError(`maxContinuations must be an integer from 1 to ${MAX_RECOVERY_CONTINUATIONS}`);
  }
  const noProgressCount = trailingIdenticalCount(outcomes);
  if (noProgressCount >= noProgressLimit) return { continue: false, reason: "no-progress", noProgressCount };
  if (outcomes.length >= maxContinuations) return { continue: false, reason: "max-continuations", noProgressCount };
  return { continue: true, reason: "progress", noProgressCount };
}

// Progress must be a strictly increasing finite score, not merely a different fingerprint. That
// prevents alternating failures from resetting a budget forever. Callers derive the score from
// concrete evidence (for example, resolved blockers); absent/flat/regressing scores consume budget.
function madeProgress({ progress, previousProgress }) {
  return Number.isFinite(progress) &&
    Number.isFinite(previousProgress) &&
    progress > previousProgress;
}

// The review-gate's default no-progress budget is 3 iterations. Callers may set an explicit
// budget for a task; a strictly improving progress score can exceed it because the score proves the
// fix loop is converging rather than alternating or repeating failures.
export const REVIEW_GATE_MAX_ITERATIONS = 3;
export const REVIEW_GATE_MAX_TOTAL_ITERATIONS = 12;
export function reviewGateState(options = {}) {
  if (Object.hasOwn(options, "outcomes") || Object.hasOwn(options, "terminalReason")
    || Object.hasOwn(options, "noProgressLimit") || Object.hasOwn(options, "maxContinuations")) {
    return progressAwareState(options);
  }
  const {
  iteration,
  done = false,
  maxIterations = REVIEW_GATE_MAX_ITERATIONS,
  progress,
  previousProgress,
  } = options;
  if (done) return { continue: false, reason: "done" };
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 1 || maxIterations > REVIEW_GATE_MAX_TOTAL_ITERATIONS) {
    return { continue: false, reason: "invalid-max-iterations" };
  }
  if (iteration >= REVIEW_GATE_MAX_TOTAL_ITERATIONS) {
    return { continue: false, reason: "max-total-iterations" };
  }
  if (madeProgress({ progress, previousProgress })) {
    return { continue: true, reason: "progress" };
  }
  return loopState({ iteration, maxIterations, done });
}

export function specGateRecoveryState({ rounds = [], done: callerDone, ...options } = {}) {
  if (callerDone !== undefined) throw new TypeError("spec gate completion is derived from an explicit independent PASS, not caller input");
  if (!Array.isArray(rounds) || rounds.some(round => !round || typeof round !== "object"
    || !/^[0-9a-f]{64}$/.test(round.candidateFingerprint ?? "")
    || !["PASS", "FAIL"].includes(round.verdict)
    || typeof round.reviewer !== "string" || !round.reviewer
    || !/^[0-9a-f]{64}$/.test(round.evidenceDigest ?? "")
    || !Array.isArray(round.findings)
    || (round.verdict === "PASS" ? round.findings.length !== 0 : round.findings.length === 0))) {
    throw new TypeError("rounds must carry candidate fingerprint, independent reviewer, evidence digest, explicit verdict, and verdict-consistent findings");
  }
  const latest = rounds.at(-1);
  if (!latest) return { continue: true, reason: "initial", noProgressCount: 0,
    action: { type: "independent-spec-review" } };
  if (latest.verdict === "PASS") {
    const invalidatingRound = rounds.slice(0, -1).findLast(round =>
      round.verdict === "FAIL" && round.candidateFingerprint === latest.candidateFingerprint);
    if (invalidatingRound) return { continue: false, reason: "no-progress", noProgressCount: 2,
      findings: invalidatingRound.findings, evidenceDigest: invalidatingRound.evidenceDigest };
    return { continue: false, reason: "done", noProgressCount: 0, findings: [] };
  }
  const state = progressAwareState({ ...options, done: false,
    outcomes: rounds.map(round => round.candidateFingerprint) });
  if (!state.continue) return { ...state, findings: latest.findings };
  return { ...state, action: {
    type: "correction-replan", invalidateCandidate: latest.candidateFingerprint,
    findings: latest.findings, requireMaterialChange: true, next: "independent-spec-review",
  } };
}

// Dispatch defaults to 2 attempts. Callers may configure a larger transient-failure budget; a
// strictly improving progress score can also extend it without hiding a repeated fault.
export const DISPATCH_MAX_ATTEMPTS = 2;
export const DISPATCH_MAX_TOTAL_ATTEMPTS = 5;
export function dispatchRetryState(options = {}) {
  if (Object.hasOwn(options, "outcomes") || Object.hasOwn(options, "terminalReason")
    || Object.hasOwn(options, "noProgressLimit") || Object.hasOwn(options, "maxContinuations")) {
    const { succeeded = false, ...recovery } = options;
    const state = progressAwareState({ ...recovery, done: succeeded });
    return { retry: state.continue, reason: succeeded ? "succeeded" : state.reason,
      noProgressCount: state.noProgressCount };
  }
  const {
  attempt,
  succeeded = false,
  maxAttempts = DISPATCH_MAX_ATTEMPTS,
  progress,
  previousProgress,
  } = options;
  if (succeeded) return { retry: false, reason: "succeeded" };
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > DISPATCH_MAX_TOTAL_ATTEMPTS) {
    return { retry: false, reason: "invalid-max-attempts" };
  }
  if (attempt >= DISPATCH_MAX_TOTAL_ATTEMPTS) {
    return { retry: false, reason: "max-total-attempts" };
  }
  if (madeProgress({ progress, previousProgress })) {
    return { retry: true, reason: "progress" };
  }
  if (attempt < maxAttempts) return { retry: true, reason: "retry" };
  return { retry: false, reason: "attempts-exhausted" };
}
