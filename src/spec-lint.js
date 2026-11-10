// `muster spec-lint <SPEC.md | INT-NNNN-<slug>.md> [--intent] [--json] [--root <dir>]`: the
// deterministic gates for the PM artifact chain (docs/spec-format.md).
//
// A SPEC is linted against docs/strategy/2026-11-pm-domain-design.md Appendix D; an INTENT
// (auto-detected, or forced with --intent) against the lighter intent rules in the same
// contract, which are mostly warnings. The ID grammar is Appendix C.
//
// Spec text is untrusted, LLM-authored markdown. Nothing here executes, spawns or shells out:
// the only I/O is one bounded read of the spec's linked intent file under the project root.
// No network. Regex and line structure only, so the same file always lints the same way.
//
// Output is plan-lint's CheckResult (src/plan-lint.js, docs/plan-format.md):
//   { verdict: "PASS" | "ISSUES", issues: [{ dimension, severity, required_property, summary }] }
// Any issue makes the verdict ISSUES; only a blocker makes the CLI exit 1. Exit 2 means the
// file was not evaluated (missing, unreadable, oversized, bad usage) and is never a pass.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { SEVERITY, blankFencedBlocks, countBySeverity, withinRootLexical } from "./plan-lint.js";

export { SEVERITY };

export const DIMENSIONS = Object.freeze({
  // SPEC
  STRUCTURE: "spec_structure",
  ID_GRAMMAR: "id_grammar",
  REQUIREMENTS: "requirements",
  ACCEPTANCE: "acceptance_criteria",
  READINESS: "readiness",
  AI_EVALS: "ai_evals",
  LANGUAGE: "requirement_language",
  SCOPE: "scope",
  OUTCOME_LINK: "outcome_link",
  LENGTH: "spec_length",
  // INTENT
  INTENT_STRUCTURE: "intent_structure",
  OUTCOME: "outcome",
  TRADEOFFS: "tradeoff_principles",
  ASSUMPTIONS: "assumptions",
});

export const SPEC_STATUSES = Object.freeze(["draft", "ready", "in-build", "shipped", "superseded"]);
// `ready` and every status past it carry the readiness gate (no markers, no OQ blocking build).
export const READY_STATUSES = Object.freeze(["ready", "in-build", "shipped"]);
export const CHANGE_KINDS = Object.freeze(["new", "modify", "remove"]);
export const INTENT_STATUS_RE = /^(?:draft|accepted|retired|superseded-by INT-\d{4})$/;

// Verify type -> the verifier status it can reach (docs/spec-format.md "Verify types").
export const VERIFY_STATUS = Object.freeze({
  test: "VERIFIED / FAILED",
  check: "VERIFIED / FAILED",
  eval: "VERIFIED / FAILED",
  judgment: "NEEDS-HUMAN",
  "needs-runtime": "NEEDS-RUNTIME",
});
export const VERIFY_TYPES = Object.freeze(Object.keys(VERIFY_STATUS));

// EARS tag -> the trigger keyword its sentence must use before "shall" (cc-sdd ears-format).
export const EARS_TAGS = Object.freeze({
  ubiquitous: null,
  event: /\bwhen\b/i,
  state: /\bwhile\b/i,
  unwanted: /\bif\b/i,
  optional: /\bwhere\b/i,
});

// Appendix C: reserved prefixes are never requirement categories.
export const RESERVED_PREFIXES = Object.freeze({
  INV: "invariant", EV: "eval", RK: "risk", D: "decision", OQ: "open question", NG: "non-goal", A: "assumption", INT: "intent",
});
const INTENT_ID_KINDS = new Set(["non-goal", "decision", "open question", "assumption"]);

export const VAGUE_ADJECTIVES = Object.freeze([
  "fast", "easy", "intuitive", "robust", "scalable", "seamless", "user-friendly", "secure", "efficient", "flexible",
]);
const VAGUE_RE = /\b(fast|easy|intuitive|robust|scalable|seamless|user[- ]friendly|secure|efficient|flexible)\b/gi;

// Implementation language in a requirement: storage, transport, framework and code nouns that
// say how instead of what. Kept narrow on purpose: a warning that fires on product nouns
// ("table", "queue", "message") teaches people to ignore it.
// Formats a user can see (CSV, JSON, HTTP status codes) and product nouns ("column", "table")
// are left alone: an API or export spec names them as behavior.
const IMPLEMENTATION_RE = new RegExp([
  "SQL", "database", "schema", "foreign key", "stored procedure", "ORM", "endpoint",
  "React", "Vue", "Angular", "Redux", "Redis", "Postgres(?:QL)?", "MySQL", "MongoDB", "DynamoDB", "Kafka",
  "microservice", "Lambda", "Docker", "Kubernetes", "cron", "regex", "controller",
].map(w => `\\b${w}\\b`).join("|") + "|\\b(?:src|lib|app)/[\\w./-]+|\\b[\\w-]+\\.(?:js|ts|tsx|jsx|py|go|rb|java|sql)\\b", "gi");

export const SPEC_WORD_BUDGET = 2000;
export const AC_CHAR_BUDGET = 500;
export const MAX_CLARIFICATION_MARKERS = 3;
export const MAX_TRADEOFF_PRINCIPLES = 3;
export const MAX_SPEC_BYTES = 1024 * 1024;

