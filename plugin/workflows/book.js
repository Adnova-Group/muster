export const meta = {
  name: 'book',
  description: 'One pass over a muster book run: outline it, or draft chapters in dependency waves, then continuity, developmental, line and beta-read passes',
  whenToUse: 'From /muster:write-book. Pass {mode:"outline", runId, brief} or the exact contents of .muster/runs/<id>/book-args.json, then record the result with `muster book init` or `muster book record`.',
  phases: [
    { title: 'Outline', detail: 'book-writer outlines (variants in parallel); book-developmental-editor checks; at most 2 revisions' },
    { title: 'Draft', detail: 'one book-writer per chapter, in parallel within a dependency wave' },
    { title: 'Continuity', detail: 'book-continuity-checker per chapter against CANON.md; the writer fixes, at most 2 rounds' },
    { title: 'Develop', detail: 'book-developmental-editor reads the whole manuscript' },
    { title: 'Line', detail: 'book-line-editor per chapter, only after structure passes' },
    { title: 'Beta', detail: 'book-beta-reader personas read the manuscript in order' },
  ],
}

// Contract: plugin/builtins/book-run/SKILL.md (run layout, ledger, commands). The script has no
// filesystem access: agents read and write the chapter files, and `muster book record` turns the
// returned JSON into canon facts and continuity debts. Schemas mirror plugin/workflows/book-schemas.js.

const str = { type: "string" };
const strList = { type: "array", items: str };
const int = { type: "integer" };
const CANON_CATEGORY = { type: "string", enum: ["character", "world", "place", "timeline", "object", "term", "claim", "source", "style", "other"] };

// book-writer, outline mode: the outline and the seed canon, returned as data (the CLI writes book.json).
const OUTLINE_RESULT = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["done", "blocked", "error"] },
    title: str,
    kind: { type: "string", enum: ["fiction", "nonfiction"] },
    premise: str,
    voice: { type: "object", properties: { pov: str, tense: str, notes: str }, required: ["pov", "tense"] },
    chapters: {
      type: "array",
      items: {
        type: "object",
        properties: { id: str, title: str, goal: str, dependsOn: strList, pov: str, tense: str, targetWords: int },
        required: ["id", "title", "goal", "dependsOn"],
      },
    },
    canon: { type: "array", items: { type: "object", properties: { fact: str, category: CANON_CATEGORY }, required: ["fact", "category"] } },
    summary: str,
  },
  required: ["status", "title", "kind", "premise", "voice", "chapters", "canon", "summary"],
};

// book-developmental-editor, outline mode.
const OUTLINE_CHECK = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["PASS", "ISSUES"] },
    score: { type: "integer", minimum: 0, maximum: 10 },
    issues: {
      type: "array",
      items: { type: "object", properties: { chapter: str, severity: str, summary: str }, required: ["severity", "summary"] },
    },
  },
  required: ["verdict", "score", "issues"],
};

// book-writer, draft and revise modes. The chapter text goes to `path`; this is the receipt.
const DRAFT_RESULT = {
  type: "object",
  properties: {
    chapterId: str,
    status: { type: "string", enum: ["done", "blocked", "error"] },
    path: str,
    words: int,
    pov: str,
    tense: str,
    summary: str,
    canonUsed: strList,
    newCanon: {
      type: "array",
      items: { type: "object", properties: { fact: str, category: CANON_CATEGORY, line: int }, required: ["fact", "category"] },
    },
    notes: strList,
  },
  required: ["chapterId", "status", "path", "words", "summary", "canonUsed", "newCanon", "notes"],
};

// book-continuity-checker: one chapter against the canon. Every issue names the chapter, the line,
// the quote and the canon fact it breaks; the CLI turns unresolved issues into debts.
const CONTINUITY_RESULT = {
  type: "object",
  properties: {
    chapterId: str,
    verdict: { type: "string", enum: ["PASS", "ISSUES", "ABSTAIN"] },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          chapter: str,
          line: int,
          quote: str,
          canonId: str,
          canonFact: str,
          kind: { type: "string", enum: ["contradiction", "knowledge", "timeline", "geography", "pov", "tense", "term", "claim", "other"] },
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          summary: str,
          maybeIntentional: { type: "boolean" },
        },
        required: ["chapter", "quote", "canonFact", "kind", "severity", "summary", "maybeIntentional"],
      },
    },
    debtsResolved: strList,
  },
  required: ["chapterId", "verdict", "issues", "debtsResolved"],
};

