// Parse a sprint backlog (markdown checklist) into dependency-ordered execution waves.
//
// Only unchecked `- [ ] ` lines are items. Annotations of the form `{key: value}` are
// recognized ONLY in the trailing annotation block -- a run of one or more `{key: value}`
// groups, separated by nothing but whitespace, running all the way to the end of the
// line. That trailing run is stripped to produce the item text; any `{...}`-shaped text
// earlier in the line (followed by non-annotation prose before the line ends) is LITERAL
// item text, not a parseable annotation. This is deliberate, not an accident of the
// grammar: an item's own prose is attacker-controlled free text (e.g. "Rename the
// {disposition: merge-push} flag"), and a naive "brace pattern anywhere on the line"
// parse would let that prose forge a real annotation (a disposition, a claim, an escalation)
// purely by containing the right-looking substring. Anchoring recognition to the trailing
// block closes that off: only annotations a human/tool deliberately appended at the end of
// the line are ever live.
//
// Recognized keys:
//   {id: token}                 explicit id (kebab/alnum token); default is the
//                                synthetic `item-<lineNo>` (1-based file line)
//   {deps: a,b} | {deps: none}  explicit dependency list, or explicit "no deps"
//   {disposition: merge-local|merge-push|pr|keep|ask}
//   {escalated: ...}            presence marks the item escalated (bool in output;
//                                the annotation's value is a free-text reason, discarded)
//   {claimed: runner@ts}        coordination claim; the raw runner-string value is
//                                surfaced verbatim as items[id].claimed, or null if absent
//
// Dependency semantics (pinned): an item WITHOUT a {deps} annotation implicitly
// depends on EVERY item above it in the file, regardless of id — the default is
// "wait for everything parsed so far". `{deps: none}` opts out explicitly;
// `{deps: a,b}` names exactly those ids.
//
// Reuses wave.js's computeWaves for the topological sort itself, plus its
// duplicate-id / unknown-dep / cycle detection (all three throw there); those throws
// are caught here and turned into { ok:false, errors:[...] } instead of propagating,
// so this stays a pure function any caller (CLI or otherwise) can use without a
// try/catch of its own.
import { createHash } from "node:crypto";
import { computeWaves } from "./wave.js";
import { execFileSync } from "node:child_process";

export const SPRINT_PARALLEL_DEFAULT = 5;
export const SPRINT_PARALLEL_MAX = 10;

const CHECKBOX_RE = /^- \[ \] (.*)$/;
const CHECKED_CHECKBOX_RE = /^- \[[xX]\] (.*)$/;

// {id} tokens must be kebab/alnum: a letter or digit, then letters/digits/hyphens.
const ID_TOKEN_RE = /^[a-z0-9][a-z0-9-]*$/i;

// Fresh RegExp per call (both here and in the exec loop below) — a shared global
// regex object carries `lastIndex` state across calls, which is an easy source of
// skipped/duplicated matches when the same pattern is reused for both exec and replace.
function annotationRegex() {
  return /\{\s*([A-Za-z][\w-]*)\s*:\s*([^}]*)\}/g;
}

function annotationOpeningAt(text, start, end) {
  if (text[start] !== "{") return false;
  let cursor = start + 1;
  while (cursor < end && /\s/.test(text[cursor])) cursor += 1;
  if (cursor >= end || !/[A-Za-z]/.test(text[cursor])) return false;
  cursor += 1;
  while (cursor < end && /[\w-]/.test(text[cursor])) cursor += 1;
  while (cursor < end && /\s/.test(text[cursor])) cursor += 1;
  return cursor < end && text[cursor] === ":";
}

// Return the start of the maximal trailing annotation block in linear time.
// Each backward iteration consumes one disjoint `}`-delimited segment; within
// that segment the first syntactically valid opener is the same leftmost match
// the former regex selected. This avoids the regex's quadratic retry behavior
// on repeated incomplete `{a:` fragments.
function trailingAnnotationBlockStart(text) {
  let end = text.length;
  while (end > 0 && /\s/.test(text[end - 1])) end -= 1;
  if (end === 0 || text[end - 1] !== "}") return null;
  let suffixStart = null;
  for (;;) {
    const close = end - 1;
    const previousClose = text.lastIndexOf("}", close - 1);
    const segmentStart = previousClose + 1;
    let opener = -1;
    for (let cursor = segmentStart; cursor < close; cursor += 1) {
      if (text[cursor] === "{" && annotationOpeningAt(text, cursor, close)) {
        opener = cursor;
        break;
      }
    }
    if (opener < 0) return suffixStart;
    suffixStart = opener;
    let separatorStart = opener;
    while (separatorStart > segmentStart && /\s/.test(text[separatorStart - 1])) separatorStart -= 1;
    if (previousClose < 0 || separatorStart !== segmentStart) return suffixStart;
    end = previousClose + 1;
  }
}

export function stripAnnotations(text) {
  const anns = {};
  const annotationCounts = {};
  const annotationStart = trailingAnnotationBlockStart(text);
  const bodyText = annotationStart === null ? text : text.slice(0, annotationStart);
  const annotationBlock = annotationStart === null ? "" : text.slice(annotationStart);
  const re = annotationRegex();
  let m;
  while ((m = re.exec(annotationBlock))) {
    const key = m[1].toLowerCase();
    annotationCounts[key] = (annotationCounts[key] || 0) + 1;
    anns[key] = m[2].trim();
  }
  const stripped = bodyText.replace(/\s+/g, " ").trim();
  return { anns, annotationCounts, text: stripped };
}

function resolveParallelLimit(value, maxConcurrentThreadsPerSession) {
  const normalized = value === undefined || value === null
    ? ""
    : typeof value === "number" ? String(value) : String(value).trim();
  const parsed = /^\d+$/.test(normalized) && Number.parseInt(normalized, 10) > 0
    ? Number.parseInt(normalized, 10)
    : SPRINT_PARALLEL_DEFAULT;
  // Codex counts the root orchestrator in this session-wide ceiling. Reserve
  // that slot before deriving the child-runner cap; retain one as the safe
  // sequential scheduler fallback when the ceiling leaves no child capacity.
  const configuredCeiling = Number.isInteger(maxConcurrentThreadsPerSession) && maxConcurrentThreadsPerSession > 0
    ? Math.max(maxConcurrentThreadsPerSession - 1, 1)
    : SPRINT_PARALLEL_MAX;
  return Math.min(parsed, SPRINT_PARALLEL_MAX, configuredCeiling);
}

function chunk(ids, size) {
  const batches = [];
  for (let i = 0; i < ids.length; i += size) batches.push(ids.slice(i, i + size));
  return batches;
}

export function buildSprintSchedule(waves, items, { parallelLimit, maxConcurrentThreadsPerSession } = {}) {
  const maxConcurrency = resolveParallelLimit(parallelLimit, maxConcurrentThreadsPerSession);
  return {
    version: 1,
    buildReview: {
      eligibility: "all-ready-wave-items-regardless-of-disposition",
      isolation: "per-item-worktree",
      maxConcurrency,
      defaultMaxConcurrency: SPRINT_PARALLEL_DEFAULT,
      hardMaxConcurrency: SPRINT_PARALLEL_MAX,
    },
    barrier: "all-build-review-complete",
    integration: {
      mode: "sequential-backlog-order",
      dispositions: ["pr", "keep", "merge-local", "merge-push"],
    },
    degradation: {
      when: "parallel-dispatch-unavailable",
      buildReviewMode: "sequential-isolated",
      dependencyOrder: "preserved",
      integrationOrder: "preserved",
    },
    waves: waves.map((itemIds, index) => ({
      wave: index + 1,
      buildReview: {
        mode: "concurrent-isolated",
        itemIds: [...itemIds],
        batches: chunk(itemIds, maxConcurrency),
      },
      barrier: "all-build-review-complete",
      integration: {
        mode: "sequential-backlog-order",
        itemIds: [...itemIds],
      },
    })),
  };
}