const FRONTMATTER_RE = /^﻿?---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;
const MARKER_RE = /\[NEEDS CLARIFICATION/g;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s/;
const LIST_LEAD_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+\*\*([^*\n]{1,60}?)\*\*(.*)$/;
const TABLE_LEAD_RE = /^\s*\|\s*\*\*([^*\n|]{1,60}?)\*\*\s*\|/;
const H3_RE = /^###\s+(\S+)(.*)$/;
const H2_RE = /^##\s+(.+?)\s*#*\s*$/;
const PLACEHOLDER_CELL_RE = /^(?:|<[^>]*>|\.\.\.|…|tbd|todo|n\/a|-|—)$/i;

// ─── IDs (Appendix C) ─────────────────────────────────────────────────────────

/** Does a bold lead or `###` heading token try to be an ID? (Evidence labels E1, E2 are not.) */
export function looksLikeId(token) {
  return /^[A-Z][A-Z0-9]{0,11}-?\d[\d.]*$/.test(token) && !/^E\d+$/.test(token);
}

/**
 * Classify one ID token against Appendix C. Returns { kind, id, requirement? } or null when the
 * token is malformed (wrong digit count, reserved prefix used as a requirement category, ...).
 */
export function classifyId(token) {
  const m = /^([A-Z][A-Z0-9]*)-(\d+)(?:\.(\d+))?$/.exec(String(token));
  if (!m) return null;
  const [, prefix, num, sub] = m;
  if (Object.hasOwn(RESERVED_PREFIXES, prefix)) {
    if (sub !== undefined) return null;
    if (prefix === "INT") return /^\d{4}$/.test(num) ? { kind: "intent", id: token } : null;
    return /^\d{2,3}$/.test(num) ? { kind: RESERVED_PREFIXES[prefix], id: token } : null;
  }
  if (!/^[A-Z][A-Z0-9]{1,11}$/.test(prefix) || !/^\d{2,3}$/.test(num)) return null;
  if (sub === undefined) return { kind: "requirement", id: token };
  return /^\d{1,2}$/.test(sub) ? { kind: "ac", id: token, requirement: `${prefix}-${num}` } : null;
}

// ─── Document model ───────────────────────────────────────────────────────────

/** Blank HTML comments, keeping newlines: template guidance lives in comments and is not linted. */
function blankComments(text) {
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, m => m.replace(/[^\n]/g, " "));
}

function sectionKey(title) {
  return title.replace(/\([^)]*\)/g, " ").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Split one markdown table row into trimmed cells (escaped pipes stay in their cell). */
export function splitRow(line) {
  const cells = [];
  let cur = "";
  const s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i += 1; }
    else if (s[i] === "|") { cells.push(cur.trim()); cur = ""; }
    else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

const stripBold = s => s.replace(/^\*\*(.*)\*\*$/, "$1").trim();
const isSeparatorRow = line => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);

/** Tables in a range of lines: [{ header: [cells], rows: [{ line, cells }] }]. */
function tablesIn(lines, from, to) {
  const tables = [];
  let i = from;
  while (i < to) {
    if (!/^\s*\|/.test(lines[i])) { i += 1; continue; }
    const block = [];
    while (i < to && /^\s*\|/.test(lines[i])) { block.push(i); i += 1; }
    const header = splitRow(lines[block[0]]);
    const bodyStart = block.length > 1 && isSeparatorRow(lines[block[1]]) ? 2 : 1;
    tables.push({ header, rows: block.slice(bodyStart).map(n => ({ line: n, cells: splitRow(lines[n]) })) });
  }
  return tables;
}

/**
 * Parse a spec or intent document. Never throws. Fenced blocks and HTML comments are blanked
 * (line count kept) so quoted examples and template guidance are never read as live content.
 */
export function parseDocument(rawText) {
  const text = String(rawText ?? "").replace(/\r\n/g, "\n");
  const fm = FRONTMATTER_RE.exec(text);
  let frontmatter = null;
  let frontmatterError = null;
  if (fm) {
    try {
      const parsed = parseYaml(fm[1]);
      frontmatter = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      frontmatterError = error.message.split("\n")[0];
    }
  }
  const bodyStart = fm ? fm[0].length : 0;
  const lineOffset = text.slice(0, bodyStart).split("\n").length - 1;
  const { text: blanked, unclosedFence } = blankFencedBlocks(text);
  const body = blankComments(blanked.slice(bodyStart));
  const lines = body.split("\n");

  const sections = [];
  let current = { title: "", key: "", start: 0, end: lines.length };
  sections.push(current);
  lines.forEach((line, i) => {
    const h2 = H2_RE.exec(line);
    if (!h2 || line.startsWith("###")) return;
    current.end = i;
    current = { title: h2[1], key: sectionKey(h2[1]), start: i + 1, end: lines.length };
    sections.push(current);
  });

  const sectionAt = i => {
    let found = sections[0];
    for (const s of sections) if (s.start <= i) found = s;
    return found;
  };

  // Definitions: a bold list-item lead, a `### ID` heading, or a bold first table cell.
  const definitions = [];
  lines.forEach((line, i) => {
    let token = null;
    let form = null;
    let rest = "";
    const h3 = H3_RE.exec(line);
    const lead = LIST_LEAD_RE.exec(line);
    const cell = TABLE_LEAD_RE.exec(line);
    if (h3) { token = h3[1]; form = "heading"; rest = h3[2]; }
    else if (lead) { token = lead[2].trim(); form = "list"; rest = lead[3]; }
    else if (cell) { token = cell[1].trim(); form = "table"; rest = line; }
    if (token === null) return;
    token = token.replace(/[:,;]+$/, "");
    if (!looksLikeId(token)) return;
    let textBody = rest;
    if (form === "list") {
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j];
        if (!next.trim() || LIST_ITEM_RE.test(next) || /^\s*(?:#|\|)/.test(next)) break;
        textBody += ` ${next.trim()}`;
      }
    }
    definitions.push({ token, form, line: i, text: textBody.trim(), section: sectionAt(i), cls: classifyId(token) });
  });

  return { text, body, lines, lineOffset, frontmatter, frontmatterPresent: Boolean(fm), frontmatterError, unclosedFence, sections, definitions };
}