// book-developmental-editor, manuscript mode. Advisory: notes name a structural action.
const DEV_RESULT = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["PASS", "REVISE", "ABSTAIN"] },
    notes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          chapter: str,
          action: { type: "string", enum: ["cut", "move", "expand", "compress", "combine", "split", "reframe", "seed-earlier", "delay-payoff", "change-decision", "other"] },
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          summary: str,
          readerCost: str,
        },
        required: ["chapter", "action", "severity", "summary", "readerCost"],
      },
    },
    pacing: {
      type: "array",
      items: { type: "object", properties: { chapter: str, tension: { type: "integer", minimum: 1, maximum: 5 }, note: str }, required: ["chapter", "tension"] },
    },
  },
  required: ["verdict", "notes", "pacing"],
};

// book-line-editor: minimal in-place edits. canonTouched should be empty; any entry becomes a debt.
const LINE_RESULT = {
  type: "object",
  properties: {
    chapterId: str,
    status: { type: "string", enum: ["done", "skipped", "error"] },
    path: str,
    edits: int,
    patterns: {
      type: "array",
      items: { type: "object", properties: { name: str, readerCost: str, examples: strList }, required: ["name", "readerCost"] },
    },
    canonTouched: {
      type: "array",
      items: { type: "object", properties: { canonId: str, line: int, before: str, after: str }, required: ["canonId", "before", "after"] },
    },
  },
  required: ["chapterId", "status", "path", "edits", "patterns", "canonTouched"],
};

// book-beta-reader: one simulated first-time reader. A simulated read never marks a book ready.
const BETA_RESULT = {
  type: "object",
  properties: {
    persona: str,
    source: { type: "string", enum: ["simulated"] },
    finished: { type: "boolean" },
    putDownChapter: str,
    putDownWhy: str,
    engagement: {
      type: "array",
      items: { type: "object", properties: { chapter: str, score: { type: "integer", minimum: 1, maximum: 5 }, note: str }, required: ["chapter", "score"] },
    },
    confusions: {
      type: "array",
      items: { type: "object", properties: { chapter: str, line: int, quote: str, note: str }, required: ["chapter", "note"] },
    },
    highlights: {
      type: "array",
      items: { type: "object", properties: { chapter: str, quote: str, note: str }, required: ["chapter", "note"] },
    },
    verdict: str,
  },
  required: ["persona", "source", "finished", "putDownChapter", "engagement", "confusions", "highlights", "verdict"],
};

const FIX_CAP = 2 // writer revisions per chapter after a failing continuity check
const OUTLINE_REVISION_CAP = 2

const AGENT = {
  writer: 'muster:book-writer',
  continuity: 'muster:book-continuity-checker',
  dev: 'muster:book-developmental-editor',
  line: 'muster:book-line-editor',
  beta: 'muster:book-beta-reader',
}

const PERSONAS = {
  fiction: [
    'Genre devourer: reads three or four books a month in this genre, fast, for momentum. Quits the moment a chapter stalls, and says exactly where they nearly stopped.',
    'Close reader: reads for subtext, originality and internal consistency. Notices when a theme is stated instead of earned, and when chapter 7 forgets what chapter 3 said.',
    'Hostile skeptic: did not want to read this. Hunts for plot holes, choices no person would make, and prose that reads as machine-made. Respect from this reader is earned.',
  ],
  nonfiction: [
    'Target reader: has the problem this book promises to solve and little time. Wants to know on every page what to do differently, and drops the book when it stops paying.',
    'Field expert: checks every claim, number and source, and whether the argument actually holds from chapter to chapter.',
    'Skeptic who disagrees with the thesis: hunts for unsupported leaps, cherry-picked evidence and objections the book never answers.',
  ],
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v : { mode: 'outline', brief: raw.trim() }
  } catch (e) {
    return { mode: 'outline', brief: raw.trim() }
  }
}

