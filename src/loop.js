// Ralph-loop controller (the Ralph Wiggum technique): keep iterating an outcome until its success
// criteria are GENUINELY met (`done`), or the max-iterations cap is hit (then stop + escalate — never
// loop forever, never declare done falsely). The "self-reference" is that each iteration sees prior
// work in files + the run STATE.
export const TASK_MAX_ITERATIONS = 100;
export function loopState({ iteration, maxIterations = 25, done = false }) {
  if (done) return { continue: false, reason: "done" };
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 1 || maxIterations > TASK_MAX_ITERATIONS) {
    return { continue: false, reason: "invalid-max-iterations" };
  }
  if (iteration >= maxIterations) return { continue: false, reason: "max-iterations" };
  return { continue: true, reason: "iterate" };
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
export function reviewGateState({
  iteration,
  done = false,
  maxIterations = REVIEW_GATE_MAX_ITERATIONS,
  progress,
  previousProgress,
}) {
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

// Dispatch defaults to 2 attempts. Callers may configure a larger transient-failure budget; a
// strictly improving progress score can also extend it without hiding a repeated fault.
export const DISPATCH_MAX_ATTEMPTS = 2;
export const DISPATCH_MAX_TOTAL_ATTEMPTS = 5;
export function dispatchRetryState({
  attempt,
  succeeded = false,
  maxAttempts = DISPATCH_MAX_ATTEMPTS,
  progress,
  previousProgress,
}) {
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