import { progressAwareState, TERMINAL_RECOVERY_REASONS } from "./loop.js";

const SPRINT_PHASES = ["implementation", "review", "integration"];
const SPRINT_RECEIPT_STATUSES = ["completed", "failed", "cancelled"];
const FAILURE_STATES = new Set(["failed", "cancelled", "blocked"]);
const SPRINT_DISPOSITIONS = [null, "merge-local", "merge-push", "pr", "keep", "ask"];
const SPRINT_RECONCILE_PAGE_SIZE = 1_000;
const SPRINT_RECONCILE_MAX_PAGES = 100;
const CANDIDATE_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const SPRINT_RECONCILE_LIMITS = Object.freeze({
  items: SPRINT_RECONCILE_PAGE_SIZE * SPRINT_RECONCILE_MAX_PAGES,
  waves: SPRINT_RECONCILE_PAGE_SIZE * SPRINT_RECONCILE_MAX_PAGES,
  receipts: 10_000,
  inFlight: 1_000,
  idLength: 256,
  itemIdLength: 128,
  textLength: 100_000,
  attempt: 1_000_000,
});

function* paginate(values, size = SPRINT_RECONCILE_PAGE_SIZE) {
  for (let offset = 0; offset < values.length; offset += size) {
    yield* values.slice(offset, offset + size);
  }
}