// model/effort per seat come from args.models[seat], falling back to args.model / args.effort.
// Unset keys are omitted so the agent's own frontmatter (or the session) decides.
function seat(cfg, name) {
  const m = (cfg.models && cfg.models[name]) || {}
  const o = {}
  if (m.model || cfg.model) o.model = m.model || cfg.model
  if (m.effort || cfg.effort) o.effort = m.effort || cfg.effort
  return o
}

// One schema failure (agent() throws after its retry cap) or a skipped agent (null) becomes
// {status:'error'} instead of killing the pass.
async function call(prompt, opts) {
  try {
    const r = await agent(prompt, opts)
    if (r && typeof r === 'object') return r
    return { status: 'error', error: `${opts.label}: agent returned no result` }
  } catch (e) {
    log(`${opts.label} failed: ${(e && e.message) || e}`)
    return { status: 'error', error: `${opts.label}: ${(e && e.message) || e}` }
  }
}

const list = (xs) => (Array.isArray(xs) ? xs : xs ? [xs] : [])
const blocking = (issues) => list(issues).filter((i) => (i.severity === 'blocker' || i.severity === 'major') && !i.maybeIntentional)
const canonLines = (facts) => list(facts).map((f) => `- ${f.chapterId ? `(${f.chapterId}) ` : ''}[${f.category}] ${f.fact}`)

// Where the agents' craft references live. Without it an agent falls back to $CLAUDE_PLUGIN_ROOT.
const shelf = (cfg) => (cfg.builtinsDir ? `Reference shelf (the muster builtins directory named in your instructions): ${cfg.builtinsDir}. Read references from there; never search the filesystem for them.` : '')

function header(cfg) {
  const v = cfg.voice || {}
  return [
    shelf(cfg),
    `Book run ${cfg.runId}: "${cfg.title || ''}" (${cfg.kind || 'fiction'}).`,
    `Canon (binding facts, story bible): ${cfg.canonPath}. Ledger (chapter summaries, open debts): ${cfg.ledgerPath}.`,
    v.pov || v.tense ? `Book voice: POV ${v.pov || '(per chapter)'}, tense ${v.tense || '(per chapter)'}${v.notes ? `; ${v.notes}` : ''}.` : '',
  ]
}

// ---- outline ---------------------------------------------------------------------------------

function outlineBrief(cfg, variant, prior, issues, revision) {
  const lines = [
    `Book run ${cfg.runId}. Outline mode.`,
    shelf(cfg),
    `The author's brief: ${cfg.brief || '(none given: ask nothing, return status "blocked" with the reason in summary)'}`,
    cfg.kind ? `Kind: ${cfg.kind}.` : 'Decide whether this is fiction or nonfiction from the brief.',
    cfg.contextPath ? `Decisions already made: ${cfg.contextPath}. Honour every one.` : '',
    cfg.chapters ? `Aim for about ${cfg.chapters} chapters.` : '',
    variant ? `Variant ${variant}: take a genuinely different angle from the obvious one (structure, entry point or POV), not a reworded copy.` : '',
  ]
  if (prior) {
    lines.push(
      `Revision ${revision} of ${OUTLINE_REVISION_CAP}. Your previous outline, as JSON: ${JSON.stringify(prior)}`,
      'Resolve exactly these developmental issues and return the whole revised outline:',
      ...issues.map((i) => `- [${i.severity}] ${i.chapter ? `${i.chapter}: ` : ''}${i.summary}`),
    )
  }
  lines.push(
    'Return the outline as data; write no files. Chapter ids are short lowercase slugs (ch01, ch02, ...).',
    'dependsOn lists only the chapters a chapter truly needs drafted first (a reveal it pays off, an event it follows). Chapters with no real dependency can be drafted in parallel, so do not chain every chapter to the one before it by reflex.',
    'canon seeds the story bible: the facts every chapter must respect (names, ages, places, world rules, timeline anchors, defined terms; for nonfiction the thesis, key claims and their sources).',
  )
  return lines.filter(Boolean).join('\n')
}

