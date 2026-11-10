// Result schemas for the muster book Workflow (plugin/workflows/book.js) and the ledger that
// records them (src/book.js). Kept apart from schemas.js, which belongs to plan/build/backlog.
//
// No `meta` export, so Claude Code's workflow loader skips this file. Workflow scripts run as
// isolated function bodies with no imports, so book.js inlines a copy of every schema it passes
// to agent(); test/book-workflow.test.js asserts each inlined copy deep-equals the export here.

const str = { type: "string" };
const strList = { type: "array", items: str };
const int = { type: "integer" };
const CANON_CATEGORY = { type: "string", enum: ["character", "world", "place", "timeline", "object", "term", "claim", "source", "style", "other"] };

// book-writer, outline mode: the outline and the seed canon, returned as data (the CLI writes book.json).
export const OUTLINE_RESULT = {
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
export const OUTLINE_CHECK = {
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
export const DRAFT_RESULT = {
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
export const CONTINUITY_RESULT = {
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
export const DEV_RESULT = {
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
export const LINE_RESULT = {
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
export const BETA_RESULT = {
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
