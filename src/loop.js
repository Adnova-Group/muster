// Ralph-loop controller (the Ralph Wiggum technique): keep iterating an outcome until its success
// criteria are GENUINELY met (`done`), or the max-iterations cap is hit (then stop + escalate — never
// loop forever, never declare done falsely). The "self-reference" is that each iteration sees prior
// work in files + the run STATE.
export function loopState({ iteration, maxIterations = 25, done = false }) {
  if (done) return { continue: false, reason: "done" };
  if (iteration >= maxIterations) return { continue: false, reason: "max-iterations" };
  return { continue: true, reason: "iterate" };
}

// The review-gate fix-loop is capped at 3 iterations — this cap IS the contract (prose in
// plugin/skills/review-gate/SKILL.md points here). The caller cannot raise it: a higher caller-
// supplied maxIterations is silently dropped so the contract cannot be accidentally widened.
export const REVIEW_GATE_MAX_ITERATIONS = 3;
export function reviewGateState({ iteration, done = false }) {
  return loopState({ iteration, maxIterations: REVIEW_GATE_MAX_ITERATIONS, done });
}

// The dispatch retry loop is capped at 2 attempts — this cap IS the contract (prose in
// plugin/skills/orchestrator/SKILL.md points here). The caller cannot raise it: there is no
// maxAttempts param so the contract cannot be accidentally widened.
export const DISPATCH_MAX_ATTEMPTS = 2;
export function dispatchRetryState({ attempt, succeeded = false }) {
  if (succeeded) return { retry: false, reason: "succeeded" };
  if (attempt < DISPATCH_MAX_ATTEMPTS) return { retry: true, reason: "retry" };
  return { retry: false, reason: "attempts-exhausted" };
}
