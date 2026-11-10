// Book runs: a long-form manuscript (fiction or nonfiction) that is written over many sessions.
// The run directory `.muster/runs/<runId>/` is committed on the work branch and holds:
//
//   book.json   the ledger: outline, chapter states, canon facts and continuity debts (source of truth)
//   CANON.md    the story bible rendered from book.json (agents read it; never hand-edited)
//   LEDGER.md   the chapter ledger and open debts, rendered from book.json
//   chapters/   one Markdown file per chapter, written by the book-writer agent
//   STATE.md    `## Log` lines appended by `muster book record`
//
// A canon fact is something the manuscript has committed to (a character's eye colour, the year
// the war ended, a defined term, a claim and its source). A continuity debt is an open
// contradiction between a chapter and the canon: the checker found one, or a canon fact was
// amended after chapters that rely on it were written. Debts stay open until a re-check passes or
// the author closes them, so a later session cannot quietly forget a break an earlier one made.
//
// The plugin/workflows/book.js script fans the agents out and returns schema-validated JSON; it has
// no filesystem access, so every ledger write happens here, deterministically, from that result.
import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { appendStateLog, assertRunId, ensureRunDir, runDir } from "./run-dir.js";
import { readContainedFile, sha256, writeContainedFile } from "./fs-safe.js";

export const BOOK_VERSION = 1;
export const CHAPTER_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const CANON_CATEGORIES = Object.freeze(["character", "world", "place", "timeline", "object", "term", "claim", "source", "style", "other"]);
export const DEBT_SEVERITIES = Object.freeze(["blocker", "major", "minor"]);
export const DEFAULT_LIMIT = 4;
export const DEFAULT_BETA_READERS = 3;
const MAX_TEXT = 2000;

const list = (xs) => (Array.isArray(xs) ? xs : []);
const text = (v, max = MAX_TEXT) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const intOr = (v, d) => (Number.isInteger(v) && v >= 0 ? v : d);
const norm = (s) => text(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const pad = (n) => String(n).padStart(3, "0");
const nextId = (prefix, items) => `${prefix}-${pad(1 + items.reduce((m, x) => Math.max(m, Number(String(x.id).slice(prefix.length + 1)) || 0), 0))}`;

// The plugin's builtins directory, the agents' reference shelf. Workflow agents cannot rely on
// $CLAUDE_PLUGIN_ROOT, and a haiku agent sent to find the shelf searched the whole filesystem in
// the 2026-11-10 smoke, so the CLI resolves it from its own location (source checkout, or the
// bundled plugin/runtime/cli/bin/muster.mjs) and hands it to every brief.
export function builtinsDir() {
  for (const rel of ["../plugin/builtins/", "../../../builtins/"]) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(join(dir, "book-run", "SKILL.md"))) return dir.replace(/[\\/]+$/, "");
  }
  return null;
}