const findSection = (doc, predicate) => doc.sections.find(s => s.key && predicate(s.key)) || null;
const sectionText = (doc, s) => (s ? doc.lines.slice(s.start, s.end).join("\n") : "");

function quote(s, max = 80) {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const withArticle = noun => `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;

/** Is there an Outcome row whose first cell is Primary and whose metric is filled in? */
export function hasPrimaryMetric(text) {
  for (const line of String(text).split("\n")) {
    if (!/^\s*\|/.test(line)) continue;
    const cells = splitRow(line);
    if (cells.length >= 2 && /^primary$/i.test(stripBold(cells[0])) && !PLACEHOLDER_CELL_RE.test(cells[1])) return true;
  }
  return false;
}

function readBounded(file) {
  const st = statSync(file);
  if (!st.isFile()) throw Object.assign(new Error("not a regular file"), { code: "ENOTFILE" });
  if (st.size > MAX_SPEC_BYTES) throw Object.assign(new Error(`larger than ${MAX_SPEC_BYTES} bytes`), { code: "EFBIG" });
  return readFileSync(file, "utf8");
}

/** Shared ID checks: malformed tokens and duplicate definitions. */
function checkIds(doc, add, { malformedSeverity }) {
  const at = d => `line ${doc.lineOffset + d.line + 1}`;
  for (const d of doc.definitions) {
    if (d.cls) continue;
    const prefix = (d.token.match(/^([A-Z][A-Z0-9]*)/) || [])[1];
    const reserved = prefix && Object.hasOwn(RESERVED_PREFIXES, prefix);
    const why = !reserved ? "expected CAT-NN, CAT-NN.N, INV-/EV-/RK-/D-/OQ-/NG-/A-NN or INT-NNNN"
      : /\.\d/.test(d.token) ? `${prefix} is reserved for ${RESERVED_PREFIXES[prefix]} IDs and is never a requirement category`
      : `${RESERVED_PREFIXES[prefix]} IDs are ${prefix === "INT" ? "INT-NNNN (four digits)" : `${prefix}-NN (two or three digits)`}`;
    add(DIMENSIONS.ID_GRAMMAR, malformedSeverity, "IDs follow the grammar in docs/spec-format.md", `${d.token} (${at(d)}) is not a valid ID: ${why}`);
  }
  const byId = new Map();
  for (const d of doc.definitions.filter(x => x.cls)) byId.set(d.token, [...(byId.get(d.token) || []), d]);
  for (const [id, defs] of byId) {
    if (defs.length > 1) add(DIMENSIONS.ID_GRAMMAR, SEVERITY.BLOCKER, "Each ID is defined once and never reused", `${id} is defined ${defs.length} times (${defs.map(at).join(", ")})`);
  }
}

// ─── SPEC ─────────────────────────────────────────────────────────────────────

/**
 * Lint one SPEC.md (Appendix D). `options.projectRoot` (default cwd) anchors the intent link.
 * Returns a CheckResult. Never throws on any input.
 */
export function lintSpec(rawText, options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const doc = parseDocument(rawText);
  const issues = [];
  const add = (dimension, severity, required_property, summary) => issues.push({ dimension, severity, required_property, summary });
  const at = d => `line ${doc.lineOffset + d.line + 1}`;
  const fm = doc.frontmatter;

  // Structure: frontmatter, spec, status, intent link or inline Intent.
  if (!doc.frontmatterPresent) add(DIMENSIONS.STRUCTURE, SEVERITY.BLOCKER, "SPEC.md opens with YAML frontmatter", "no frontmatter block (--- ... ---) at the top of the file");
  else if (doc.frontmatterError) add(DIMENSIONS.STRUCTURE, SEVERITY.BLOCKER, "Frontmatter is valid YAML", `frontmatter does not parse: ${doc.frontmatterError}`);
  const status = fm && typeof fm.status === "string" ? fm.status.trim() : null;
  if (fm) {
    if (typeof fm.spec !== "string" || !fm.spec.trim()) add(DIMENSIONS.STRUCTURE, SEVERITY.BLOCKER, "Frontmatter names the spec (spec: <slug>)", "frontmatter has no spec field");
    if (status === null) add(DIMENSIONS.STRUCTURE, SEVERITY.BLOCKER, "Frontmatter carries a status", "frontmatter has no status field");
    else if (!SPEC_STATUSES.includes(status)) add(DIMENSIONS.STRUCTURE, SEVERITY.BLOCKER, `status is one of ${SPEC_STATUSES.join(" | ")}`, `unknown status "${quote(status, 40)}"`);
    if (fm.change !== undefined && !CHANGE_KINDS.includes(String(fm.change).trim().split(/\s/)[0])) add(DIMENSIONS.STRUCTURE, SEVERITY.WARNING, `change is one of ${CHANGE_KINDS.join(" | ")}`, `unknown change "${quote(fm.change, 40)}"`);
  }
  if (doc.unclosedFence) add(DIMENSIONS.STRUCTURE, SEVERITY.BLOCKER, "Every code fence is closed", "an unclosed code fence hides the rest of the spec from every check");

  const inlineIntent = findSection(doc, k => k === "intent");
  const intentRef = fm ? fm.intent : undefined;
  let intentText = inlineIntent ? sectionText(doc, inlineIntent) : null;
  let intentResolved = true;
  if (intentRef === undefined || intentRef === null || intentRef === "" || intentRef === "inline") {
    if (!inlineIntent && fm) {
      intentResolved = false;
      add(DIMENSIONS.STRUCTURE, SEVERITY.BLOCKER, "The spec links an intent (intent: docs/intent/INT-NNNN-<slug>.md) or carries an inline ## Intent (lite mode)", "no intent link and no ## Intent section");
    }
  } else if (typeof intentRef !== "string") {
    intentResolved = false;
    add(DIMENSIONS.STRUCTURE, SEVERITY.BLOCKER, "intent is one repo-relative path", `intent is a ${Array.isArray(intentRef) ? "list" : typeof intentRef}, not a path`);
  } else {
    const rel = intentRef.split("#")[0].trim();
    const target = path.resolve(projectRoot, rel);
    if (path.isAbsolute(rel) || !withinRootLexical(target, projectRoot)) {
      intentResolved = false;
      add(DIMENSIONS.STRUCTURE, SEVERITY.BLOCKER, "The intent path is repo-relative and stays inside the project root", `intent path "${quote(rel, 80)}" is absolute or leaves the project root`);
    } else {
      try {
        intentText = readBounded(target);
      } catch (error) {
        intentResolved = false;
        add(DIMENSIONS.STRUCTURE, SEVERITY.BLOCKER, "The intent path resolves to a file under the project root", `intent path "${quote(rel, 80)}" does not resolve (${error.code ?? error.message})`);
      }
    }
  }

  // IDs.
  checkIds(doc, add, { malformedSeverity: SEVERITY.BLOCKER });

  // Requirements and their acceptance criteria.
  const reqSection = findSection(doc, k => k === "requirements");
  const inReq = d => reqSection && d.section === reqSection;
  const requirements = [];
  if (reqSection) {
    for (let i = reqSection.start; i < reqSection.end; i += 1) {
      const h3 = H3_RE.exec(doc.lines[i]);
      if (!h3) continue;
      const def = doc.definitions.find(d => d.line === i && d.form === "heading");
      if (def?.cls?.kind === "requirement") requirements.push({ id: def.token, line: i, title: def.text, acs: [] });
      else if (def?.cls) add(DIMENSIONS.REQUIREMENTS, SEVERITY.BLOCKER, "A requirement heading uses a requirement ID (CAT-NN)", `${def.token} (${at(def)}) is ${withArticle(def.cls.kind)} ID and cannot head a requirement`);
      else if (!def) add(DIMENSIONS.REQUIREMENTS, SEVERITY.WARNING, "Every ### heading under ## Requirements is a requirement (### CAT-NN <title>)", `heading "${quote(h3[1] + h3[2], 60)}" (line ${doc.lineOffset + i + 1}) is not a requirement; its criteria will not be linted`);
    }
  }
  for (const d of doc.definitions.filter(x => x.cls?.kind === "requirement" && !(x.form === "heading" && inReq(x)))) {
    add(DIMENSIONS.REQUIREMENTS, SEVERITY.BLOCKER, "Requirements are defined as ### CAT-NN headings under ## Requirements", `${d.token} (${at(d)}) is defined outside a ## Requirements heading`);
  }
  const acs = doc.definitions.filter(d => d.cls?.kind === "ac");
  for (const d of acs) {
    if (!inReq(d) || d.form !== "list") {
      add(DIMENSIONS.REQUIREMENTS, SEVERITY.BLOCKER, "Acceptance criteria are bold list items under their requirement", `${d.token} (${at(d)}) is not a list item under ## Requirements`);
      continue;
    }
    const owner = requirements.filter(r => r.line < d.line).pop();
    if (!owner || owner.id !== d.cls.requirement) {
      add(DIMENSIONS.REQUIREMENTS, SEVERITY.BLOCKER, "An acceptance criterion sits under its own requirement (REF-01.2 under ### REF-01)", `${d.token} (${at(d)}) sits under ${owner ? owner.id : "no requirement heading"}`);
      continue;
    }
    owner.acs.push(d);
  }
  for (const r of requirements) {
    if (r.acs.length === 0) add(DIMENSIONS.REQUIREMENTS, SEVERITY.BLOCKER, "Each requirement has at least one acceptance criterion", `${r.id} has no acceptance criteria`);
  }
  const invariants = doc.definitions.filter(d => d.cls?.kind === "invariant");
  if (fm && requirements.length === 0 && invariants.length === 0) add(DIMENSIONS.REQUIREMENTS, SEVERITY.BLOCKER, "A spec defines at least one requirement or invariant", "no ### CAT-NN requirement and no INV-NN invariant");

  // Acceptance criteria and invariants: shall, exactly one verify type, EARS shape.
  const verifiable = [...acs.filter(d => inReq(d) && d.form === "list"), ...invariants.filter(d => d.form === "list")];
  const needsRuntime = [];
  for (const d of verifiable) {
    const t = d.text;
    if (!/\bshall\b/i.test(t)) add(DIMENSIONS.ACCEPTANCE, SEVERITY.BLOCKER, "Each criterion states mandatory behavior with \"shall\"", `${d.token} (${at(d)}) has no "shall"`);
    const verifies = [...t.matchAll(/\bverify:\s*([A-Za-z-]*)/gi)].map(m => m[1].toLowerCase());
    if (verifies.length === 0) add(DIMENSIONS.ACCEPTANCE, SEVERITY.BLOCKER, `Each criterion ends with exactly one verify type (${VERIFY_TYPES.join(" | ")})`, `${d.token} (${at(d)}) has no verify type`);
    else if (verifies.length > 1) add(DIMENSIONS.ACCEPTANCE, SEVERITY.BLOCKER, "Each criterion has exactly one verify type; split a criterion that needs two", `${d.token} (${at(d)}) has ${verifies.length} verify types (${verifies.join(", ")})`);
    else if (!VERIFY_TYPES.includes(verifies[0])) add(DIMENSIONS.ACCEPTANCE, SEVERITY.BLOCKER, `verify is one of ${VERIFY_TYPES.join(" | ")}`, `${d.token} (${at(d)}) has unknown verify type "${verifies[0] || "(empty)"}"`);
    else if (verifies[0] === "needs-runtime") needsRuntime.push(d.token);
    if (t.length > AC_CHAR_BUDGET) add(DIMENSIONS.ACCEPTANCE, SEVERITY.WARNING, `One behavior per criterion, at most ${AC_CHAR_BUDGET} characters`, `${d.token} (${at(d)}) is ${t.length} characters`);
    if (d.cls.kind === "invariant") {
      if (!/\bshall continue to\b/i.test(t)) add(DIMENSIONS.ACCEPTANCE, SEVERITY.WARNING, "An invariant reads \"The system shall continue to …\"", `${d.token} (${at(d)}) does not say what shall continue to work`);
      continue;
    }
    const tag = /^\[([a-z-]+)\]/i.exec(t);
    if (!tag) add(DIMENSIONS.ACCEPTANCE, SEVERITY.WARNING, `Each criterion opens with an EARS tag (${Object.keys(EARS_TAGS).map(k => `[${k}]`).join(" ")})`, `${d.token} (${at(d)}) has no EARS tag`);
    else if (!Object.hasOwn(EARS_TAGS, tag[1].toLowerCase())) add(DIMENSIONS.ACCEPTANCE, SEVERITY.WARNING, `EARS tag is one of ${Object.keys(EARS_TAGS).join(" | ")}`, `${d.token} (${at(d)}) has unknown EARS tag [${tag[1]}]`);
    else {
      const keyword = EARS_TAGS[tag[1].toLowerCase()];
      const beforeShall = t.split(/\bshall\b/i)[0];
      if (keyword && !keyword.test(beforeShall)) add(DIMENSIONS.ACCEPTANCE, SEVERITY.WARNING, "The EARS tag matches the sentence (event=When, state=While, unwanted=If, optional=Where)", `${d.token} (${at(d)}) is tagged [${tag[1]}] but its condition does not use "${keyword.source.replace(/\\b/g, "")}"`);
    }
  }

  // Readiness: clarification markers and open questions that block build.
  const markers = (doc.body.match(MARKER_RE) || []).length;
  if (markers > MAX_CLARIFICATION_MARKERS) add(DIMENSIONS.READINESS, SEVERITY.BLOCKER, `At most ${MAX_CLARIFICATION_MARKERS} [NEEDS CLARIFICATION] markers; take an informed default and record it under ## Assumptions for the rest`, `${markers} [NEEDS CLARIFICATION] markers`);
  const ready = status !== null && READY_STATUSES.includes(status);
  if (ready && markers > 0) add(DIMENSIONS.READINESS, SEVERITY.BLOCKER, "A ready spec has zero [NEEDS CLARIFICATION] markers", `status is ${status} but ${markers} marker(s) remain`);
  const blockingOqs = [];
  for (const d of doc.definitions.filter(x => x.cls?.kind === "open question")) {
    const blocks = /\bblocks?:\s*([^\n—]*)/i.exec(d.text);
    if (!blocks) { add(DIMENSIONS.READINESS, SEVERITY.WARNING, "Each open question says what it blocks (blocks: build | launch)", `${d.token} (${at(d)}) has no blocks: value`); continue; }
    const resolved = /\bresolved\b/i.test(d.text) || /^~~/.test(d.text);
    if (!resolved && /\b(?:build|spec)\b/i.test(blocks[1])) blockingOqs.push(d.token);
  }
  if (ready && blockingOqs.length) add(DIMENSIONS.READINESS, SEVERITY.BLOCKER, "A ready spec has no open question that blocks build", `status is ${status} but ${blockingOqs.join(", ")} still block${blockingOqs.length === 1 ? "s" : ""} build`);

  // AI behavior and evals.
  const aiSection = findSection(doc, k => k.startsWith("ai behavior"));
  if (aiSection) {
    const evs = doc.definitions.filter(d => d.cls?.kind === "eval" && d.section === aiSection);
    const tables = tablesIn(doc.lines, aiSection.start, aiSection.end);
    for (const d of evs) {
      let rule = d.text;
      if (d.form === "table") {
        const table = tables.find(tb => tb.rows.some(r => r.line === d.line));
        const col = table ? table.header.findIndex(h => /pass rule/i.test(h)) : -1;
        const cells = splitRow(doc.lines[d.line]);
        rule = cells[col >= 0 ? col : 3] ?? "";
      }
      if (!/\d/.test(rule)) add(DIMENSIONS.AI_EVALS, SEVERITY.BLOCKER, "Each EV pass rule is fixed before the run as a number or N/N (≥190/200, 30/30)", `${d.token} (${at(d)}) pass rule "${quote(rule, 60) || "(empty)"}" has no number`);
    }
    const text = sectionText(doc, aiSection);
    if (evs.length === 0) add(DIMENSIONS.AI_EVALS, SEVERITY.WARNING, "An AI behavior section carries EV rows, or is deleted when no model output is part of the feature", "the AI behavior section has no EV-NN rows");
    else if (!/takes user text:\s*no\b/i.test(text)) {
      const rows = evs.map(d => (d.form === "table" ? doc.lines[d.line] : d.text)).join("\n");
      const missing = [];
      if (!/refus|abstain|abstention|declin/i.test(rows)) missing.push("refusal/abstention");
      if (!/inject/i.test(rows)) missing.push("prompt injection");
      if (missing.length) add(DIMENSIONS.AI_EVALS, SEVERITY.WARNING, "A feature that takes user text has refusal/abstention and injection EV rows (write \"Takes user text: no\" in the section when it does not)", `no ${missing.join(" or ")} EV row`);
    }
  }

  // Requirement language: implementation terms and unquantified vague adjectives.
  const reqItems = [
    ...requirements.map(r => ({ id: r.id, line: r.line, text: r.title })),
    ...acs.filter(d => inReq(d)).map(d => ({ id: d.token, line: d.line, text: d.text.replace(/\bverify:\s*[A-Za-z-]*/gi, "") })),
  ];
  for (const item of reqItems) {
    const terms = [...new Set((item.text.match(IMPLEMENTATION_RE) || []).map(s => s.toLowerCase()))];
    if (terms.length) add(DIMENSIONS.LANGUAGE, SEVERITY.WARNING, "Requirements say what the system does, not how (move how into ## Decisions or a design doc)", `${item.id} (line ${doc.lineOffset + item.line + 1}) uses implementation language: ${terms.join(", ")}`);
  }
  for (const item of [...reqItems, ...invariants.map(d => ({ id: d.token, line: d.line, text: d.text }))]) {
    if (/\d/.test(item.text)) continue;
    const words = [...new Set((item.text.match(VAGUE_RE) || []).map(s => s.toLowerCase()))];
    if (words.length) add(DIMENSIONS.LANGUAGE, SEVERITY.WARNING, "A quality word is quantified (\"within 2 s at p95\", not \"fast\")", `${item.id} (line ${doc.lineOffset + item.line + 1}) uses unquantified ${words.map(w => `"${w}"`).join(", ")}`);
  }

  // Scope: at least one non-goal, defined here or referenced from the intent.
  if (fm && !/\bNG-\d{2,3}\b/.test(doc.body)) add(DIMENSIONS.SCOPE, SEVERITY.WARNING, "Scope names at least one non-goal (NG-NN, from the intent or this spec)", "no non-goal (NG-NN) anywhere in the spec");

  // needs-runtime criteria need an intent Outcome metric to be measured against.
  if (needsRuntime.length && intentResolved && !hasPrimaryMetric(intentText ?? "")) {
    add(DIMENSIONS.OUTCOME_LINK, SEVERITY.WARNING, "A needs-runtime criterion is measured by the intent's primary Outcome metric", `${needsRuntime.join(", ")} ${needsRuntime.length === 1 ? "is" : "are"} needs-runtime but the intent has no filled-in Primary outcome row`);
  }

  // Length: about 2,000 words, the generated Traceability block excluded.
  const trace = findSection(doc, k => k === "traceability");
  const counted = doc.lines.filter((_, i) => !(trace && i >= trace.start - 1 && i < trace.end)).join("\n");
  const words = counted.split(/\s+/).filter(w => /[A-Za-z0-9]/.test(w)).length;
  if (words > SPEC_WORD_BUDGET) add(DIMENSIONS.LENGTH, SEVERITY.WARNING, `The spec body stays under about ${SPEC_WORD_BUDGET} words; split the change or move context into linked files`, `the body is ${words} words`);

  return { verdict: issues.length === 0 ? "PASS" : "ISSUES", issues };
}