function outlineCheckBrief(cfg, outline) {
  return [
    `Book run ${cfg.runId}. Outline check (developmental edit of a plan, before any drafting).`,
    shelf(cfg),
    `The author's brief: ${cfg.brief || '(see the outline premise)'}`,
    `The outline, as JSON: ${JSON.stringify(outline)}`,
    'Read only. Check the premise and promise, causality between chapters, whether every chapter changes something, stakes, information design and the genre contract (for nonfiction: thesis, one promise per chapter, no orphan chapters).',
    'score 0-10 on how strong a spine this is to draft on. verdict PASS only when no blocker or major issue remains.',
  ].filter(Boolean).join('\n')
}

const outlineScore = (c) => (c && c.status !== 'error' ? (c.verdict === 'PASS' ? 100 : 0) + (Number(c.score) || 0) * 5 - blocking(c.issues).length : -1)

async function runOutline(cfg) {
  const n = Math.max(1, Math.min(5, Number(cfg.variants) || 1))
  const drafts = await parallel(Array.from({ length: n }, (_, i) => () => call(outlineBrief(cfg, n > 1 ? i + 1 : 0), {
    label: `outline v${i + 1}`, phase: 'Outline', schema: OUTLINE_RESULT, agentType: AGENT.writer, ...seat(cfg, 'writer'),
  })))
  const ok = drafts.map((d, i) => ({ d, i })).filter((x) => x.d && x.d.status === 'done')
  if (!ok.length) {
    const why = drafts.map((d) => (d && (d.error || d.summary)) || 'no result').join('; ')
    return { runId: cfg.runId, mode: 'outline', status: 'error', error: `no outline: ${why}`, outline: null, check: null, revisions: 0 }
  }
  const checks = await parallel(ok.map((x) => () => call(outlineCheckBrief(cfg, x.d), {
    label: `outline check v${x.i + 1}`, phase: 'Outline', schema: OUTLINE_CHECK, agentType: AGENT.dev, ...seat(cfg, 'dev'),
  })))
  let best = 0
  for (let k = 1; k < ok.length; k++) if (outlineScore(checks[k]) > outlineScore(checks[best])) best = k
  let outline = ok[best].d
  let check = checks[best]
  let revisions = 0
  while (check && check.status !== 'error' && check.verdict !== 'PASS' && blocking(check.issues).length && revisions < OUTLINE_REVISION_CAP) {
    revisions++
    const next = await call(outlineBrief(cfg, 0, outline, blocking(check.issues), revisions), {
      label: `outline r${revisions}`, phase: 'Outline', schema: OUTLINE_RESULT, agentType: AGENT.writer, ...seat(cfg, 'writer'),
    })
    if (next.status !== 'done') break
    outline = next
    check = await call(outlineCheckBrief(cfg, outline), {
      label: `outline check r${revisions}`, phase: 'Outline', schema: OUTLINE_CHECK, agentType: AGENT.dev, ...seat(cfg, 'dev'),
    })
  }
  const passed = !!check && check.status !== 'error' && (check.verdict === 'PASS' || !blocking(check.issues).length)
  return {
    runId: cfg.runId, mode: 'outline', status: passed ? 'done' : 'issues', outline, check, revisions,
    variants: ok.map((x, k) => ({ variant: x.i + 1, title: x.d.title, score: checks[k] && checks[k].score, verdict: checks[k] && checks[k].verdict })),
  }
}

// ---- drafting and continuity -------------------------------------------------------------------