export const chapterPath = (runId, id) => `.muster/runs/${runId}/chapters/${id}.md`;
export const wordCount = (s) => (String(s).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;

// ---- validation ---------------------------------------------------------------------------

// Kahn layering over a chapter subset. Dependencies outside the subset count as satisfied when
// `done(id)` says so; otherwise the chapter is blocked for this pass.
export function chapterWaves(chapters, { done = () => false } = {}) {
  const ids = new Set(chapters.map((c) => c.id));
  const waves = [];
  const blocked = [];
  const placed = new Set();
  let pending = chapters.filter((c) => {
    const missing = list(c.dependsOn).filter((d) => !ids.has(d) && !done(d));
    if (missing.length) blocked.push({ id: c.id, waitingOn: missing });
    return !missing.length;
  });
  const blockedIds = new Set(blocked.map((b) => b.id));
  // A chapter that depends on a blocked one is blocked too.
  for (let changed = true; changed;) {
    changed = false;
    pending = pending.filter((c) => {
      const via = list(c.dependsOn).filter((d) => blockedIds.has(d));
      if (!via.length) return true;
      blocked.push({ id: c.id, waitingOn: via });
      blockedIds.add(c.id);
      changed = true;
      return false;
    });
  }
  while (pending.length) {
    const ready = pending.filter((c) => list(c.dependsOn).every((d) => placed.has(d) || (!ids.has(d) && done(d))));
    if (!ready.length) {
      for (const c of pending) blocked.push({ id: c.id, waitingOn: list(c.dependsOn).filter((d) => !placed.has(d)), cycle: true });
      break;
    }
    waves.push(ready);
    for (const c of ready) placed.add(c.id);
    pending = pending.filter((c) => !placed.has(c.id));
  }
  return { waves, blocked };
}

// Outline -> problems. The outline comes from the book-writer agent (OUTLINE_RESULT), so every
// field is checked rather than trusted.
export function validateOutline(outline) {
  const problems = [];
  if (!outline || typeof outline !== "object") return ["outline must be an object"];
  if (!["fiction", "nonfiction"].includes(outline.kind)) problems.push('kind must be "fiction" or "nonfiction"');
  if (!text(outline.title)) problems.push("title is required");
  const chapters = list(outline.chapters);
  if (!chapters.length) problems.push("outline has no chapters");
  const seen = new Set();
  for (const [i, c] of chapters.entries()) {
    if (!c || !CHAPTER_ID_RE.test(String(c.id))) { problems.push(`chapters[${i}].id must match ${CHAPTER_ID_RE}`); continue; }
    if (seen.has(c.id)) problems.push(`chapter ${c.id} appears twice`);
    seen.add(c.id);
    if (!text(c.goal)) problems.push(`chapter ${c.id} has no goal (what the chapter must do)`);
  }
  for (const c of chapters) for (const d of list(c?.dependsOn)) {
    if (!seen.has(d)) problems.push(`chapter ${c.id} depends on unknown chapter ${d}`);
    if (d === c?.id) problems.push(`chapter ${c.id} depends on itself`);
  }
  if (!problems.length) {
    const { blocked } = chapterWaves(chapters);
    const cyc = blocked.filter((b) => b.cycle).map((b) => b.id);
    if (cyc.length) problems.push(`dependency cycle among ${cyc.join(", ")}`);
  }
  return problems;
}

// ---- construction ---------------------------------------------------------------------------

export function newBook(runId, outline) {
  assertRunId(runId);
  const problems = validateOutline(outline);
  if (problems.length) return { book: null, problems };
  const voice = outline.voice && typeof outline.voice === "object" ? outline.voice : {};
  const book = {
    version: BOOK_VERSION,
    runId,
    title: text(outline.title, 200),
    kind: outline.kind,
    premise: text(outline.premise),
    voice: { pov: text(voice.pov, 80), tense: text(voice.tense, 40), notes: text(voice.notes) },
    chapters: list(outline.chapters).map((c) => ({
      id: c.id,
      title: text(c.title, 200),
      goal: text(c.goal),
      dependsOn: [...new Set(list(c.dependsOn))],
      pov: text(c.pov || voice.pov, 80),
      tense: text(c.tense || voice.tense, 40),
      targetWords: intOr(c.targetWords, 0),
      status: "planned",
      path: chapterPath(runId, c.id),
      words: 0,
      hash: null,
      summary: "",
      canonRefs: [],
    })),
    canon: [],
    debts: [],
    passes: [],
  };
  for (const f of list(outline.canon)) addCanon(book, f, "outline");
  return { book, problems: [] };
}

function addCanon(book, fact, source) {
  const body = text(fact?.fact);
  if (!body) return null;
  const existing = book.canon.find((c) => c.status === "active" && norm(c.fact) === norm(body));
  if (existing) return existing;
  const category = CANON_CATEGORIES.includes(fact?.category) ? fact.category : "other";
  const entry = { id: nextId("C", book.canon), fact: body, category, source, status: "active", supersededBy: null };
  book.canon.push(entry);
  return entry;
}

function openDebt(book, debt) {
  const key = (d) => `${d.chapter}|${d.canonId || ""}|${norm(d.quote || d.summary)}`;
  const k = key(debt);
  const dup = book.debts.find((d) => d.status === "open" && key(d) === k);
  if (dup) return null;
  const entry = {
    id: nextId("D", book.debts),
    chapter: debt.chapter,
    canonId: debt.canonId || null,
    line: Number.isInteger(debt.line) && debt.line > 0 ? debt.line : null,
    quote: text(debt.quote, 400),
    summary: text(debt.summary),
    severity: DEBT_SEVERITIES.includes(debt.severity) ? debt.severity : "major",
    origin: debt.origin,
    maybeIntentional: !!debt.maybeIntentional,
    status: "open",
    resolution: "",
  };
  book.debts.push(entry);
  return entry;
}

function closeDebt(book, id, resolution) {
  const d = book.debts.find((x) => x.id === id && x.status === "open");
  if (!d) return null;
  d.status = "closed";
  d.resolution = text(resolution, 400);
  return d;
}

export const openDebts = (book, chapter) => book.debts.filter((d) => d.status === "open" && (!chapter || d.chapter === chapter));
const chapterById = (book, id) => book.chapters.find((c) => c.id === id);
const isWritten = (c) => !!c && c.status !== "planned";
// Drafted, but no continuity check has passed (it abstained, errored or never ran) and no debt
// explains why: there is no evidence either way, so the next pass re-checks it.
const unchecked = (c) => c.status === "drafted";

// ---- propagation: amending a canon fact puts every chapter that relied on it in debt -----------

export function amendCanon(book, canonId, newFact) {
  const old = book.canon.find((c) => c.id === canonId);
  if (!old) return { ok: false, problems: [`no canon fact ${canonId}`] };
  if (old.status !== "active") return { ok: false, problems: [`${canonId} is already superseded by ${old.supersededBy}`] };
  if (!text(newFact)) return { ok: false, problems: ["the amended fact is empty"] };
  old.status = "superseded";
  const next = { id: nextId("C", book.canon), fact: text(newFact), category: old.category, source: `amend ${canonId}`, status: "active", supersededBy: null };
  book.canon.push(next);
  old.supersededBy = next.id;
  const opened = [];
  for (const ch of book.chapters) {
    if (!isWritten(ch) || !ch.canonRefs.includes(canonId)) continue;
    const d = openDebt(book, {
      chapter: ch.id, canonId: next.id, origin: "amend", severity: "major",
      summary: `canon ${canonId} ("${old.fact}") was amended to ${next.id} ("${next.fact}"); bring ${ch.id} into line`,
    });
    if (d) opened.push(d.id);
    ch.canonRefs = ch.canonRefs.map((r) => (r === canonId ? next.id : r));
  }
  return { ok: true, canonId: next.id, superseded: canonId, opened };
}

// ---- workflow args ------------------------------------------------------------------------------

// Chapters whose file changed since the last `record` are stale: the edit may have broken canon,
// so they are re-checked before anything else builds on them.
export function staleChapters(book, hashes) {
  return book.chapters.filter((c) => isWritten(c) && c.hash && hashes[c.id] !== undefined && hashes[c.id] !== c.hash).map((c) => c.id);
}

export function bookArgs(book, { hashes = {}, limit = DEFAULT_LIMIT, models = null, beta = null, shelf = null } = {}) {
  const stale = new Set(staleChapters(book, hashes));
  const missing = book.chapters.filter((c) => isWritten(c) && hashes[c.id] === null).map((c) => c.id);
  const planned = book.chapters.filter((c) => c.status === "planned");
  const { waves: allWaves, blocked } = chapterWaves(planned, { done: (id) => isWritten(chapterById(book, id)) });
  // Take whole waves in order until the chapter budget is spent (at least one wave when any is ready).
  const waves = [];
  let taken = 0;
  for (const w of allWaves) {
    if (taken && taken + w.length > limit) break;
    const slice = w.slice(0, Math.max(1, limit - taken));
    waves.push(slice);
    taken += slice.length;
    if (slice.length < w.length) break;
  }
  const brief = (c) => ({ id: c.id, title: c.title, goal: c.goal, pov: c.pov, tense: c.tense, targetWords: c.targetWords, dependsOn: c.dependsOn, path: c.path });
  const drafting = new Set(waves.flat().map((c) => c.id));
  const recheck = book.chapters
    .filter((c) => isWritten(c) && !drafting.has(c.id) && !missing.includes(c.id) && (stale.has(c.id) || openDebts(book, c.id).length || unchecked(c)))
    .map((c) => ({
      ...brief(c),
      reason: stale.has(c.id) ? "edited since last record" : openDebts(book, c.id).length ? "open continuity debts" : "no continuity check has passed yet",
      debts: openDebts(book, c.id).map((d) => ({ id: d.id, canonId: d.canonId, line: d.line, quote: d.quote, summary: d.summary })),
    }));
  const remainingAfter = planned.length - taken;
  const complete = remainingAfter === 0;
  const dir = `.muster/runs/${book.runId}`;
  const args = {
    runId: book.runId,
    mode: "pass",
    title: book.title,
    kind: book.kind,
    voice: book.voice,
    canonPath: `${dir}/CANON.md`,
    ledgerPath: `${dir}/LEDGER.md`,
    waves: waves.map((w) => w.map(brief)),
    recheck,
    manuscript: book.chapters.map((c) => ({ id: c.id, title: c.title, path: c.path, status: c.status, summary: c.summary })),
    passes: {
      continuity: true,
      developmental: complete,
      lineEdit: complete,
      beta: complete ? (Number.isInteger(beta) ? beta : DEFAULT_BETA_READERS) : 0,
    },
    ...(models ? { models } : {}),
    ...(shelf ? { builtinsDir: shelf } : {}),
  };
  return { args, blocked, missing, remaining: remainingAfter, stale: [...stale] };
}

// ---- recording a workflow result ------------------------------------------------------------------

// Apply a book.js pass result to the ledger. `files` maps chapter id -> current file text (or null
// when absent): word counts and hashes come from disk, never from the agent's own report.
export function recordResult(book, result, { files = {} } = {}) {
  const problems = [];
  const added = [];
  const opened = [];
  const closed = [];
  const drafted = [];
  const failed = [];
  if (!result || typeof result !== "object") return { ok: false, problems: ["result must be an object"] };
  if (result.runId && result.runId !== book.runId) return { ok: false, problems: [`result is for run ${result.runId}, not ${book.runId}`] };

  const refsFor = (ch, ids) => { for (const id of ids) if (book.canon.some((c) => c.id === id) && !ch.canonRefs.includes(id)) ch.canonRefs.push(id); };
  const applyDraft = (d) => {
    const ch = chapterById(book, d?.chapterId);
    if (!ch) { if (d?.chapterId) problems.push(`draft for unknown chapter ${d.chapterId}`); return; }
    if (d.status !== "done") { failed.push(ch.id); return; }
    const body = files[ch.id];
    if (typeof body !== "string") { problems.push(`${ch.id}: the writer reported done but ${ch.path} is missing`); failed.push(ch.id); return; }
    if (ch.status === "planned") { ch.status = "drafted"; drafted.push(ch.id); }
    if (text(d.summary)) ch.summary = text(d.summary, 600);
    refsFor(ch, list(d.canonUsed));
    for (const f of list(d.newCanon)) {
      const before = book.canon.length;
      const entry = addCanon(book, f, ch.id);
      if (!entry) continue;
      if (book.canon.length > before) added.push(entry.id);
      refsFor(ch, [entry.id]);
    }
  };

  for (const d of list(result.drafts)) applyDraft(d);
  for (const c of list(result.continuity)) for (const fx of list(c.fixes)) applyDraft(fx);

  for (const c of list(result.continuity)) {
    const ch = chapterById(book, c?.chapterId);
    if (!ch || !isWritten(ch)) continue;
    const fin = c.final;
    if (!fin || fin.status === "error" || !["PASS", "ISSUES"].includes(fin.verdict)) continue; // ABSTAIN or error: no evidence either way
    const shown = new Set(list(c.debtsShown));
    for (const id of list(fin.debtsResolved)) if (shown.has(id) && closeDebt(book, id, `re-check passed (${c.chapterId})`)) closed.push(id);
    const issues = list(fin.issues);
    if (fin.verdict === "PASS" && !issues.length) {
      for (const id of shown) if (closeDebt(book, id, `re-check passed (${c.chapterId})`)) closed.push(id);
      if (ch.status === "drafted") ch.status = "checked";
    }
    for (const i of issues) {
      const target = chapterById(book, i.chapter) ? i.chapter : ch.id;
      const canonId = book.canon.some((k) => k.id === i.canonId) ? i.canonId : null;
      const d = openDebt(book, {
        chapter: target, canonId, line: i.line, quote: i.quote, severity: i.severity, origin: "continuity",
        maybeIntentional: i.maybeIntentional,
        summary: `${i.kind ? `[${i.kind}] ` : ""}${text(i.summary)}${!canonId && text(i.canonFact) ? ` (established: ${text(i.canonFact, 300)})` : ""}`,
      });
      if (d) opened.push(d.id);
    }
  }

  // A line edit must not move a canon fact. If it did, the chapter now disagrees with the bible: debt.
  for (const e of list(result.lineEdits)) {
    const ch = chapterById(book, e?.chapterId);
    if (!ch || e.status !== "done") continue;
    if (["drafted", "checked"].includes(ch.status)) ch.status = "edited";
    for (const t of list(e.canonTouched)) {
      const d = openDebt(book, {
        chapter: ch.id, canonId: book.canon.some((k) => k.id === t.canonId) ? t.canonId : null, line: t.line, quote: t.after,
        severity: "major", origin: "line-edit",
        summary: `line edit changed a canon-bearing passage: "${text(t.before, 200)}" -> "${text(t.after, 200)}"`,
      });
      if (d) opened.push(d.id);
    }
  }

  for (const ch of book.chapters) {
    const body = files[ch.id];
    if (typeof body === "string" && isWritten(ch)) { ch.words = wordCount(body); ch.hash = sha256(body); }
  }

  const dev = result.development && !result.development.status ? result.development : null;
  const pass = {
    n: book.passes.length + 1,
    drafted, failed, canonAdded: added, debtsOpened: opened, debtsClosed: closed,
    developmental: dev ? { verdict: dev.verdict, notes: list(dev.notes).length } : null,
    lineEdited: list(result.lineEdits).filter((e) => e?.status === "done").map((e) => e.chapterId),
    beta: list(result.beta).filter((b) => b && !b.status).map((b) => ({ persona: text(b.persona, 80), finished: !!b.finished, putDown: text(b.putDownChapter, 32) })),
  };
  book.passes.push(pass);
  return { ok: true, problems, pass };
}

// ---- status -------------------------------------------------------------------------------------

export function bookStatus(book, { hashes = {} } = {}) {
  const count = (s) => book.chapters.filter((c) => c.status === s).length;
  const stale = staleChapters(book, hashes);
  const debts = openDebts(book);
  const planned = count("planned");
  const unverified = book.chapters.filter((c) => unchecked(c) && !openDebts(book, c.id).length).length;
  let next;
  if (stale.length || debts.length || unverified) next = { action: "recheck", why: `${debts.length} open debt(s), ${stale.length} edited chapter(s), ${unverified} chapter(s) with no passing continuity check` };
  else if (planned) next = { action: "draft", why: `${planned} chapter(s) not drafted` };
  else if (!book.passes.some((p) => p.beta?.length)) next = { action: "polish", why: "all chapters drafted; developmental, line and beta passes not yet run" };
  else next = { action: "review", why: "manuscript complete and clean: the author decides; a simulated beta read never marks a book ready" };
  return {
    runId: book.runId, title: book.title, kind: book.kind,
    chapters: { total: book.chapters.length, planned, drafted: count("drafted"), checked: count("checked"), edited: count("edited") },
    words: book.chapters.reduce((n, c) => n + c.words, 0),
    canon: { active: book.canon.filter((c) => c.status === "active").length, superseded: book.canon.filter((c) => c.status !== "active").length },
    openDebts: debts.length, stale, passes: book.passes.length, next,
  };
}

// ---- rendering ----------------------------------------------------------------------------------

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|");

export function renderCanon(book) {
  const out = [`# Canon: ${book.title}`, "", "<!-- Generated by `muster book` from book.json. Do not edit; amend facts with `muster book amend`. -->", ""];
  out.push(`- Kind: ${book.kind}`, `- POV: ${book.voice.pov || "(unset)"}`, `- Tense: ${book.voice.tense || "(unset)"}`);
  if (book.voice.notes) out.push(`- Voice: ${book.voice.notes}`);
  if (book.premise) out.push(`- Premise: ${book.premise}`);
  out.push("");
  for (const cat of CANON_CATEGORIES) {
    const facts = book.canon.filter((c) => c.status === "active" && c.category === cat);
    if (!facts.length) continue;
    out.push(`## ${cat}`, "");
    for (const f of facts) out.push(`- **${f.id}** ${f.fact} _(${f.source})_`);
    out.push("");
  }
  const old = book.canon.filter((c) => c.status !== "active");
  if (old.length) {
    out.push("## superseded", "");
    for (const f of old) out.push(`- ~~${f.id} ${f.fact}~~ -> ${f.supersededBy}`);
    out.push("");
  }
  return out.join("\n");
}

export function renderLedger(book) {
  const out = [`# Ledger: ${book.title}`, "", "<!-- Generated by `muster book` from book.json. Do not edit. -->", ""];
  out.push("| Chapter | Title | Status | Words | Depends on | Open debts |", "|---|---|---|---|---|---|");
  for (const c of book.chapters) out.push(`| ${c.id} | ${cell(c.title)} | ${c.status} | ${c.words} | ${c.dependsOn.join(", ")} | ${openDebts(book, c.id).length} |`);
  out.push("", "## Open continuity debts", "");
  const debts = openDebts(book);
  if (!debts.length) out.push("None.");
  for (const d of debts) out.push(`- **${d.id}** ${d.chapter}${d.line ? `:${d.line}` : ""} [${d.severity}, ${d.origin}]${d.canonId ? ` vs ${d.canonId}` : ""}: ${d.summary}${d.quote ? ` > "${d.quote}"` : ""}${d.maybeIntentional ? " (may be intentional)" : ""}`);
  out.push("", "## Chapter summaries", "");
  for (const c of book.chapters.filter((x) => x.summary)) out.push(`- **${c.id}** ${c.summary}`);
  out.push("");
  return out.join("\n");
}

// ---- disk I/O -----------------------------------------------------------------------------------

const exists = (path) => access(path).then(() => true, () => false);

// Reading never creates directories: a typo'd runId must not leave an empty run behind.
async function readBook(cwd, runId) {
  const path = join(runDir(cwd, runId), "book.json");
  if (!(await exists(path))) return null;
  const bytes = await readContainedFile(cwd, path);
  const book = JSON.parse(bytes.toString("utf8"));
  if (book.version !== BOOK_VERSION) throw new Error(`book.json version ${book.version} is not ${BOOK_VERSION}`);
  return book;
}

async function writeBook(cwd, book) {
  const dir = await ensureRunDir(cwd, book.runId);
  await writeContainedFile(cwd, join(dir, "book.json"), `${JSON.stringify(book, null, 2)}\n`);
  await writeContainedFile(cwd, join(dir, "CANON.md"), renderCanon(book));
  await writeContainedFile(cwd, join(dir, "LEDGER.md"), renderLedger(book));
}

async function chapterFiles(cwd, book) {
  const files = {};
  for (const c of book.chapters) {
    const path = join(cwd, c.path);
    files[c.id] = (await exists(path)) ? (await readContainedFile(cwd, path)).toString("utf8") : null;
  }
  return files;
}
const hashesOf = (files) => Object.fromEntries(Object.entries(files).map(([id, body]) => [id, typeof body === "string" ? sha256(body) : null]));

async function readJsonFile(cwd, path) {
  const bytes = await readContainedFile(cwd, path);
  return JSON.parse(bytes.toString("utf8"));
}

export async function initBook({ cwd, runId, outlineFile }) {
  if (await readBook(cwd, runId)) return { ok: false, problems: [`.muster/runs/${runId}/book.json already exists`] };
  let outline = await readJsonFile(cwd, outlineFile);
  if (outline && outline.outline) outline = outline.outline; // accept the whole workflow result
  const { book, problems } = newBook(runId, outline);
  if (!book) return { ok: false, problems };
  await writeBook(cwd, book);
  await appendStateLog(cwd, runId, [`book init: ${book.chapters.length} chapters, ${book.canon.length} canon facts`]);
  return { ok: true, runId, chapters: book.chapters.length, canon: book.canon.length };
}

export const BOOK_SEATS = Object.freeze(["writer", "continuity", "dev", "line", "beta"]);
// One model for every book seat (`--model haiku` for a cheap run); unset, each agent's frontmatter decides.
export const seatModelsFor = (model) => (model ? Object.fromEntries(BOOK_SEATS.map((s) => [s, { model }])) : null);

export async function writeBookArgs({ cwd, runId, limit, beta, models }) {
  const book = await readBook(cwd, runId);
  if (!book) return { ok: false, problems: [`.muster/runs/${runId}/book.json not found: run \`muster book init\` first`] };
  const seatModels = models || null;
  const files = await chapterFiles(cwd, book);
  const { args, blocked, missing, remaining, stale } = bookArgs(book, { hashes: hashesOf(files), limit, beta, models: seatModels, shelf: builtinsDir() });
  await writeContainedFile(cwd, join(runDir(cwd, runId), "book-args.json"), `${JSON.stringify(args, null, 2)}\n`);
  const drafting = args.waves.flat().map((c) => c.id);
  const problems = missing.map((id) => `${id} is recorded as written but its chapter file is missing`);
  return { ok: !problems.length, runId, path: `.muster/runs/${runId}/book-args.json`, drafting, recheck: args.recheck.map((c) => c.id), stale, blocked, remaining, passes: args.passes, problems };
}

export async function recordBook({ cwd, runId, resultFile }) {
  const book = await readBook(cwd, runId);
  if (!book) return { ok: false, problems: [`.muster/runs/${runId}/book.json not found`] };
  const result = await readJsonFile(cwd, resultFile);
  const files = await chapterFiles(cwd, book);
  const report = recordResult(book, result, { files });
  if (!report.ok) return report;
  await writeBook(cwd, book);
  const p = report.pass;
  await appendStateLog(cwd, runId, [
    `book pass ${p.n}: drafted ${p.drafted.join(", ") || "none"}${p.failed.length ? `; failed ${p.failed.join(", ")}` : ""}; canon +${p.canonAdded.length}; debts +${p.debtsOpened.length} -${p.debtsClosed.length}`,
  ]);
  return { ok: true, runId, ...p, problems: report.problems, status: bookStatus(book, { hashes: hashesOf(files) }) };
}

async function mutate(cwd, runId, fn, log) {
  const book = await readBook(cwd, runId);
  if (!book) return { ok: false, problems: [`.muster/runs/${runId}/book.json not found`] };
  const r = fn(book);
  if (!r.ok) return r;
  await writeBook(cwd, book);
  await appendStateLog(cwd, runId, [log(r)]);
  return r;
}

export async function statusOfBook({ cwd, runId }) {
  const book = await readBook(cwd, runId);
  if (!book) {
    const dir = await exists(runDir(cwd, runId));
    return { runId, next: { action: "outline", why: dir ? "run directory has no book.json" : "no run directory yet" } };
  }
  return bookStatus(book, { hashes: hashesOf(await chapterFiles(cwd, book)) });
}

const USAGE = "book <init <runId> --outline <file>|args <runId> [--limit N] [--beta N] [--model M]|record <runId> --result <file>|amend <runId> <canonId> <fact>|close <runId> <debtId> <resolution>|status <runId>>";

function flag(rest, name) {
  const i = rest.indexOf(name);
  return i >= 0 && rest[i + 1] !== undefined && !rest[i + 1].startsWith("--") ? rest[i + 1] : undefined;
}

// CLI entry: returns { code, report }. Kept here so src/cli.js only dispatches.
export async function runBookCli(rest, { cwd = process.cwd() } = {}) {
  const [sub, runId, ...more] = rest;
  const bad = (msg) => ({ code: 2, report: { ok: false, problems: [`${msg}. Usage: muster ${USAGE}`] } });
  if (!sub || !runId) return bad("missing subcommand or runId");
  try { assertRunId(runId); } catch (e) { return bad(e.message); }
  const done = (report) => ({ code: report.ok === false ? 1 : 0, report });
  const num = (v) => (v === undefined ? undefined : Number.parseInt(v, 10));
  switch (sub) {
    case "init": {
      const outlineFile = flag(more, "--outline");
      if (!outlineFile) return bad("init needs --outline <file>");
      return done(await initBook({ cwd, runId, outlineFile: resolve(cwd, outlineFile) }));
    }
    case "args": {
      const limit = num(flag(more, "--limit"));
      const beta = num(flag(more, "--beta"));
      if ((limit !== undefined && !(limit > 0)) || (beta !== undefined && !(beta >= 0))) return bad("--limit must be > 0 and --beta >= 0");
      const model = flag(more, "--model");
      if (model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,63}$/.test(model)) return bad("--model must be a model alias or id");
      return done(await writeBookArgs({ cwd, runId, limit: limit ?? DEFAULT_LIMIT, beta, models: seatModelsFor(model) }));
    }
    case "record": {
      const resultFile = flag(more, "--result");
      if (!resultFile) return bad("record needs --result <file>");
      return done(await recordBook({ cwd, runId, resultFile: resolve(cwd, resultFile) }));
    }
    case "amend": {
      const [canonId, ...words] = more;
      if (!canonId || !words.length) return bad("amend needs <canonId> <fact>");
      return done(await mutate(cwd, runId, (b) => amendCanon(b, canonId, words.join(" ")), (r) => `book amend: ${r.superseded} -> ${r.canonId}; debts opened ${r.opened.join(", ") || "none"}`));
    }
    case "close": {
      const [debtId, ...words] = more;
      if (!debtId || !words.length) return bad("close needs <debtId> <resolution>");
      return done(await mutate(cwd, runId, (b) => (closeDebt(b, debtId, words.join(" ")) ? { ok: true, closed: debtId } : { ok: false, problems: [`no open debt ${debtId}`] }), (r) => `book close: ${r.closed}`));
    }
    case "status":
      return done(await statusOfBook({ cwd, runId }));
    default:
      return bad(`unknown subcommand ${sub}`);
  }
}
