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
import { computeWaves } from "./wave.js";

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

// A single `{key: value}` group, as a regex source fragment (no flags/anchors of its
// own) so it can be composed into the trailing-block regex below.
const ANNOTATION_GROUP_SRC = "\\{\\s*[A-Za-z][\\w-]*\\s*:\\s*[^}]*\\}";

// The trailing annotation block: one-or-more annotation groups, each preceded by
// optional whitespace, anchored to run all the way to the end of the string. Built
// fresh per call for the same lastIndex-safety reason as annotationRegex() above
// (this one isn't global, but keeping the construction pattern consistent avoids a
// shared-regex mistake creeping in later).
function trailingAnnotationBlockRegex() {
  return new RegExp(`(?:\\s*${ANNOTATION_GROUP_SRC})+\\s*$`);
}

function stripAnnotations(text) {
  const anns = {};
  const trailingMatch = text.match(trailingAnnotationBlockRegex());
  const bodyText = trailingMatch ? text.slice(0, trailingMatch.index) : text;
  const annotationBlock = trailingMatch ? trailingMatch[0] : "";
  const re = annotationRegex();
  let m;
  while ((m = re.exec(annotationBlock))) {
    anns[m[1].toLowerCase()] = m[2].trim();
  }
  const stripped = bodyText.replace(/\s+/g, " ").trim();
  return { anns, text: stripped };
}

function resolveParallelLimit(value) {
  if (value === undefined || value === null || value === "") return SPRINT_PARALLEL_DEFAULT;
  const normalized = typeof value === "number" ? String(value) : String(value).trim();
  if (!/^\d+$/.test(normalized)) return SPRINT_PARALLEL_DEFAULT;
  const parsed = Number.parseInt(normalized, 10);
  if (parsed < 1) return SPRINT_PARALLEL_DEFAULT;
  return Math.min(parsed, SPRINT_PARALLEL_MAX);
}

function chunk(ids, size) {
  const batches = [];
  for (let i = 0; i < ids.length; i += size) batches.push(ids.slice(i, i + size));
  return batches;
}

export function buildSprintSchedule(waves, items, { parallelLimit } = {}) {
  const maxConcurrency = resolveParallelLimit(parallelLimit);
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
      dispositions: ["merge-local", "merge-push"],
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
        itemIds: itemIds.filter((id) => ["merge-local", "merge-push"].includes(items[id]?.disposition)),
      },
    })),
  };
}

const SPRINT_PHASES = ["implementation", "review", "integration"];
const SPRINT_RECEIPT_STATUSES = ["completed", "failed", "cancelled"];
const FAILURE_STATES = new Set(["failed", "cancelled", "blocked"]);

function canonicalReceipts(receipts, itemIds) {
  if (!Array.isArray(receipts)) return { errors: ["receipts must be an array"], receipts: [] };
  const errors = [];
  const byId = new Map();
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
    };
    let valid = true;
    if (typeof receipt.id !== "string" || !receipt.id.trim()) {
      errors.push("receipt id must be a non-empty string");
      valid = false;
    }
    if (!itemIds.has(receipt.itemId)) {
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
    if (!Number.isInteger(receipt.attempt) || receipt.attempt < 1) {
      errors.push(`receipt '${receipt.id}' attempt must be a positive integer`);
      valid = false;
    }
    if (!valid) continue;
    const normalized = { ...receipt };
    const prior = byId.get(normalized.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(normalized)) {
      errors.push(`duplicate receipt id '${normalized.id}' carries conflicting payloads`);
      continue;
    }
    byId.set(normalized.id, normalized);
  }
  return {
    errors,
    receipts: [...byId.values()].sort((a, b) =>
      a.itemId.localeCompare(b.itemId)
      || SPRINT_PHASES.indexOf(a.phase) - SPRINT_PHASES.indexOf(b.phase)
      || a.attempt - b.attempt
      || a.id.localeCompare(b.id)),
  };
}

function canonicalInFlight(inFlight, itemIds) {
  if (!Array.isArray(inFlight)) return { errors: ["inFlight must be an array"], inFlight: [] };
  const errors = [];
  const seen = new Set();
  const normalized = [];
  for (const entry of inFlight) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push("each inFlight entry must be an object");
      continue;
    }
    if (!itemIds.has(entry.itemId)) {
      errors.push(`inFlight entry names unknown item '${entry.itemId}'`);
      continue;
    }
    if (!SPRINT_PHASES.includes(entry.phase)) {
      errors.push(`inFlight entry for '${entry.itemId}' has invalid phase '${entry.phase}'`);
      continue;
    }
    const key = `${entry.itemId}\0${entry.phase}`;
    if (!seen.has(key)) normalized.push({ itemId: entry.itemId, phase: entry.phase });
    seen.add(key);
  }
  return { errors, inFlight: normalized };
}