function draftBrief(cfg, ch, provisional) {
  const prev = list(cfg.manuscript).map((c) => c.id)
  const at = prev.indexOf(ch.id)
  const before = at > 0 ? cfg.manuscript[at - 1] : null
  const reads = [...new Set([...list(ch.dependsOn), ...(before ? [before.id] : [])])]
  const pathOf = (id) => (list(cfg.manuscript).find((c) => c.id === id) || {}).path || id
  return [
    ...header(cfg),
    `Draft chapter ${ch.id}: ${ch.title || ''}`,
    `What this chapter must do: ${ch.goal}`,
    `POV: ${ch.pov || '(book voice)'}. Tense: ${ch.tense || '(book voice)'}. Target length: about ${ch.targetWords || 'the book norm in'} words.`,
    `Read the canon and the ledger first. Every canon fact is binding: if the chapter needs one changed, keep the fact and say so in notes.`,
    reads.length ? `Before writing, read the closing 40 lines of: ${reads.map(pathOf).join(', ')} (skip any file that does not exist yet), so you continue from prose, not from a summary.` : '',
    provisional.length ? 'Provisional canon from chapters drafted earlier in this pass (binding; not yet in CANON.md):' : '',
    ...canonLines(provisional),
    `Write the chapter to ${ch.path} (create or overwrite). This brief may be replayed: if ${ch.path} already exists and does this chapter's job, keep it and report it instead of rewriting.`,
    'Return chapterId, status, path, words, pov, tense, a 2-3 sentence summary, canonUsed (the C-ids the chapter relies on), newCanon (every new fact the chapter commits to that later chapters must respect, with its line number) and notes.',
  ].filter(Boolean).join('\n')
}

function checkBrief(cfg, ch, provisional, debts) {
  return [
    ...header(cfg),
    `Continuity check of chapter ${ch.id} (${ch.path}) against the canon.`,
    `This chapter's POV is ${ch.pov || '(book voice)'} and its tense ${ch.tense || '(book voice)'}: a slip in either is an issue (kind pov or tense).`,
    provisional.length ? 'Provisional canon from this pass (binding; not yet in CANON.md):' : '',
    ...canonLines(provisional),
    debts.length ? 'Open debts on this chapter to re-check; put the ids now fixed in debtsResolved:' : '',
    ...debts.map((d) => `- ${d.id}${d.line ? ` line ${d.line}` : ''}${d.canonId ? ` vs ${d.canonId}` : ''}: ${d.summary}`),
    'Read only: do not edit any file.',
    'Each issue: chapter (the chapter holding the contradicting line), line (1-based, in that chapter file), the exact quote, canonId of the broken fact ("" when the fact was set in another chapter; then say where in canonFact), canonFact, kind, severity, summary, and maybeIntentional (an unreliable narrator, a lie, a deliberate retcon).',
    'Quote both sides of every contradiction. Never decide which version is canon; report the conflict.',
    'verdict PASS only when no issue remains; ABSTAIN when you cannot read the chapter or the canon.',
  ].filter(Boolean).join('\n')
}

function fixBrief(cfg, ch, issues, round) {
  return [
    ...header(cfg),
    `Revise chapter ${ch.id} at ${ch.path}: continuity fix, round ${round} of ${FIX_CAP}.`,
    'Change only what these issues require and keep the voice. Delete or replace before you add.',
    ...issues.map((i) => `- [${i.severity}] ${i.chapter && i.chapter !== ch.id ? `${i.chapter} ` : ''}${i.line ? `line ${i.line} ` : ''}"${i.quote}": ${i.summary} (canon${i.canonId ? ` ${i.canonId}` : ''}: ${i.canonFact})`),
    'If an issue is wrong because the canon itself should change, leave the prose as it is and say so in notes. Never edit CANON.md or LEDGER.md.',
    `This brief may be replayed: if ${ch.path} already resolves these issues, report it as it stands.`,
    'Return the result for the revised file.',
  ].filter(Boolean).join('\n')
}

async function continuityLoop(cfg, ch, provisional, debts) {
  const fixes = []
  let final = null
  for (let round = 0; ; round++) {
    final = await call(checkBrief(cfg, ch, provisional, debts), {
      label: `check ${ch.id} r${round}`, phase: 'Continuity', schema: CONTINUITY_RESULT, agentType: AGENT.continuity, ...seat(cfg, 'continuity'),
    })
    const open = final.status === 'error' || final.verdict !== 'ISSUES' ? [] : blocking(final.issues)
    if (!open.length || round >= FIX_CAP) break
    const fx = await call(fixBrief(cfg, ch, open, round + 1), {
      label: `fix ${ch.id} r${round + 1}`, phase: 'Continuity', schema: DRAFT_RESULT, agentType: AGENT.writer, ...seat(cfg, 'writer'),
    })
    fixes.push({ ...fx, chapterId: ch.id })
    if (fx.status !== 'done') break
  }
  return { chapterId: ch.id, rounds: fixes.length + 1, final, fixes, debtsShown: debts.map((d) => d.id) }
}