function sprintPlanDigest(plan, orderedIds) {
  const canonical = {
    version: 1,
    waves: plan.waves,
    items: orderedIds.map((id) => ({ id, ...plan.items[id] })),
    schedule: plan.schedule,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalDigest(kind, fields, value) {
  return sha256(JSON.stringify([kind, ...fields.map((field) => [field, value[field]])]));
}

const RECEIPT_DIGEST_FIELDS = [
  "id", "itemId", "phase", "status", "attempt", "candidateSha", "implementationAttempt",
  "progressFingerprint", "terminalReason", "approvalDigest",
];

export function lifecycleReceiptDigest(receipt) {
  if (!isRecord(receipt)) throw new TypeError("receipt must be an object");
  return canonicalDigest("muster-lifecycle-receipt-v1", RECEIPT_DIGEST_FIELDS, {
    ...receipt,
    attempt: receipt.attempt === undefined ? 1 : receipt.attempt,
  });
}

export function buildSprintReceipt({ id, itemId, phase, status = "completed", attempt = 1,
  candidateSha, findings = [], terminalReason, implementationAttempt, approvalDigest, worktreePath, signReceipt } = {}) {
  if (!["implementation", "review", "integration"].includes(phase)) throw new TypeError("invalid sprint receipt phase");
  if (!CANDIDATE_SHA_RE.test(candidateSha ?? "")) throw new TypeError("candidateSha must be a git object id");
  if (typeof worktreePath !== "string" || !worktreePath
    || execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf8" }).trim() !== candidateSha) {
    throw new TypeError("candidateSha must be verified against the item worktree HEAD");
  }
  if (!Array.isArray(findings)) throw new TypeError("findings must be an array");
  const receipt = {
    id, itemId, phase, status, attempt, candidateSha,
    progressFingerprint: sha256(JSON.stringify(findings)),
    ...(terminalReason === undefined ? {} : { terminalReason }),
    ...(implementationAttempt === undefined ? {} : { implementationAttempt }),
    ...(approvalDigest === undefined ? {} : { approvalDigest }),
  };
  if (typeof signReceipt !== "function") throw new TypeError("trusted receipt signer is required");
  const evidence = signReceipt(lifecycleReceiptDigest(receipt));
  if (typeof evidence !== "string" || !evidence) throw new TypeError("trusted receipt signer returned no evidence");
  return { ...receipt, evidence };
}

export function integrationApprovalDigest(authorization) {
  const fields = ["itemId", "workBranch", "workHeadSha", "baseBranch", "baseHeadSha", "operation"];
  if (!isRecord(authorization) || fields.some((field) => typeof authorization[field] !== "string" || !authorization[field])) {
    throw new TypeError("authorization must carry the complete integration identity tuple");
  }
  if (!CANDIDATE_SHA_RE.test(authorization.workHeadSha) || !CANDIDATE_SHA_RE.test(authorization.baseHeadSha)) {
    throw new TypeError("authorization heads must be git object ids");
  }
  if (!["merge-local", "merge-push"].includes(authorization.operation)) throw new TypeError("authorization operation is invalid");
  const approvalFields = ["approvedBy", "approvedAt", "runId", "nonce"];
  const identityFields = approvalFields.every((field) => authorization[field] === undefined) ? [] : approvalFields;
  if (identityFields.some((field) => typeof authorization[field] !== "string" || !authorization[field]
    || /[\u0000-\u001f\u007f]/.test(authorization[field]))) {
    throw new TypeError("approval identity, freshness, run, and nonce must be supplied together without control characters");
  }
  return canonicalDigest("muster-integration-approval-v1", [...fields, ...identityFields], authorization);
}

function invalidReconciliation(errors) {
  return {
    ok: false,
    version: 1,
    errors,
    items: {},
    receipts: [],
    inFlight: [],
    actions: [],
    next: "invalid",
    wait: { eligible: false, inFlight: [] },
    terminal: false,
    escalated: false,
    terminalReason: "invalid-input",
  };
}

function sameIds(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((id, index) => id === expected[index]);
}

function validateSprintPlan(plan) {
  const errors = [];
  if (!isRecord(plan) || plan.ok !== true) return { errors: ["plan must be a successful computeSprintWaves result"] };
  if (!Array.isArray(plan.waves)) errors.push("plan.waves must be an array");
  if (!isRecord(plan.items)) errors.push("plan.items must be an object");
  if (!isRecord(plan.schedule)) errors.push("plan.schedule must be an object");
  if (errors.length > 0) return { errors };
  if (plan.waves.length > SPRINT_RECONCILE_LIMITS.waves) {
    errors.push(`plan.waves exceeds limit ${SPRINT_RECONCILE_LIMITS.waves}`);
    return { errors };
  }

  const orderedIds = [];
  const itemIds = new Set();
  const waveById = new Map();
  for (let waveIndex = 0; waveIndex < plan.waves.length; waveIndex += 1) {
    const wave = plan.waves[waveIndex];
    if (!Array.isArray(wave)) {
      errors.push(`plan.waves[${waveIndex}] must be an array`);
      continue;
    }
    if (orderedIds.length + wave.length > SPRINT_RECONCILE_LIMITS.items) {
      errors.push(`plan contains more than ${SPRINT_RECONCILE_LIMITS.items} items`);
      break;
    }
    for (const id of wave) {
      if (typeof id !== "string" || !id || id.length > SPRINT_RECONCILE_LIMITS.itemIdLength) {
        errors.push(`plan item id must be a non-empty string at most ${SPRINT_RECONCILE_LIMITS.itemIdLength} characters`);
        continue;
      }
      if (itemIds.has(id)) {
        errors.push(`duplicate plan item id '${id}'`);
        continue;
      }
      itemIds.add(id);
      orderedIds.push(id);
      waveById.set(id, waveIndex + 1);
    }
  }
  if (errors.length > 0) return { errors };

  const itemKeys = Object.keys(plan.items);
  if (itemKeys.length > SPRINT_RECONCILE_LIMITS.items) {
    errors.push(`plan.items exceeds limit ${SPRINT_RECONCILE_LIMITS.items}`);
  }
  if (itemKeys.length !== itemIds.size || itemKeys.some((id) => !itemIds.has(id))) {
    errors.push("plan.items keys must exactly match the unique ids in plan.waves");
  }
  for (const id of paginate(orderedIds)) {
    const item = plan.items[id];
    if (!isRecord(item)) {
      errors.push(`plan.items['${id}'] must be an object`);
      continue;
    }
    if (!Array.isArray(item.deps)) {
      errors.push(`plan.items['${id}'].deps must be an array`);
      continue;
    }
    if (item.deps.length > SPRINT_RECONCILE_LIMITS.items) {
      errors.push(`plan.items['${id}'].deps exceeds limit ${SPRINT_RECONCILE_LIMITS.items}`);
      continue;
    }
    const seenDeps = new Set();
    for (const dep of item.deps) {
      if (typeof dep !== "string" || !itemIds.has(dep)) errors.push(`plan item '${id}' names unknown dependency '${dep}'`);
      else if (seenDeps.has(dep)) errors.push(`plan item '${id}' repeats dependency '${dep}'`);
      else if (waveById.get(dep) >= waveById.get(id)) errors.push(`plan dependency '${dep}' must precede item '${id}'`);
      seenDeps.add(dep);
    }
    if (!SPRINT_DISPOSITIONS.includes(item.disposition)) {
      errors.push(`plan item '${id}' has invalid disposition '${item.disposition}'`);
    }
    if (!Number.isInteger(item.line) || item.line < 1) errors.push(`plan item '${id}' has invalid line`);
    if (typeof item.text !== "string" || item.text.length > SPRINT_RECONCILE_LIMITS.textLength) {
      errors.push(`plan item '${id}' text must be at most ${SPRINT_RECONCILE_LIMITS.textLength} characters`);
    }
    if (typeof item.escalated !== "boolean") errors.push(`plan item '${id}' escalated must be boolean`);
    if (item.claimed !== null && (typeof item.claimed !== "string" || item.claimed.length > SPRINT_RECONCILE_LIMITS.idLength)) {
      errors.push(`plan item '${id}' claimed must be null or a bounded string`);
    }
  }

  const schedule = plan.schedule;
  if (schedule.version !== 1) errors.push("plan.schedule.version must be 1");
  if (!isRecord(schedule.buildReview)) errors.push("plan.schedule.buildReview must be an object");
  if (!isRecord(schedule.integration)) errors.push("plan.schedule.integration must be an object");
  if (!isRecord(schedule.degradation)) errors.push("plan.schedule.degradation must be an object");
  if (schedule.barrier !== "all-build-review-complete") errors.push("plan.schedule.barrier is invalid");
  if (!Array.isArray(schedule.waves)) errors.push("plan.schedule.waves must be an array");
  const cap = schedule.buildReview?.maxConcurrency;
  if (!Number.isInteger(cap) || cap < 1 || cap > SPRINT_PARALLEL_MAX) {
    errors.push(`plan.schedule.buildReview.maxConcurrency must be an integer from 1 to ${SPRINT_PARALLEL_MAX}`);
  }
  if (isRecord(schedule.buildReview)) {
    if (schedule.buildReview.eligibility !== "all-ready-wave-items-regardless-of-disposition") errors.push("plan.schedule.buildReview.eligibility is invalid");
    if (schedule.buildReview.isolation !== "per-item-worktree") errors.push("plan.schedule.buildReview.isolation is invalid");
    if (schedule.buildReview.defaultMaxConcurrency !== SPRINT_PARALLEL_DEFAULT) errors.push("plan.schedule.buildReview.defaultMaxConcurrency is invalid");
    if (schedule.buildReview.hardMaxConcurrency !== SPRINT_PARALLEL_MAX) errors.push("plan.schedule.buildReview.hardMaxConcurrency is invalid");
  }
  if (isRecord(schedule.integration)) {
    if (schedule.integration.mode !== "sequential-backlog-order") errors.push("plan.schedule.integration.mode is invalid");
    if (!sameIds(schedule.integration.dispositions, ["pr", "keep", "merge-local", "merge-push"])) errors.push("plan.schedule.integration.dispositions is invalid");
  }
  if (isRecord(schedule.degradation)) {
    const expected = {
      when: "parallel-dispatch-unavailable",
      buildReviewMode: "sequential-isolated",
      dependencyOrder: "preserved",
      integrationOrder: "preserved",
    };
    for (const [key, value] of Object.entries(expected)) {
      if (schedule.degradation[key] !== value) errors.push(`plan.schedule.degradation.${key} is invalid`);
    }
  }
  if (errors.length > 0) return { errors };
  if (schedule.waves.length !== plan.waves.length) errors.push("plan.schedule.waves must match plan.waves length");

  for (let waveIndex = 0; waveIndex < plan.waves.length; waveIndex += 1) {
    const expectedIds = plan.waves[waveIndex];
    const scheduled = schedule.waves[waveIndex];
    if (!isRecord(scheduled)) {
      errors.push(`plan.schedule.waves[${waveIndex}] must be an object`);
      continue;
    }
    if (scheduled.wave !== waveIndex + 1) errors.push(`plan.schedule.waves[${waveIndex}].wave must be ${waveIndex + 1}`);
    if (!isRecord(scheduled.buildReview)) errors.push(`plan.schedule.waves[${waveIndex}].buildReview must be an object`);
    if (!isRecord(scheduled.integration)) errors.push(`plan.schedule.waves[${waveIndex}].integration must be an object`);
    if (!isRecord(scheduled.buildReview) || !isRecord(scheduled.integration)) continue;
    if (scheduled.buildReview.mode !== "concurrent-isolated") errors.push(`plan.schedule.waves[${waveIndex}].buildReview.mode is invalid`);
    if (scheduled.barrier !== "all-build-review-complete") errors.push(`plan.schedule.waves[${waveIndex}].barrier is invalid`);
    if (scheduled.integration.mode !== "sequential-backlog-order") errors.push(`plan.schedule.waves[${waveIndex}].integration.mode is invalid`);
    if (!sameIds(scheduled.buildReview.itemIds, expectedIds)) {
      errors.push(`plan.schedule.waves[${waveIndex}].buildReview.itemIds must match plan wave order`);
    }
    if (!Array.isArray(scheduled.buildReview.batches)) {
      errors.push(`plan.schedule.waves[${waveIndex}].buildReview.batches must be an array`);
    } else if (scheduled.buildReview.batches.length > SPRINT_RECONCILE_LIMITS.items) {
      errors.push(`plan.schedule.waves[${waveIndex}].buildReview.batches exceeds limit ${SPRINT_RECONCILE_LIMITS.items}`);
    } else {
      const flat = [];
      for (const batch of scheduled.buildReview.batches) {
        if (!Array.isArray(batch) || batch.length < 1 || batch.length > cap) {
          errors.push(`plan.schedule.waves[${waveIndex}] contains an invalid cap-bounded batch`);
          continue;
        }
        flat.push(...batch);
      }
      if (!sameIds(flat, expectedIds)) errors.push(`plan.schedule.waves[${waveIndex}].buildReview.batches must cover the wave exactly once`);
    }
    if (!sameIds(scheduled.integration.itemIds, expectedIds)) {
      errors.push(`plan.schedule.waves[${waveIndex}].integration.itemIds must match plan wave order`);
    }
  }
  return { errors, orderedIds, itemIds, waveById };
}

function phaseKey(itemId, phase) {
  return `${itemId}\0${phase}`;
}

function strongerReceipt(current, candidate) {
  if (!current || candidate.attempt > current.attempt) return candidate;
  if (candidate.attempt < current.attempt) return current;
  const precedence = { completed: 1, cancelled: 2, failed: 3 };
  return precedence[candidate.status] > precedence[current.status] ? candidate : current;
}

function canonicalReceipts(receipts, itemIds) {
  if (!Array.isArray(receipts)) return { errors: ["receipts must be an array"], receipts: [] };
  if (receipts.length > SPRINT_RECONCILE_LIMITS.receipts) {
    return { errors: [`receipts exceeds limit ${SPRINT_RECONCILE_LIMITS.receipts}`], receipts: [] };
  }
  const errors = [];
  const byId = new Map();
  const byLogicalAttempt = new Map();
  const latestByPhase = new Map();
  const byPhase = new Map();
  for (const raw of receipts) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push("each receipt must be an object");
      continue;
    }
    const receipt = {
      id: raw.id,
      itemId: raw.itemId,
      phase: raw.phase,
      status: raw.status,
      attempt: raw.attempt === undefined ? 1 : raw.attempt,
      ...(raw.progressFingerprint === undefined ? {} : { progressFingerprint: raw.progressFingerprint }),
      ...(raw.candidateSha === undefined ? {} : { candidateSha: raw.candidateSha }),
      ...(raw.terminalReason === undefined ? {} : { terminalReason: raw.terminalReason }),
      ...(raw.approvalDigest === undefined ? {} : { approvalDigest: raw.approvalDigest }),
      ...(raw.implementationAttempt === undefined ? {} : { implementationAttempt: raw.implementationAttempt }),
      ...(raw.evidence === undefined ? {} : { evidence: raw.evidence }),
    };
    let valid = true;
    if (typeof receipt.id !== "string" || !receipt.id.trim() || receipt.id.length > SPRINT_RECONCILE_LIMITS.idLength) {
      errors.push(`receipt id must be a non-empty string at most ${SPRINT_RECONCILE_LIMITS.idLength} characters`);
      valid = false;
    }
    if (typeof receipt.itemId !== "string" || receipt.itemId.length > SPRINT_RECONCILE_LIMITS.itemIdLength || !itemIds.has(receipt.itemId)) {
      errors.push(`receipt '${receipt.id}' names unknown item '${receipt.itemId}'`);
      valid = false;
    }
    if (!SPRINT_PHASES.includes(receipt.phase)) {
      errors.push(`receipt '${receipt.id}' has invalid phase '${receipt.phase}'`);
      valid = false;
    }
    if (!SPRINT_RECEIPT_STATUSES.includes(receipt.status)) {
      errors.push(`receipt '${receipt.id}' has invalid status '${receipt.status}'`);
      valid = false;
    }
    if (!Number.isInteger(receipt.attempt) || receipt.attempt < 1 || receipt.attempt > SPRINT_RECONCILE_LIMITS.attempt) {
      errors.push(`receipt '${receipt.id}' attempt must be an integer from 1 to ${SPRINT_RECONCILE_LIMITS.attempt}`);
      valid = false;
    }
    if (receipt.progressFingerprint !== undefined && !DIGEST_RE.test(receipt.progressFingerprint)) {
      errors.push(`receipt '${receipt.id}' progressFingerprint must be a lowercase sha256 digest`);
      valid = false;
    }
    if (receipt.candidateSha !== undefined && !CANDIDATE_SHA_RE.test(receipt.candidateSha)) {
      errors.push(`receipt '${receipt.id}' candidateSha must be a lowercase git object id`);
      valid = false;
    }
    if (["implementation", "review", "integration"].includes(receipt.phase) && receipt.candidateSha === undefined) {
      errors.push(`receipt '${receipt.id}' must bind ${receipt.phase} to candidateSha`);
      valid = false;
    }
    if (receipt.phase === "review" && (!Number.isInteger(receipt.implementationAttempt)
      || receipt.implementationAttempt < 1 || receipt.implementationAttempt > SPRINT_RECONCILE_LIMITS.attempt)) {
      errors.push(`receipt '${receipt.id}' must bind review to implementationAttempt`);
      valid = false;
    }
    if (receipt.approvalDigest !== undefined && !DIGEST_RE.test(receipt.approvalDigest)) {
      errors.push(`receipt '${receipt.id}' approvalDigest must be a lowercase sha256 digest`);
      valid = false;
    }
    if (receipt.phase === "integration" && receipt.status === "completed" && receipt.approvalDigest === undefined) {
      errors.push(`receipt '${receipt.id}' must bind completed integration to approvalDigest`);
      valid = false;
    }
    if (receipt.terminalReason !== undefined && !TERMINAL_RECOVERY_REASONS.includes(receipt.terminalReason)) {
      errors.push(`receipt '${receipt.id}' has invalid terminalReason '${receipt.terminalReason}'`);
      valid = false;
    }
    if (!valid) continue;
    const normalized = { ...receipt };
    const prior = byId.get(normalized.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(normalized)) {
      errors.push(`duplicate receipt id '${normalized.id}' carries conflicting payloads`);
      continue;
    }
    if (prior) continue;
    const logicalKey = `${normalized.itemId}\0${normalized.phase}\0${normalized.attempt}`;
    const priorLogical = byLogicalAttempt.get(logicalKey);
    if (priorLogical && JSON.stringify(priorLogical) !== JSON.stringify(normalized)) {
      errors.push(`item '${normalized.itemId}' phase '${normalized.phase}' attempt ${normalized.attempt} has conflicting receipts`);
      continue;
    }
    byId.set(normalized.id, normalized);
    byLogicalAttempt.set(logicalKey, normalized);
    latestByPhase.set(phaseKey(normalized.itemId, normalized.phase),
      strongerReceipt(latestByPhase.get(phaseKey(normalized.itemId, normalized.phase)), normalized));
    const key = phaseKey(normalized.itemId, normalized.phase);
    const phaseReceipts = byPhase.get(key) ?? [];
    phaseReceipts.push(normalized);
    byPhase.set(key, phaseReceipts);
  }
  return {
    errors,
    receipts: [...byId.values()].sort((a, b) =>
      a.itemId.localeCompare(b.itemId)
      || SPRINT_PHASES.indexOf(a.phase) - SPRINT_PHASES.indexOf(b.phase)
      || a.attempt - b.attempt
      || a.id.localeCompare(b.id)),
    latestByPhase,
    byPhase,
  };
}