// ─── INTENT ───────────────────────────────────────────────────────────────────

/**
 * Lint one INTENT document. Mostly warnings: an intent is a human-owned page, and only a broken
 * frontmatter or a duplicated ID blocks. `options.fileName` enables the file-name/id check.
 */
export function lintIntent(rawText, options = {}) {
  const doc = parseDocument(rawText);
  const issues = [];
  const add = (dimension, severity, required_property, summary) => issues.push({ dimension, severity, required_property, summary });
  const at = d => `line ${doc.lineOffset + d.line + 1}`;
  const fm = doc.frontmatter;

  if (!doc.frontmatterPresent) add(DIMENSIONS.INTENT_STRUCTURE, SEVERITY.BLOCKER, "An intent opens with YAML frontmatter", "no frontmatter block (--- ... ---) at the top of the file");
  else if (doc.frontmatterError) add(DIMENSIONS.INTENT_STRUCTURE, SEVERITY.BLOCKER, "Frontmatter is valid YAML", `frontmatter does not parse: ${doc.frontmatterError}`);
  if (fm) {
    const id = typeof fm.id === "string" ? fm.id.trim() : null;
    if (id === null) add(DIMENSIONS.INTENT_STRUCTURE, SEVERITY.BLOCKER, "Frontmatter carries the intent id (id: INT-NNNN)", "frontmatter has no id");
    else if (!/^INT-\d{4}$/.test(id)) add(DIMENSIONS.ID_GRAMMAR, SEVERITY.BLOCKER, "The intent id is INT-NNNN (four digits)", `id "${quote(id, 40)}" is not INT-NNNN`);
    else if (options.fileName) {
      const base = path.basename(options.fileName);
      if (/^INT-\d{4}/.test(base) && !base.startsWith(id)) add(DIMENSIONS.INTENT_STRUCTURE, SEVERITY.WARNING, "The file is named docs/intent/<id>-<slug>.md", `file ${base} does not match id ${id}`);
    }
    for (const key of ["title", "owner"]) {
      if (typeof fm[key] !== "string" || !fm[key].trim() || /^<.*>$/.test(fm[key].trim())) add(DIMENSIONS.INTENT_STRUCTURE, SEVERITY.WARNING, `Frontmatter names the ${key}`, `frontmatter has no ${key}`);
    }
    if (typeof fm.status !== "string" || !INTENT_STATUS_RE.test(fm.status.trim())) add(DIMENSIONS.INTENT_STRUCTURE, SEVERITY.WARNING, "status is draft | accepted | superseded-by INT-NNNN | retired", `status "${quote(fm.status ?? "(missing)", 40)}" is not an intent status`);
  }
  if (doc.unclosedFence) add(DIMENSIONS.INTENT_STRUCTURE, SEVERITY.WARNING, "Every code fence is closed", "an unclosed code fence hides the rest of the intent from every check");
  if (/\bTBD\b/.test(doc.body)) add(DIMENSIONS.INTENT_STRUCTURE, SEVERITY.WARNING, "Never write TBD: delete the empty section or record an open question", "the intent contains TBD");

  checkIds(doc, add, { malformedSeverity: SEVERITY.WARNING });
  for (const d of doc.definitions.filter(x => x.cls && !INTENT_ID_KINDS.has(x.cls.kind))) {
    add(DIMENSIONS.ID_GRAMMAR, SEVERITY.WARNING, "An intent defines NG, D, OQ and A IDs only; requirements, invariants and evals belong in a SPEC", `${d.token} (${at(d)}) is ${withArticle(d.cls.kind)} ID`);
  }

  // Outcome: exactly one primary metric, at least one guardrail.
  const outcome = findSection(doc, k => k === "outcome");
  if (!outcome) add(DIMENSIONS.OUTCOME, SEVERITY.WARNING, "An intent has an ## Outcome table", "no ## Outcome section");
  else {
    const rows = tablesIn(doc.lines, outcome.start, outcome.end).flatMap(t => t.rows);
    const kindOf = r => stripBold(r.cells[0] ?? "").toLowerCase();
    const primaries = rows.filter(r => kindOf(r) === "primary");
    const guardrails = rows.filter(r => kindOf(r) === "guardrail");
    if (primaries.length !== 1) add(DIMENSIONS.OUTCOME, SEVERITY.WARNING, "Exactly one Primary outcome metric", `${primaries.length} Primary rows`);
    else if (PLACEHOLDER_CELL_RE.test(primaries[0].cells[1] ?? "")) add(DIMENSIONS.OUTCOME, SEVERITY.WARNING, "The Primary row names its metric", "the Primary metric cell is empty or a placeholder");
    if (guardrails.length === 0) add(DIMENSIONS.OUTCOME, SEVERITY.WARNING, "At least one Guardrail metric (what must not regress)", "no Guardrail row");
  }

  // Tradeoff principles: at most 3.
  const tradeoffs = findSection(doc, k => k.startsWith("tradeoff"));
  if (tradeoffs) {
    const count = doc.lines.slice(tradeoffs.start, tradeoffs.end).filter(l => /^(?:[-*+]|\d+[.)])\s/.test(l)).length;
    if (count > MAX_TRADEOFF_PRINCIPLES) add(DIMENSIONS.TRADEOFFS, SEVERITY.WARNING, `At most ${MAX_TRADEOFF_PRINCIPLES} tradeoff principles`, `${count} tradeoff principles`);
  }

  // Assumptions: a table with a kill criterion on every row.
  const assumptions = findSection(doc, k => k.includes("assumption"));
  if (!assumptions) add(DIMENSIONS.ASSUMPTIONS, SEVERITY.WARNING, "An intent lists its bets and assumptions with kill criteria", "no assumptions section");
  else {
    const tables = tablesIn(doc.lines, assumptions.start, assumptions.end);
    const table = tables.find(t => t.rows.some(r => /^A-\d/.test(stripBold(r.cells[0] ?? ""))));
    if (!table) add(DIMENSIONS.ASSUMPTIONS, SEVERITY.WARNING, "The assumptions table has A-NN rows", "no A-NN assumption rows");
    else {
      const kill = table.header.findIndex(h => /kill/i.test(h));
      if (kill < 0) add(DIMENSIONS.ASSUMPTIONS, SEVERITY.WARNING, "The assumptions table has a Kill criterion column", "no Kill criterion column");
      else {
        for (const r of table.rows) {
          const id = stripBold(r.cells[0] ?? "");
          if (/^A-\d/.test(id) && PLACEHOLDER_CELL_RE.test(r.cells[kill] ?? "")) add(DIMENSIONS.ASSUMPTIONS, SEVERITY.WARNING, "Every assumption has an observable kill criterion", `${id} (line ${doc.lineOffset + r.line + 1}) has no kill criterion`);
        }
      }
    }
  }

  return { verdict: issues.length === 0 ? "PASS" : "ISSUES", issues };
}

