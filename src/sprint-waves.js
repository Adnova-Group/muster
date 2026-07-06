// Parse a sprint backlog (markdown checklist) into dependency-ordered execution waves.
//
// Only unchecked `- [ ] ` lines are items. Annotations of the form `{key: value}` can
// appear anywhere on the line and are stripped to produce the item text:
//   {id: token}                 explicit id (kebab/alnum token); default is the
//                                synthetic `item-<lineNo>` (1-based file line)
//   {deps: a,b} | {deps: none}  explicit dependency list, or explicit "no deps"
//   {disposition: merge-local|merge-push|pr|keep|ask}
//   {escalated: ...}            presence marks the item escalated (bool in output;
//                                the annotation's value is a free-text reason, discarded)
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

const CHECKBOX_RE = /^- \[ \] (.*)$/;

// {id} tokens must be kebab/alnum: a letter or digit, then letters/digits/hyphens.
const ID_TOKEN_RE = /^[a-z0-9][a-z0-9-]*$/i;

// Fresh RegExp per call (both here and in the exec loop below) — a shared global
// regex object carries `lastIndex` state across calls, which is an easy source of
// skipped/duplicated matches when the same pattern is reused for both exec and replace.
function annotationRegex() {
  return /\{\s*([A-Za-z][\w-]*)\s*:\s*([^}]*)\}/g;
}

function stripAnnotations(text) {
  const anns = {};
  const re = annotationRegex();
  let m;
  while ((m = re.exec(text))) {
    anns[m[1].toLowerCase()] = m[2].trim();
  }
  const stripped = text.replace(annotationRegex(), " ").replace(/\s+/g, " ").trim();
  return { anns, text: stripped };
}

export function computeSprintWaves(content) {
  if (typeof content !== "string") {
    return { ok: false, errors: ["missing content: expected backlog text"], waves: [], items: {}, annotated: false };
  }
  if (content.trim() === "") {
    return { ok: false, errors: ["empty backlog: no content"], waves: [], items: {}, annotated: false };
  }

  const raw = [];
  content.split(/\r?\n/).forEach((line, i) => {
    const m = CHECKBOX_RE.exec(line.replace(/^\s+/, ""));
    if (!m) return;
    const lineNo = i + 1;
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
    });
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
    idsSoFar.push(r.id);
    return { id: r.id, deps };
  });

  const items = {};
  for (const r of raw) {
    items[r.id] = { line: r.lineNo, text: r.text, disposition: r.disposition, escalated: r.escalated };
  }

  try {
    const computed = computeWaves(tasks);
    return { ok: true, errors: [], waves: computed.map((w) => w.map((t) => t.id)), items, annotated };
  } catch (e) {
    return { ok: false, errors: [e.message], waves: [], items, annotated };
  }
}