function canonicalInFlight(inFlight, itemIds) {
  if (!Array.isArray(inFlight)) return { errors: ["inFlight must be an array"], inFlight: [] };
  if (inFlight.length > SPRINT_RECONCILE_LIMITS.inFlight) {
    return { errors: [`inFlight exceeds limit ${SPRINT_RECONCILE_LIMITS.inFlight}`], inFlight: [] };
  }
  const errors = [];
  const byPhase = new Map();
  const normalized = [];
  for (const entry of inFlight) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push("each inFlight entry must be an object");
      continue;
    }
    if (typeof entry.itemId !== "string" || entry.itemId.length > SPRINT_RECONCILE_LIMITS.itemIdLength || !itemIds.has(entry.itemId)) {
      errors.push(`inFlight entry names unknown item '${entry.itemId}'`);
      continue;
    }
    if (!SPRINT_PHASES.includes(entry.phase)) {
      errors.push(`inFlight entry for '${entry.itemId}' has invalid phase '${entry.phase}'`);
      continue;
    }
    if (!Number.isInteger(entry.attempt) || entry.attempt < 1 || entry.attempt > SPRINT_RECONCILE_LIMITS.attempt) {
      errors.push(`inFlight entry for '${entry.itemId}' attempt must be an integer from 1 to ${SPRINT_RECONCILE_LIMITS.attempt}`);
      continue;
    }
    if (["review", "integration"].includes(entry.phase) && !CANDIDATE_SHA_RE.test(entry.candidateSha ?? "")) {
      errors.push(`inFlight ${entry.phase} for '${entry.itemId}' must bind candidateSha`);
      continue;
    }
    if (entry.phase === "review" && (!Number.isInteger(entry.implementationAttempt)
      || entry.implementationAttempt < 1 || entry.implementationAttempt > SPRINT_RECONCILE_LIMITS.attempt)) {
      errors.push(`inFlight review for '${entry.itemId}' must bind implementationAttempt`);
      continue;
    }
    if (entry.phase === "integration" && !DIGEST_RE.test(entry.approvalDigest ?? "")) {
      errors.push(`inFlight integration for '${entry.itemId}' must bind approvalDigest`);
      continue;
    }
    const key = phaseKey(entry.itemId, entry.phase);
    const prior = byPhase.get(key);
    const comparable = {
      itemId: entry.itemId, phase: entry.phase, attempt: entry.attempt,
      ...(entry.candidateSha === undefined ? {} : { candidateSha: entry.candidateSha }),
      ...(entry.approvalDigest === undefined ? {} : { approvalDigest: entry.approvalDigest }),
      ...(entry.implementationAttempt === undefined ? {} : { implementationAttempt: entry.implementationAttempt }),
    };
    if (prior && JSON.stringify(prior) !== JSON.stringify(comparable)) {
      errors.push(`inFlight entry for '${entry.itemId}' phase '${entry.phase}' has conflicting identity`);
      continue;
    }
    if (!prior) {
      const value = {
        itemId: entry.itemId, phase: entry.phase, attempt: entry.attempt,
        ...(entry.candidateSha === undefined ? {} : { candidateSha: entry.candidateSha }),
        ...(entry.approvalDigest === undefined ? {} : { approvalDigest: entry.approvalDigest }),
        ...(entry.implementationAttempt === undefined ? {} : { implementationAttempt: entry.implementationAttempt }),
      };
      normalized.push(value);
      byPhase.set(key, value);
    }
  }
  return { errors, inFlight: normalized, byPhase };
}

