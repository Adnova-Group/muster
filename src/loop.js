// Progress-aware lifecycle controller. Hard iteration ceilings remain available as
// explicit policy, but ordinary work is bounded by a configurable no-progress
// streak instead of an arbitrary global attempt count.
export function loopState({ iteration = 0, maxIterations = Number.POSITIVE_INFINITY, done = false }) {
  if (done) return { continue: false, reason: "done" };
  if (iteration >= maxIterations) return { continue: false, reason: "max-iterations" };
  return { continue: true, reason: "iterate" };
}

export const DEFAULT_NO_PROGRESS_LIMIT = 2;
export const TERMINAL_RECOVERY_REASONS = Object.freeze([
  "approval",
  "human-hold",
  "external-impossibility",
  "cancelled",
]);

function trailingIdenticalCount(outcomes) {
  if (outcomes.length === 0) return 0;
  const latest = outcomes.at(-1);
  let count = 0;
  for (let index = outcomes.length - 1; index >= 0 && outcomes[index] === latest; index -= 1) count += 1;
  return count;
}

export function progressAwareState({
  outcomes = [],
  done = false,
  terminalReason = null,
  noProgressLimit = DEFAULT_NO_PROGRESS_LIMIT,
  maxContinuations = Number.POSITIVE_INFINITY,
} = {}) {
  if (done) return { continue: false, reason: "done", noProgressCount: 0 };
  if (terminalReason !== null) {
    if (!TERMINAL_RECOVERY_REASONS.includes(terminalReason)) throw new TypeError(`invalid terminal recovery reason '${terminalReason}'`);
    return { continue: false, reason: terminalReason, noProgressCount: 0 };
  }
  if (!Array.isArray(outcomes) || outcomes.some((outcome) => typeof outcome !== "string" || outcome.length === 0)) {
    throw new TypeError("outcomes must be an array of non-empty fingerprint strings");
  }
  if (!Number.isInteger(noProgressLimit) || noProgressLimit < 1) {
    throw new TypeError("noProgressLimit must be a positive integer");
  }
  if (!(maxContinuations === Number.POSITIVE_INFINITY || (Number.isInteger(maxContinuations) && maxContinuations >= 0))) {
    throw new TypeError("maxContinuations must be a non-negative integer or Infinity");
  }
  const noProgressCount = trailingIdenticalCount(outcomes);
  if (noProgressCount >= noProgressLimit) return { continue: false, reason: "no-progress", noProgressCount };
  if (outcomes.length >= maxContinuations) return { continue: false, reason: "max-continuations", noProgressCount };
  return { continue: true, reason: "progress", noProgressCount };
}

export function reviewGateState(options = {}) {
  return progressAwareState(options);
}

export function specGateRecoveryState({ rounds = [], ...options } = {}) {
  if (!Array.isArray(rounds) || rounds.some((round) => !round || typeof round !== "object"
    || typeof round.candidateFingerprint !== "string" || !round.candidateFingerprint
    || !Array.isArray(round.findings))) {
    throw new TypeError("rounds must carry a candidateFingerprint and structured findings");
  }
  const latest = rounds.at(-1);
  if (latest && latest.findings.length === 0) {
    return { continue: false, reason: "done", noProgressCount: 0, findings: [] };
  }
  const state = progressAwareState({
    ...options,
    outcomes: rounds.map((round) => round.candidateFingerprint),
  });
  if (!state.continue) return { ...state, findings: latest?.findings ?? [] };
  return {
    ...state,
    action: {
      type: "correction-replan",
      invalidateCandidate: latest.candidateFingerprint,
      findings: latest.findings,
      requireMaterialChange: true,
      next: "independent-spec-review",
    },
  };
}

export function dispatchRetryState({ succeeded = false, ...options } = {}) {
  const state = progressAwareState({ ...options, done: succeeded });
  return {
    retry: state.continue,
    reason: succeeded ? "succeeded" : state.reason,
    noProgressCount: state.noProgressCount,
  };
}