function latestPhaseReceipt(receipts, itemId, phase) {
  const matches = receipts.filter((receipt) => receipt.itemId === itemId && receipt.phase === phase);
  if (matches.length === 0) return null;
  const highestAttempt = Math.max(...matches.map((receipt) => receipt.attempt));
  const latest = matches.filter((receipt) => receipt.attempt === highestAttempt);
  // A contradictory same-attempt failure must fail closed. A later attempt can
  // still supersede it, which is how an adapter represents an explicit retry.
  return latest.find((receipt) => receipt.status === "failed")
    || latest.find((receipt) => receipt.status === "cancelled")
    || latest.find((receipt) => receipt.status === "completed");
}

function waveForItem(plan, itemId) {
  return plan.waves.findIndex((wave) => wave.includes(itemId)) + 1;
}

// Pure completion-awareness transition. Adapters own dispatch and mailbox I/O;
// this function owns the executable decision about whether a wake means dispatch,
// wait, terminal, or escalated. Callers pass the complete receipts currently
// available on every wake, then dispatch every returned action before waiting again.
export function reconcileSprintProgress(plan, progress = {}) {
  if (!plan?.ok || !Array.isArray(plan.waves) || !plan.items || !plan.schedule) {
    return { ok: false, errors: ["plan must be a successful computeSprintWaves result"] };
  }
  const orderedIds = plan.waves.flat();
  const itemIds = new Set(orderedIds);
  const receiptResult = canonicalReceipts(progress.receipts ?? [], itemIds);
  const inFlightResult = canonicalInFlight(progress.inFlight ?? [], itemIds);
  const errors = [...receiptResult.errors, ...inFlightResult.errors];
  if (errors.length > 0) return { ok: false, errors };

  const receipts = receiptResult.receipts;
  const inFlight = inFlightResult.inFlight;
  const isInFlight = (itemId, phase) => inFlight.some((entry) => entry.itemId === itemId && entry.phase === phase);
  const items = {};

  for (const itemId of orderedIds) {
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
      const implementation = latestPhaseReceipt(receipts, itemId, "implementation");
      if (implementation?.status === "failed" || implementation?.status === "cancelled") {
        state = implementation.status;
      } else if (implementation?.status !== "completed") {
        state = isInFlight(itemId, "implementation") ? "implementation_in_flight" : "implementation_ready";
      } else {
        const review = latestPhaseReceipt(receipts, itemId, "review");
        if (review?.status === "failed" || review?.status === "cancelled") {
          state = review.status;
        } else if (review?.status !== "completed") {
          state = isInFlight(itemId, "review") ? "review_in_flight" : "review_ready";
        } else if (!["merge-local", "merge-push"].includes(source.disposition)) {
          state = "completed";
        } else {
          const integration = latestPhaseReceipt(receipts, itemId, "integration");
          if (integration?.status === "failed" || integration?.status === "cancelled") {
            state = integration.status;
          } else if (integration?.status === "completed") {
            state = "completed";
          } else {
            state = isInFlight(itemId, "integration") ? "integration_in_flight" : "integration_ready";
          }
        }
      }
    }

    items[itemId] = {
      state,
      wave: waveForItem(plan, itemId),
      deps: [...deps],
      disposition: source.disposition,
      blockedBy,
    };
  }

  const activeInFlight = inFlight.filter(({ itemId, phase }) => items[itemId].state === `${phase}_in_flight`);
  const buildReviewActions = [];
  const priorWavesComplete = (waveNumber) => plan.waves
    .slice(0, waveNumber - 1)
    .flat()
    .every((itemId) => items[itemId].state === "completed");
  for (const itemId of orderedIds) {
    const item = items[itemId];
    if (!priorWavesComplete(item.wave)) continue;
    if (item.state === "implementation_ready") {
      buildReviewActions.push({ type: "dispatch", itemId, phase: "implementation", wave: item.wave });
    } else if (item.state === "review_ready") {
      buildReviewActions.push({ type: "dispatch", itemId, phase: "review", wave: item.wave });
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
      actions.push({ type: "dispatch", itemId: nextIntegration, phase: "integration", wave: waveSchedule.wave });
    }
  }

  const terminal = orderedIds.every((itemId) => items[itemId].state === "completed");
  const hasInFlight = activeInFlight.length > 0;
  const hasFailure = orderedIds.some((itemId) => FAILURE_STATES.has(items[itemId].state));
  const next = actions.length > 0 ? "dispatch"
    : terminal ? "terminal"
    : hasInFlight ? "wait"
    : hasFailure ? "escalated"
    : "wait";

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
    escalated: next === "escalated",
    metadata: {
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