const newFacts = (d, chapterId) => (d && d.status === 'done' ? list(d.newCanon).map((f) => ({ ...f, chapterId })) : [])

// ---- whole-manuscript passes --------------------------------------------------------------------

function chapterList(chapters) {
  return chapters.map((c) => `- ${c.id}: ${c.path}${c.title ? ` (${c.title})` : ''}`)
}

function devBrief(cfg, chapters) {
  return [
    ...header(cfg),
    'Developmental edit of the manuscript so far. Read every chapter in order:',
    ...chapterList(chapters),
    'Read only. Diagnose structure before prose: premise and promise, causality (could chapters be reordered without breaking anything?), what each chapter changes, pacing, character decisions, stakes, information design, the genre contract; for nonfiction the thesis, each chapter\'s promise and whether the argument holds.',
    'Each note names one structural action (cut, move, expand, compress, combine, split, reframe, seed-earlier, delay-payoff, change-decision), its reader cost, and the chapter ("" for the whole book). Rate each chapter\'s tension 1-5 in pacing.',
    'verdict PASS when structure is sound enough for line editing; REVISE when a blocker or major note would change chapters a line edit would polish.',
  ].filter(Boolean).join('\n')
}

function lineBrief(cfg, ch) {
  return [
    ...header(cfg),
    `Line edit chapter ${ch.id} at ${ch.path}, in place.`,
    'Edit for rhythm, clarity, texture, subtext and redundancy in this book\'s voice. Minimal edits: replace or delete before you insert; never normalise the voice into generic good prose.',
    'The canon is fixed. Do not change any fact, name, number, date, quote or claim. If a sentence you must fix carries a canon fact, keep the fact; if you changed one anyway, list it in canonTouched.',
    `This brief may be replayed: if ${ch.path} already reads as line-edited, report status "skipped" with edits 0.`,
    'Return chapterId, status, path, edits (how many passages you changed), the 2-4 recurring patterns you fixed with their reader cost and examples, and canonTouched.',
  ].filter(Boolean).join('\n')
}

function betaBrief(cfg, persona, chapters) {
  return [
    `You are a first-time reader of "${cfg.title || 'this book'}" (${cfg.kind || 'fiction'}). Your persona: ${persona}`,
    shelf(cfg),
    'Read these chapter files in order, as a reader, not an editor:',
    ...chapterList(chapters),
    `Do not open ${cfg.canonPath}, ${cfg.ledgerPath} or any outline: a reader has only the pages.`,
    'Read only. Report the felt experience, chapter by chapter: engagement 1-5, where you leaned in, where you drifted, what confused you (with the line and quote), what stayed with you.',
    'If you would have stopped reading, say where (putDownChapter) and why, then finish anyway so the rest still gets a read. putDownChapter is "" when you never wanted to stop.',
    'source is always "simulated". Your verdict is one paragraph in this persona\'s own voice.',
  ].filter(Boolean).join('\n')
}

// ---- the pass -----------------------------------------------------------------------------------

