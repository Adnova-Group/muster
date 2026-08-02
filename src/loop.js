// Progress-aware lifecycle controller. Hard iteration ceilings remain available as
// explicit policy, but ordinary work is bounded by a configurable no-progress
// streak instead of an arbitrary global attempt count.
export function loopState({ iteration = 0, maxIterations = Number.POSITIVE_INFINITY, done = false }) {
  if (done) return { continue: false, reason: "done" };
  if (iteration >= maxIterations) return { continue: false, reason: "max-iterations" };
  return { continue: true, reason: "iterate" };
}

export const DEFAULT_NO_PROGRESS_LIMIT = 2;
export const MAX_RECOVERY_CONTINUATIONS = 100;
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
  maxContinuations = MAX_RECOVERY_CONTINUATIONS,
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
  if (!Number.isInteger(maxContinuations) || maxContinuations < 1 || maxContinuations > MAX_RECOVERY_CONTINUATIONS) {
    throw new TypeError(`maxContinuations must be an integer from 1 to ${MAX_RECOVERY_CONTINUATIONS}`);
  }
  const noProgressCount = trailingIdenticalCount(outcomes);
  if (noProgressCount >= noProgressLimit) return { continue: false, reason: "no-progress", noProgressCount };
  if (outcomes.length >= maxContinuations) return { continue: false, reason: "max-continuations", noProgressCount };
  return { continue: true, reason: "progress", noProgressCount };
}

export function reviewGateState(options = {}) {
  return progressAwareState(options);
}

export function specGateRecoveryState({ rounds = [], done: callerDone, ...options } = {}) {
  if (callerDone !== undefined) throw new TypeError("spec gate completion is derived from an explicit independent PASS, not caller input");
  if (!Array.isArray(rounds) || rounds.some((round) => !round || typeof round !== "object"
    || !/^[0-9a-f]{64}$/.test(round.candidateFingerprint ?? "")
    || !["PASS", "FAIL"].includes(round.verdict)
    || typeof round.reviewer !== "string" || !round.reviewer
    || !/^[0-9a-f]{64}$/.test(round.evidenceDigest ?? "")
    || !Array.isArray(round.findings)
    || (round.verdict === "PASS" ? round.findings.length !== 0 : round.findings.length === 0))) {
    throw new TypeError("rounds must carry candidate fingerprint, independent reviewer, evidence digest, explicit verdict, and verdict-consistent findings");
  }
  const latest = rounds.at(-1);
  if (!latest) {
    return { continue: true, reason: "initial", noProgressCount: 0, action: { type: "independent-spec-review" } };
  }
  if (latest.verdict === "PASS") {
    const invalidatedSameCandidate = rounds.slice(0, -1).some((round) =>
      round.verdict === "FAIL" && round.candidateFingerprint === latest.candidateFingerprint);
    if (invalidatedSameCandidate) {
      return { continue: false, reason: "no-progress", noProgressCount: 2, findings: [] };
    }
    return { continue: false, reason: "done", noProgressCount: 0, findings: [] };
  }
  const state = progressAwareState({
    ...options,
    done: false,
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