/** "spec" | "intent": frontmatter `spec:` wins; then an INT-NNNN id or file name; else spec. */
export function detectDocKind(rawText, fileName = "") {
  const doc = parseDocument(rawText);
  const fm = doc.frontmatter;
  if (fm && fm.spec !== undefined) return "spec";
  if (fm && typeof fm.id === "string" && /^INT-/.test(fm.id.trim())) return "intent";
  if (/^INT-\d{4}/.test(path.basename(String(fileName)))) return "intent";
  return "spec";
}

export function formatSpecLintResult(result, file, kind = "spec") {
  const c = countBySeverity(result);
  const head = `spec-lint ${file}${kind === "intent" ? " (intent)" : ""}`;
  if (result.verdict === "PASS") return `${head}: PASS`;
  const lines = [`${head}: ISSUES (${c.blocker} blocker, ${c.warning} warning, ${c.info} info)`];
  for (const i of result.issues) {
    lines.push(`  ${i.severity.toUpperCase()} [${i.dimension}] ${i.summary}`);
    lines.push(`    required: ${i.required_property}`);
  }
  return lines.join("\n");
}

/**
 * CLI entry: `spec-lint <file> [--intent] [--json] [--root <dir>]`. Returns the exit code:
 * 0 no blockers, 1 blockers, 2 not evaluated (usage error, missing/unreadable/oversized file).
 */
