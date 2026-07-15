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

export function computeSprintWaves(content) {
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
  for (const r of raw) {
    items[r.id] = { line: r.lineNo, text: r.text, disposition: r.disposition, escalated: r.escalated, claimed: r.claimed };
  }

  try {
    const computed = computeWaves(tasks);
    return { ok: true, errors: [], waves: computed.map((w) => w.map((t) => t.id)), items, annotated };
  } catch (e) {
    return { ok: false, errors: [e.message], waves: [], items, annotated };
  }
}
