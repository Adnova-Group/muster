import { createHash } from "node:crypto";

const LANES = new Set(["spawn_agent", "exec-process"]);
const BASE_SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const CONTEXT_FIELDS = ["cwd", "baseSha", "codexVersion"];

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`createCodexFixLoopBinding: ${field} is required`);
  }
  return value;
}

export function createCodexFixLoopBinding({
  lane, workerId, threadId, cwd, baseSha, codexVersion, roleProfile
} = {}) {
  if (!LANES.has(lane)) {
    throw new Error("createCodexFixLoopBinding: lane must be spawn_agent or exec-process");
  }
  const identity = lane === "spawn_agent"
    ? { workerId: requiredString(workerId, "workerId") }
    : { threadId: requiredString(threadId, "threadId") };
  const binding = {
    lane,
    ...identity,
    cwd: requiredString(cwd, "cwd"),
    baseSha: requiredString(baseSha, "baseSha"),
    codexVersion: requiredString(codexVersion, "codexVersion"),
    roleProfile: fingerprintCodexRoleProfile(roleProfile)
  };
  if (!BASE_SHA_RE.test(binding.baseSha)) {
    throw new Error("createCodexFixLoopBinding: baseSha must be an exact 40- or 64-character hex SHA");
  }
  return Object.freeze(binding);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fingerprintCodexRoleProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error("fingerprintCodexRoleProfile: resolved role profile object is required");
  }
  const id = requiredString(profile.id, "roleProfile.id");
  const resolved = Object.fromEntries(Object.entries(profile).filter(([key]) => key !== "fingerprint"));
  return Object.freeze({
    id,
    fingerprint: createHash("sha256").update(canonicalJson(resolved)).digest("hex")
  });
}

function normalizeBlockers(blockers, label) {
  if (!Array.isArray(blockers)) {
    throw new Error(`planCodexFixContinuation: ${label} must be an array`);
  }
  return blockers.map((blocker, index) => {
    if (typeof blocker !== "string" || !blocker.trim()) {
      throw new Error(`planCodexFixContinuation: ${label} ${index + 1} must be a non-empty string`);
    }
    return blocker.trim();
  });
}

function blockerDelta(reviewState) {
  if (!reviewState || typeof reviewState !== "object") {
    throw new Error("planCodexFixContinuation: retained review state is required");
  }
  const sent = new Set(normalizeBlockers(reviewState.sentBlockers ?? [], "sentBlockers"));
  const current = normalizeBlockers(reviewState.currentBlockers, "currentBlockers");
  const normalized = current.filter(blocker => !sent.has(blocker));
  if (normalized.length === 0) {
    throw new Error("planCodexFixContinuation: at least one new blocker delta is required");
  }
  return { blockers: normalized, message: normalized.map(blocker => `- ${blocker}`).join("\n") };
}

export function planCodexFixContinuation({ binding, current, reviewState } = {}) {
  if (!binding || !LANES.has(binding.lane)) {
    throw new Error("planCodexFixContinuation: a retained fix-loop binding is required");
  }
  if (!current || typeof current !== "object") {
    throw new Error("planCodexFixContinuation: current context is required");
  }
  for (const field of CONTEXT_FIELDS) {
    if (current[field] !== binding[field]) {
      throw new Error(`planCodexFixContinuation: ${field} mismatch; refuse cross-context continuation`);
    }
  }
  const currentProfile = fingerprintCodexRoleProfile(current.roleProfile);
  if (currentProfile.id !== binding.roleProfile.id || currentProfile.fingerprint !== binding.roleProfile.fingerprint) {
    throw new Error("planCodexFixContinuation: roleProfile mismatch; refuse cross-context continuation");
  }
  const delta = blockerDelta(reviewState);
  if (binding.lane === "spawn_agent") {
    return {
      mechanism: "followup_task",
      target: binding.workerId,
      ...delta,
      args: { target: binding.workerId, message: delta.message }
    };
  }
  return {
    mechanism: "exec-resume",
    target: binding.threadId,
    ...delta,
    command: "codex",
    argv: ["exec", "resume", "--json", binding.threadId, delta.message],
    cwd: binding.cwd
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function reduction(before, after) {
  return before === 0 ? 0 : ((before - after) / before) * 100;
}

export function benchmarkCodexFixLoops(cases = []) {
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error("benchmarkCodexFixLoops: at least one case is required");
  }
  const measured = cases.map((entry, index) => {
    if (entry?.fresh?.type !== "turn.completed" || entry?.continued?.type !== "turn.completed") {
      throw new Error(`benchmarkCodexFixLoops: case ${index + 1} requires fresh and continued turn.completed evidence`);
    }
    return {
      freshInputTokens: entry.fresh.usage?.input_tokens,
      continuedInputTokens: entry.continued.usage?.input_tokens,
      freshTimeMs: entry.fresh.wallTimeMs,
      continuedTimeMs: entry.continued.wallTimeMs
    };
  });
  const fields = ["freshInputTokens", "continuedInputTokens", "freshTimeMs", "continuedTimeMs"];
  for (const [index, entry] of measured.entries()) {
    for (const field of fields) {
      if (!Number.isFinite(entry[field]) || entry[field] < 0) {
        throw new Error(`benchmarkCodexFixLoops: case ${index + 1} ${field} must be a non-negative number`);
      }
    }
  }
  const medianFreshInputTokens = median(measured.map(entry => entry.freshInputTokens));
  const medianContinuedInputTokens = median(measured.map(entry => entry.continuedInputTokens));
  const medianFreshTimeMs = median(measured.map(entry => entry.freshTimeMs));
  const medianContinuedTimeMs = median(measured.map(entry => entry.continuedTimeMs));
  return {
    caseCount: cases.length,
    medianFreshInputTokens,
    medianContinuedInputTokens,
    medianInputTokenReductionPct: reduction(medianFreshInputTokens, medianContinuedInputTokens),
    medianFreshTimeMs,
    medianContinuedTimeMs,
    medianTimeToFixReductionPct: reduction(medianFreshTimeMs, medianContinuedTimeMs)
  };
}