export function runSpecLintCli(args, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const cwd = io.cwd ?? process.cwd();
  const usage = "usage: muster spec-lint <SPEC.md | INT-NNNN-<slug>.md> [--intent] [--json] [--root <dir>]";
  const positionals = [];
  let json = false;
  let intent = false;
  let root = null;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--intent") intent = true;
    else if (a === "--root") {
      root = args[i + 1];
      i += 1;
      if (!root) { stderr.write(`muster: spec-lint: --root needs a directory\n${usage}\n`); return 2; }
    } else if (a.startsWith("--")) { stderr.write(`muster: spec-lint: unknown flag ${a}\n${usage}\n`); return 2; }
    else positionals.push(a);
  }
  if (positionals.length !== 1) { stderr.write(`muster: spec-lint: expected one SPEC.md or intent path\n${usage}\n`); return 2; }
  const file = path.resolve(cwd, positionals[0]);
  const projectRoot = path.resolve(cwd, root ?? ".");
  let text;
  try {
    text = readBounded(file);
  } catch (error) {
    stderr.write(`muster: spec-lint: cannot read ${positionals[0]}: ${error.code ?? error.message} (not evaluated)\n`);
    return 2;
  }
  const kind = intent ? "intent" : detectDocKind(text, file);
  const result = kind === "intent" ? lintIntent(text, { projectRoot, fileName: file }) : lintSpec(text, { projectRoot });
  stdout.write(`${json ? JSON.stringify(result, null, 2) : formatSpecLintResult(result, positionals[0], kind)}\n`);
  return countBySeverity(result).blocker > 0 ? 1 : 0;
}