async function runPass(cfg) {
  const waves = list(cfg.waves).map(list)
  const passes = cfg.passes || {}
  const provisional = []
  const drafts = []
  const continuity = []
  const skipped = {}

  // Re-check edited or indebted chapters first, so new chapters build on the fixed text.
  const recheck = list(cfg.recheck)
  if (recheck.length) {
    log(`re-checking ${recheck.length} chapter(s)`)
    const r = await parallel(recheck.map((ch) => () => continuityLoop(cfg, ch, [], list(ch.debts))))
    r.forEach((x, i) => continuity.push(x || { chapterId: recheck[i].id, rounds: 0, final: { status: 'error', error: 'dropped' }, fixes: [], debtsShown: [] }))
    for (const x of continuity) for (const fx of list(x.fixes)) provisional.push(...newFacts(fx, x.chapterId))
  }

  for (let w = 0; w < waves.length; w++) {
    const wave = waves[w]
    log(`wave ${w + 1}/${waves.length}: drafting ${wave.map((c) => c.id).join(', ')}`)
    const seen = provisional.slice()
    const results = await pipeline(
      wave,
      (ch) => call(draftBrief(cfg, ch, seen), { label: `draft ${ch.id}`, phase: 'Draft', schema: DRAFT_RESULT, agentType: AGENT.writer, ...seat(cfg, 'writer') }),
      async (d, ch) => {
        const draft = { ...d, chapterId: ch.id }
        if (draft.status !== 'done' || passes.continuity === false) return { draft, check: null }
        return { draft, check: await continuityLoop(cfg, ch, seen.concat(newFacts(draft, ch.id)), []) }
      },
    )
    results.forEach((r, i) => {
      const ch = wave[i]
      const draft = (r && r.draft) || { chapterId: ch.id, status: 'error', error: 'pipeline dropped the chapter' }
      drafts.push(draft)
      provisional.push(...newFacts(draft, ch.id))
      if (r && r.check) {
        continuity.push(r.check)
        for (const fx of list(r.check.fixes)) provisional.push(...newFacts(fx, ch.id))
      }
    })
  }

  const failed = new Set(drafts.filter((d) => d.status !== 'done').map((d) => d.chapterId))
  const chapters = list(cfg.manuscript).filter((c) => !failed.has(c.id) && (c.status !== 'planned' || drafts.some((d) => d.chapterId === c.id)))

  let development = null
  if (passes.developmental && chapters.length) {
    development = await call(devBrief(cfg, chapters), { label: 'develop', phase: 'Develop', schema: DEV_RESULT, agentType: AGENT.dev, ...seat(cfg, 'dev') })
  } else if (passes.developmental) skipped.developmental = 'no drafted chapters'

  let lineEdits = []
  if (passes.lineEdit) {
    // Big before small: a line edit polishes sentences a structural change might cut.
    if (!development || development.verdict !== 'PASS') skipped.lineEdit = `developmental verdict ${development ? development.verdict || development.status : 'missing'}: fix structure first`
    else {
      const r = await parallel(chapters.map((ch) => () => call(lineBrief(cfg, ch), { label: `line ${ch.id}`, phase: 'Line', schema: LINE_RESULT, agentType: AGENT.line, ...seat(cfg, 'line') })))
      lineEdits = r.map((x, i) => ({ ...(x || { status: 'error', error: 'dropped' }), chapterId: chapters[i].id }))
    }
  }

  let beta = []
  const n = Math.max(0, Math.min(6, Number(passes.beta) || 0))
  if (n && chapters.length) {
    const personas = PERSONAS[cfg.kind === 'nonfiction' ? 'nonfiction' : 'fiction']
    const picked = Array.from({ length: n }, (_, i) => (list(cfg.personas)[i] || personas[i % personas.length]))
    beta = (await parallel(picked.map((p, i) => () => call(betaBrief(cfg, p, chapters), {
      label: `beta ${i + 1}`, phase: 'Beta', schema: BETA_RESULT, agentType: AGENT.beta, ...seat(cfg, 'beta'),
    })))).map((x) => x || { status: 'error', error: 'dropped' })
  }

  return { runId: cfg.runId, mode: 'pass', drafts, continuity, provisionalCanon: provisional, development, lineEdits, beta, skipped }
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'book'

const cfg = parseArgs(args)
if (!cfg.runId && cfg.mode === 'outline' && cfg.brief) cfg.runId = `book-${slug(cfg.brief)}`
if (!cfg.runId) return { status: 'error', error: 'book needs args {runId, mode:"outline", brief} or the contents of book-args.json' }
if (cfg.mode === 'outline') return await runOutline(cfg)
if (!Array.isArray(cfg.waves) || !cfg.canonPath) return { status: 'error', error: 'book pass needs the contents of .muster/runs/<id>/book-args.json (run `muster book args <id>`)' }
return await runPass(cfg)