// Pure completion-awareness transition. Adapters own dispatch and mailbox I/O;
// this function owns the executable decision about whether a wake means dispatch,
// wait, terminal, or escalated. Callers pass the complete receipts currently
// available on every wake, then dispatch every returned action before waiting again.
export function reconcileSprintProgress(plan, progress = {}, {
  verifyApproval, verifyReceipt, trustedRunId, now = Date.now(),
} = {}) {
  const planResult = validateSprintPlan(plan);
  if (planResult.errors.length > 0) return invalidReconciliation(planResult.errors);
  if (!isRecord(progress)) return invalidReconciliation(["progress must be an object"]);
  const { orderedIds, itemIds, waveById } = planResult;
  const receiptResult = canonicalReceipts(progress.receipts ?? [], itemIds);
  const inFlightResult = canonicalInFlight(progress.inFlight ?? [], itemIds);
  const errors = [...receiptResult.errors, ...inFlightResult.errors];
  for (const receipt of receiptResult.receipts) {
    if (typeof receipt.evidence !== "string" || !receipt.evidence
      || typeof verifyReceipt !== "function" || verifyReceipt(receipt, lifecycleReceiptDigest(receipt)) !== true) {
      errors.push(`receipt '${receipt.id}' lacks trusted parent evidence`);
    }
  }
  for (const receipt of receiptResult.receipts.filter((candidate) => candidate.phase === "review")) {
    const implementations = receiptResult.byPhase.get(phaseKey(receipt.itemId, "implementation")) ?? [];
    const implementation = implementations
      .find((candidate) => candidate.attempt === receipt.implementationAttempt
        && candidate.status === "completed" && candidate.candidateSha === receipt.candidateSha);
    if (implementations.length > 0 && !implementation) errors.push(`review receipt '${receipt.id}' lacks its exact implementation generation`);
  }
  if (errors.length > 0) return invalidReconciliation(errors);

  const receipts = receiptResult.receipts;
  const inFlight = inFlightResult.inFlight;
  const noProgressLimit = progress.recovery?.noProgressLimit;
  const maxContinuations = progress.recovery?.maxContinuations;
  if (progress.recovery !== undefined && (!isRecord(progress.recovery)
    || (noProgressLimit !== undefined && (!Number.isInteger(noProgressLimit) || noProgressLimit < 1))
    || (maxContinuations !== undefined && (!Number.isInteger(maxContinuations) || maxContinuations < 1 || maxContinuations > 100)))) {
    return invalidReconciliation(["progress.recovery thresholds are invalid"]);
  }
  const integrationTargets = progress.integrationTargets ?? {};
  if (!isRecord(integrationTargets)) return invalidReconciliation(["progress.integrationTargets must be an object"]);
  const approvals = progress.approvals ?? [];
  if (!Array.isArray(approvals)) return invalidReconciliation(["progress.approvals must be an array"]);
  const approvalByItem = new Map();
  const approvalNonces = new Set();
  if (approvals.length > 0 && (typeof trustedRunId !== "string" || !trustedRunId
    || /[\u0000-\u001f\u007f]/.test(trustedRunId))) {
    return invalidReconciliation(["adapter-owned trustedRunId is required for approvals"]);
  }
  const consumedApprovalDigests = new Set(receipts
    .filter((receipt) => receipt.phase === "integration" && receipt.status === "completed")
    .map((receipt) => receipt.approvalDigest));
  for (const [itemId, target] of Object.entries(integrationTargets)) {
    if (!itemIds.has(itemId) || !isRecord(target)
      || typeof target.workBranch !== "string" || !target.workBranch
      || typeof target.baseBranch !== "string" || !target.baseBranch
      || !CANDIDATE_SHA_RE.test(target.baseHeadSha ?? "")) {
      return invalidReconciliation([`integration target for '${itemId}' must bind work branch and exact base branch/head`]);
    }
  }
  for (const approval of approvals) {
    try {
      const approvedAtMs = Date.parse(approval?.approvedAt);
      if (!itemIds.has(approval?.itemId) || typeof approval.approvedBy !== "string" || !approval.approvedBy
        || !Number.isFinite(approvedAtMs)
        || (!consumedApprovalDigests.has(approval.digest) && Math.abs(now - approvedAtMs) > 15 * 60 * 1000)
        || approval.runId !== trustedRunId || typeof approval.nonce !== "string" || !approval.nonce
        || typeof approval.evidence !== "string" || !approval.evidence
        || typeof verifyApproval !== "function" || verifyApproval(approval) !== true
        || approval.digest !== integrationApprovalDigest(approval)) {
        return invalidReconciliation([`approval for '${approval?.itemId}' is not bound to its identity tuple`]);
      }
      if (approvalNonces.has(approval.nonce)) return invalidReconciliation([`approval nonce '${approval.nonce}' is reused`]);
      const priorApproval = approvalByItem.get(approval.itemId);
      if (priorApproval && JSON.stringify(priorApproval) !== JSON.stringify(approval)) {
        return invalidReconciliation([`approval for '${approval.itemId}' has conflicting identity`]);
      }
      approvalNonces.add(approval.nonce);
      approvalByItem.set(approval.itemId, approval);
    } catch (error) {
      return invalidReconciliation([error.message]);
    }
  }
  for (const receipt of receipts.filter((candidate) => candidate.phase === "integration" && candidate.status === "completed")) {
    const approval = approvalByItem.get(receipt.itemId);
    const target = integrationTargets[receipt.itemId];
    const source = plan.items[receipt.itemId];
    if (!approval || !target || approval.digest !== receipt.approvalDigest || approval.workHeadSha !== receipt.candidateSha
      || approval.workBranch !== target.workBranch || approval.baseBranch !== target.baseBranch
      || approval.baseHeadSha !== target.baseHeadSha || approval.operation !== source.disposition) {
      return invalidReconciliation([`completed integration receipt '${receipt.id}' lacks matching exact-head approval evidence`]);
    }
  }
  const phaseState = (itemId, phase, candidateSha = undefined) => {
    const activeImplementationAttempt = phase === "review" ? phaseState(itemId, "implementation")?.attempt : undefined;
    const phaseReceipts = (receiptResult.byPhase.get(phaseKey(itemId, phase)) ?? [])
      .filter((candidate) => phase === "implementation"
        || (candidateSha === undefined
          ? candidate.candidateSha === undefined
          : candidate.candidateSha === candidateSha)
          && (phase !== "review" || candidate.status === "failed"
            || candidate.implementationAttempt === activeImplementationAttempt));
    let receipt = phaseReceipts.reduce(strongerReceipt, null);
    if (phase === "review") {
      // A candidate rejected once remains rejected. A later PASS receipt cannot
      // resurrect it; only a materially different implementation SHA can.
      const invalidatingFailure = phaseReceipts.filter((candidate) => candidate.status === "failed")
        .reduce(strongerReceipt, null);
      if (invalidatingFailure) receipt = invalidatingFailure;
    }
    const flight = inFlightResult.byPhase.get(phaseKey(itemId, phase));
    if (flight && phase !== "implementation" && flight.candidateSha !== candidateSha) {
      return { status: "stale_in_flight", attempt: flight.attempt, candidateSha: flight.candidateSha };
    }
    if (flight && (!receipt || flight.attempt > receipt.attempt)) return {
      status: "in_flight", attempt: flight.attempt, candidateSha: flight.candidateSha,
      approvalDigest: flight.approvalDigest,
    };
    if (!receipt) return null;
    if (receipt.status !== "failed") return {
      status: receipt.status,
      attempt: receipt.attempt,
      terminalReason: receipt.terminalReason,
      candidateSha: receipt.candidateSha,
      implementationAttempt: receipt.implementationAttempt,
    };
    if (receipt.terminalReason) return { status: "blocked", attempt: receipt.attempt, terminalReason: receipt.terminalReason };
    const outcomes = (receiptResult.byPhase.get(phaseKey(itemId, phase)) ?? [])
      .filter((candidate) => candidate.status === "failed" && candidate.progressFingerprint)
      .sort((a, b) => a.attempt - b.attempt)
      .map((candidate) => `${candidate.candidateSha ?? "legacy"}\0${candidate.progressFingerprint}`);
    if (outcomes.length === 0) return { status: "blocked", attempt: receipt.attempt, terminalReason: "failed" };
    const recovery = progressAwareState({
      outcomes,
      ...(noProgressLimit === undefined ? {} : { noProgressLimit }),
      ...(maxContinuations === undefined ? {} : { maxContinuations }),
    });
    return recovery.continue
      ? {
        status: phase === "review" ? "repair_ready" : "ready",
        attempt: receipt.attempt + 1,
        failedAttempt: receipt.attempt,
        implementationAttempt: receipt.implementationAttempt,
        candidateSha: receipt.candidateSha,
      }
      : { status: "blocked", attempt: receipt.attempt, terminalReason: recovery.reason };
  };
  const items = {};

  for (const itemId of paginate(orderedIds)) {
    const source = plan.items[itemId];
    const deps = Array.isArray(source.deps) ? source.deps : [];
    const failedDependency = deps.find((dep) => FAILURE_STATES.has(items[dep]?.state));
    const waitingDependency = deps.find((dep) => items[dep]?.state !== "completed");
    let state;
    let blockedBy = [];

    if (failedDependency) {
      state = "blocked";
      blockedBy = deps.filter((dep) => FAILURE_STATES.has(items[dep]?.state));
    } else if (waitingDependency) {
      state = "pending";
    } else {
      const implementation = phaseState(itemId, "implementation");
      if (implementation?.status === "blocked" || implementation?.status === "cancelled") {
        state = implementation.status === "cancelled" ? "cancelled" : "blocked";
      } else if (implementation?.status !== "completed") {
        state = implementation?.status === "in_flight" ? "implementation_in_flight" : "implementation_ready";
      } else if (["merge-local", "merge-push"].includes(source.disposition) && !implementation.candidateSha) {
        state = "blocked";
      } else {
        const review = phaseState(itemId, "review", implementation.candidateSha);
        if (review?.status === "stale_in_flight") {
          state = "blocked";
        } else if (review?.status === "blocked" || review?.status === "cancelled") {
          state = review.status === "cancelled" ? "cancelled" : "blocked";
        } else if (review?.status === "repair_ready") {
          // A repair that leaves the rejected exact head unchanged is itself a
          // second identical recovery outcome and stops deterministically.
          state = implementation.attempt > review.implementationAttempt ? "blocked" : "implementation_repair_ready";
        } else if (review?.status !== "completed") {
          state = review?.status === "in_flight" ? "review_in_flight" : "review_ready";
        } else if (!["merge-local", "merge-push"].includes(source.disposition)) {
          state = "completed";
        } else {
          const integration = phaseState(itemId, "integration", implementation.candidateSha);
          if (integration?.status === "stale_in_flight") {
            state = "blocked";
          } else if (integration?.status === "blocked" || integration?.status === "cancelled") {
            state = integration.status === "cancelled" ? "cancelled" : "blocked";
          } else if (integration?.status === "completed") {
            state = "completed";
          } else {
            state = integration?.status === "in_flight" ? "integration_in_flight" : "integration_ready";
          }
        }
      }
    }

    items[itemId] = {
      state,
      wave: waveById.get(itemId),
      deps: [...deps],
      disposition: source.disposition,
      blockedBy,
      terminalReason: state === "blocked"
        ? phaseState(itemId, "integration", phaseState(itemId, "implementation")?.candidateSha)?.terminalReason
          ?? phaseState(itemId, "review", phaseState(itemId, "implementation")?.candidateSha)?.terminalReason
          ?? phaseState(itemId, "implementation")?.terminalReason
          ?? (phaseState(itemId, "review", phaseState(itemId, "implementation")?.candidateSha)?.status === "repair_ready"
            && phaseState(itemId, "implementation")?.attempt
              > phaseState(itemId, "review", phaseState(itemId, "implementation")?.candidateSha)?.implementationAttempt
            ? "no-progress" : null)
          ?? (["review", "integration"].some((phase) => phaseState(itemId, phase, phaseState(itemId, "implementation")?.candidateSha)?.status === "stale_in_flight")
            ? "stale-candidate-binding" : null)
          ?? (["merge-local", "merge-push"].includes(source.disposition) ? "missing-candidate-binding" : "failed-dependency")
        : state === "cancelled" ? "cancelled" : null,
    };
  }

  const activeInFlight = inFlight.filter(({ itemId, phase }) => items[itemId].state === `${phase}_in_flight`);
  const buildReviewActions = [];
  const priorWaveCompletion = new Map();
  let completedThroughPriorWave = true;
  for (let waveIndex = 0; waveIndex < plan.waves.length; waveIndex += 1) {
    priorWaveCompletion.set(waveIndex + 1, completedThroughPriorWave);
    completedThroughPriorWave = completedThroughPriorWave
      && plan.waves[waveIndex].every((itemId) => items[itemId].state === "completed");
  }
  const priorWavesComplete = (waveNumber) => priorWaveCompletion.get(waveNumber) === true;

  const causalErrors = [];
  for (const flight of inFlight) {
    const item = items[flight.itemId];
    const implementationState = phaseState(flight.itemId, "implementation");
    const implementationCandidate = implementationState?.candidateSha;
    if (flight.phase !== "implementation" && flight.candidateSha !== implementationCandidate) {
      causalErrors.push(`inFlight ${flight.phase} for '${flight.itemId}' is bound to a stale candidate`);
      continue;
    }
    if (flight.phase === "review" && flight.implementationAttempt !== implementationState?.attempt) {
      causalErrors.push(`inFlight review for '${flight.itemId}' is bound to a stale implementation attempt`);
      continue;
    }
    if (flight.phase === "integration") {
      const approval = approvalByItem.get(flight.itemId);
      const target = integrationTargets[flight.itemId];
      if (!approval || !target || approval.digest !== flight.approvalDigest
        || approval.workHeadSha !== flight.candidateSha || approval.workBranch !== target.workBranch
        || approval.baseBranch !== target.baseBranch || approval.baseHeadSha !== target.baseHeadSha
        || approval.operation !== plan.items[flight.itemId].disposition) {
        causalErrors.push(`inFlight integration for '${flight.itemId}' lacks matching trusted approval evidence`);
        continue;
      }
    }
    const latestReceipt = receiptResult.latestByPhase.get(phaseKey(flight.itemId, flight.phase));
    // A receipt for this attempt (or a newer one) settles the adapter's stale
    // in-flight marker; it is drained rather than treated as a causal violation.
    if (latestReceipt && flight.attempt <= latestReceipt.attempt) continue;
    if (latestReceipt?.status === "completed" && flight.attempt > latestReceipt.attempt) {
      causalErrors.push(`inFlight ${flight.phase} for '${flight.itemId}' retries an already completed phase`);
      continue;
    }
    if (item.state !== `${flight.phase}_in_flight`) {
      const prerequisite = flight.phase === "review" ? "completed implementation"
        : flight.phase === "integration" ? "completed review and eligible integration barrier"
        : "completed dependencies and prior waves";
      causalErrors.push(`inFlight ${flight.phase} for '${flight.itemId}' lacks ${prerequisite}`);
      continue;
    }
    if (!priorWavesComplete(item.wave)) causalErrors.push(`inFlight ${flight.phase} for '${flight.itemId}' started before prior waves completed`);
    if (flight.phase === "integration") {
      const waveSchedule = plan.schedule.waves[item.wave - 1];
      const barrierPassed = waveSchedule.buildReview.itemIds.every((id) =>
        items[id].state === "completed"
        || items[id].state === "integration_ready"
        || items[id].state === "integration_in_flight");
      const integrationIndex = waveSchedule.integration.itemIds.indexOf(flight.itemId);
      const predecessorsComplete = integrationIndex >= 0
        && waveSchedule.integration.itemIds.slice(0, integrationIndex).every((id) => items[id].state === "completed");
      if (!barrierPassed || !predecessorsComplete) {
        causalErrors.push(`inFlight integration for '${flight.itemId}' started before its review barrier or integration predecessors completed`);
      }
    }
  }
  if (causalErrors.length > 0) return invalidReconciliation(causalErrors);
  for (const itemId of orderedIds) {
    const item = items[itemId];
    if (!priorWavesComplete(item.wave)) continue;
    if (item.state === "implementation_ready") {
      const attempt = phaseState(itemId, "implementation")?.attempt ?? 1;
      buildReviewActions.push({ type: "dispatch", itemId, phase: "implementation", wave: item.wave, ...(attempt > 1 ? { attempt } : {}) });
    } else if (item.state === "implementation_repair_ready") {
      const implementation = phaseState(itemId, "implementation");
      buildReviewActions.push({
        type: "dispatch", itemId, phase: "implementation", wave: item.wave,
        attempt: implementation.attempt + 1,
        recovery: "repair",
        ...(implementation.candidateSha ? { candidateSha: implementation.candidateSha } : {}),
      });
    } else if (item.state === "review_ready") {
      const implementation = phaseState(itemId, "implementation");
      const priorReviews = receiptResult.byPhase.get(phaseKey(itemId, "review")) ?? [];
      const attempt = priorReviews.reduce((max, receipt) => Math.max(max, receipt.attempt), 0) + 1;
      buildReviewActions.push({
        type: "dispatch", itemId, phase: "review", wave: item.wave,
        ...(attempt > 1 ? { attempt } : {}),
        ...(implementation.candidateSha ? { candidateSha: implementation.candidateSha } : {}),
        implementationAttempt: implementation.attempt,
      });
    }
  }
  const availableBuildSlots = Math.max(0, plan.schedule.buildReview.maxConcurrency - activeInFlight.length);
  const actions = buildReviewActions.slice(0, availableBuildSlots);

  // Integration is a wave-wide build/review barrier followed by a single,
  // backlog-ordered lane. Never surface a later merge while an earlier one is
  // unfinished, and never cross a failed/cancelled review barrier.
  for (const waveSchedule of plan.schedule.waves) {
    if (!priorWavesComplete(waveSchedule.wave)) continue;
    const waveItems = waveSchedule.buildReview.itemIds;
    const barrierPassed = waveItems.every((itemId) =>
      items[itemId].state === "completed"
      || items[itemId].state === "integration_ready"
      || items[itemId].state === "integration_in_flight");
    if (!barrierPassed) continue;
    const nextIntegration = waveSchedule.integration.itemIds.find((itemId) => items[itemId].state !== "completed");
    if (nextIntegration && items[nextIntegration].state === "integration_ready") {
      const implementation = phaseState(nextIntegration, "implementation");
      const target = integrationTargets[nextIntegration];
      if (!target) return invalidReconciliation([`integration target for '${nextIntegration}' is required before approval`]);
      const authorization = {
        itemId: nextIntegration,
        workBranch: target.workBranch,
        workHeadSha: implementation.candidateSha,
        baseBranch: target.baseBranch,
        baseHeadSha: target.baseHeadSha,
        operation: plan.items[nextIntegration].disposition,
      };
      const digest = integrationApprovalDigest(authorization);
      const approval = approvalByItem.get(nextIntegration);
      const approvalMatches = approval && ["itemId", "workBranch", "workHeadSha", "baseBranch", "baseHeadSha", "operation"]
        .every((field) => approval[field] === authorization[field]);
      if (!approvalMatches) {
        actions.push({ type: "approval", phase: "integration", wave: waveSchedule.wave, authorization, digest });
      } else {
        actions.push({
          type: "dispatch", itemId: nextIntegration, phase: "integration", wave: waveSchedule.wave,
          candidateSha: implementation.candidateSha, approvalDigest: approval.digest,
        });
      }
    }
  }

  const terminal = orderedIds.every((itemId) => items[itemId].state === "completed");
  const hasInFlight = activeInFlight.length > 0;
  const next = actions.length > 0 ? "dispatch"
    : terminal ? "terminal"
    : hasInFlight ? "wait"
    : "blocked";
  const blockedItem = orderedIds.map((itemId) => items[itemId]).find((item) => item.state === "blocked" || item.state === "cancelled");

  return {
    ok: true,
    version: 1,
    errors: [],
    items,
    receipts,
    inFlight: activeInFlight,
    actions,
    next,
    wait: {
      eligible: next === "wait" && actions.length === 0,
      inFlight: activeInFlight,
    },
    terminal,
    escalated: false,
    terminalReason: next === "blocked" ? blockedItem?.terminalReason ?? "failed-dependency" : null,
    metadata: {
      plan: {
        digestAlgorithm: "sha256",
        digest: sprintPlanDigest(plan, orderedIds),
        totalItems: orderedIds.length,
        pageSize: SPRINT_RECONCILE_PAGE_SIZE,
        pageCount: Math.ceil(orderedIds.length / SPRINT_RECONCILE_PAGE_SIZE),
      },
      buildReview: { ...plan.schedule.buildReview },
      barrier: plan.schedule.barrier,
      integration: { ...plan.schedule.integration },
      degradation: { ...plan.schedule.degradation },
    },
  };
}

export function computeSprintWaves(content, options = {}) {
  if (typeof content !== "string") {
    return { ok: false, errors: ["missing content: expected backlog text"], waves: [], items: {}, annotated: false };
  }
  if (content.trim() === "") {
    return { ok: false, errors: ["empty backlog: no content"], waves: [], items: {}, annotated: false };
  }

  const raw = [];
  // checkedIds: ids (explicit {id} or synthetic item-<line>) of already-checked
  // ("- [x] ") lines. These never become tasks/items, but a {deps} reference to one
  // is satisfied by definition — it's resolved (dropped) before wave computation
  // rather than erroring as an unknown dep.
  const checkedIds = new Set();
  content.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.replace(/^\s+/, "");
    const lineNo = i + 1;
    const m = CHECKBOX_RE.exec(trimmed);
    if (m) {
      const { anns, text } = stripAnnotations(m[1]);
      const hasId = Object.prototype.hasOwnProperty.call(anns, "id");
      raw.push({
        lineNo,
        hasId,
        rawId: anns.id,
        id: anns.id || `item-${lineNo}`,
        text,
        hasDeps: Object.prototype.hasOwnProperty.call(anns, "deps"),
        depsRaw: anns.deps,
        disposition: Object.prototype.hasOwnProperty.call(anns, "disposition") ? anns.disposition : null,
        escalated: Object.prototype.hasOwnProperty.call(anns, "escalated"),
        claimed: Object.prototype.hasOwnProperty.call(anns, "claimed") ? anns.claimed : null,
      });
      return;
    }
    const cm = CHECKED_CHECKBOX_RE.exec(trimmed);
    if (cm) {
      const { anns } = stripAnnotations(cm[1]);
      const hasId = Object.prototype.hasOwnProperty.call(anns, "id");
      checkedIds.add(hasId ? anns.id : `item-${lineNo}`);
    }
  });

  // annotated is the deterministic wave-mode trigger: true iff any parsed unchecked
  // item carried an explicit {id} or {deps} annotation. Checked lines never reach
  // `raw` (CHECKBOX_RE only matches unchecked "- [ ] " lines), so their annotations
  // never count.
  const annotated = raw.some((r) => r.hasId || r.hasDeps);

  const idErrors = raw
    .filter((r) => r.hasId && !ID_TOKEN_RE.test(r.rawId))
    .map((r) => `invalid id '${r.rawId}' at line ${r.lineNo}`);
  if (idErrors.length > 0) {
    return { ok: false, errors: idErrors, waves: [], items: {}, annotated };
  }

  // A checked line and an unchecked line sharing an id is ambiguous — which one does
  // a {deps: x} reference actually mean? Fatal, same as an unchecked/unchecked clash.
  const collisionErrors = [...new Set(raw.map((r) => r.id).filter((id) => checkedIds.has(id)))].map(
    (id) => `duplicate id "${id}": used by both a checked and an unchecked item`
  );
  if (collisionErrors.length > 0) {
    return { ok: false, errors: collisionErrors, waves: [], items: {}, annotated };
  }

  // Build the explicit deps array every item needs for computeWaves. Items without a
  // {deps} annotation get every id parsed so far (implicit "depends on all above").
  const idsSoFar = [];
  const tasks = raw.map((r) => {
    let deps;
    if (r.hasDeps) {
      const v = (r.depsRaw || "").trim();
      deps = v.toLowerCase() === "none" ? [] : v.split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      deps = idsSoFar.slice();
    }
    // Deps referencing a checked (already-satisfied) item resolve immediately — drop
    // them before wave computation. Anything left that isn't a real unchecked id
    // still hits computeWaves' unknown-dep check below.
    deps = deps.filter((d) => !checkedIds.has(d));
    idsSoFar.push(r.id);
    return { id: r.id, deps };
  });

  const items = {};
  for (let index = 0; index < raw.length; index += 1) {
    const r = raw[index];
    items[r.id] = {
      line: r.lineNo,
      text: r.text,
      disposition: r.disposition,
      escalated: r.escalated,
      claimed: r.claimed,
      deps: [...tasks[index].deps],
    };
  }

  try {
    const computed = computeWaves(tasks);
    const waves = computed.map((w) => w.map((t) => t.id));
    return { ok: true, errors: [], waves, items, annotated, schedule: buildSprintSchedule(waves, items, options) };
  } catch (e) {
    return { ok: false, errors: [e.message], waves: [], items, annotated };
  }
}
