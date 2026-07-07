// Deterministic description-search ranker. Pure token-overlap — NO LLM calls — so the
// provider catalog's breadth (ids, roles, keywords, free-text descriptions) is searchable
// without collapsing everything into the fixed role enum. Used by `muster match <task>`.

import { isInstalled } from "./installed.js";

const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "a", "an", "to", "of", "it", "is", "in", "on",
]);

// lowercase, split on non-alphanumerics, drop <3-char tokens and stopwords. Caller dedupes.
function tokenize(text) {
  if (typeof text !== "string") return [];
  return text.toLowerCase().split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

export function matchProviders(task, catalog, installed = {}, opts = {}) {
  if (typeof task !== "string" || !task.trim()) return [];
  const limit = opts.limit ?? 8;

  const taskTokens = [...new Set(tokenize(task))];
  if (taskTokens.length === 0) return [];

  const results = [];
  for (const entry of catalog) {
    // Weighted searchable bag: token -> max weight seen for it.
    const bag = new Map();
    const add = (token, weight) => {
      if (!token) return;
      const prev = bag.get(token) ?? 0;
      if (weight > prev) bag.set(token, weight);
    };

    // HIGH weight (3): id (split on - and _), each role, each keyword.
    for (const t of String(entry.id || "").toLowerCase().split(/[-_]+/)) add(t, 3);
    for (const role of entry.roles || []) {
      for (const t of String(role).toLowerCase().split(/[-_]+/)) add(t, 3);
    }
    if (Array.isArray(entry.keywords)) {
      for (const kw of entry.keywords) {
        for (const t of String(kw).toLowerCase().split(/[-_]+/)) add(t, 3);
      }
    }
    // LOW weight (1): description tokens (same tokenize/stopword treatment).
    if (entry.description) for (const t of tokenize(entry.description)) add(t, 1);

    let score = 0;
    const matched = [];
    for (const tok of taskTokens) {
      const w = bag.get(tok);
      if (w) { score += w; matched.push(tok); }
    }
    if (score === 0) continue;

    // source + installed boost so a present tool edges out an equal-scoring fallback.
    let source;
    if (entry.kind === "external" && isInstalled(entry, installed)) {
      source = "installed";
      score += 1;
    } else if (entry.kind === "builtin" || entry.kind === "agent") {
      source = "builtin";
    } else {
      source = "external"; // external, not installed
    }

    results.push({ id: entry.id, score, kind: entry.kind, source, roles: entry.roles || [], matched });
  }

  // score desc, then rank desc, then id asc. (rank read from the original catalog entries.)
  const rankOf = new Map(catalog.map(e => [e.id, e.rank ?? 0]));
  results.sort((a, b) =>
    b.score - a.score
    || (rankOf.get(b.id) ?? 0) - (rankOf.get(a.id) ?? 0)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return results.slice(0, limit);
}

// Same weighted-bag ranking as matchProviders, scoped to the skills-inventory shape
// resolveCapabilities returns ({id, source, description} — no roles/keywords fields,
// so the bag is just id tokens (HIGH weight 3) + description tokens (LOW weight 1)).
// Used by `muster match --skills <task>`.
export function matchSkills(task, skills, opts = {}) {
  if (typeof task !== "string" || !task.trim()) return [];
  const limit = opts.limit ?? 8;

  const taskTokens = [...new Set(tokenize(task))];
  if (taskTokens.length === 0) return [];

  const results = [];
  for (const entry of skills) {
    const bag = new Map();
    const add = (token, weight) => {
      if (!token) return;
      const prev = bag.get(token) ?? 0;
      if (weight > prev) bag.set(token, weight);
    };

    // HIGH weight (3): id, split on -, _ and : (skill ids may be colon-namespaced, e.g. vercel:nextjs).
    for (const t of String(entry.id || "").toLowerCase().split(/[-_:]+/)) add(t, 3);
    // LOW weight (1): description tokens (same tokenize/stopword treatment).
    if (entry.description) for (const t of tokenize(entry.description)) add(t, 1);

    let score = 0;
    const matched = [];
    for (const tok of taskTokens) {
      const w = bag.get(tok);
      if (w) { score += w; matched.push(tok); }
    }
    if (score === 0) continue;

    // Same +1 installed boost as matchProviders: a present skill edges out an
    // equal-scoring builtin fallback for the same tokens.
    if (entry.source === "installed") score += 1;

    results.push({ id: entry.id, score, source: entry.source, matched });
  }

  // score desc, then id asc.
  results.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return results.slice(0, limit);
}

// Deterministic stack→skill suggestion map: given ProjectProfile-style signals
// (frameworks/languages/keywords), returns the skill ids muster recommends for that
// stack, each carrying a human-readable reason. No LLM — every mapping lives in the
// STACK_SKILL_MAP object literal below. A suggested id absent from the live skills
// inventory is flagged missing: true; this feeds the router's gap protocol (recommend
// the skill even when it isn't installed, but say so plainly).
//
// Ids here are the real, un-namespaced on-disk skill-dir names (verified against the
// live ~/.claude inventory — the vercel/nextjs marketplace installs `nextjs`, `shadcn`,
// `ai-sdk`, not colon-namespaced `vercel:nextjs` etc.). See lastColonSegment below for
// a defensive, namespace-insensitive comparison in case a future marketplace does
// prefix its ids.
const VERCEL_NEXT_SKILLS = [
  { id: "nextjs", reason: "Next.js detected — framework-specific routing/rendering patterns" },
  { id: "shadcn", reason: "Next.js projects commonly pair with shadcn/ui components" },
  { id: "ai-sdk", reason: "Next.js projects commonly integrate the Vercel AI SDK" },
];
const DESIGN_UX_SKILLS = [
  { id: "frontend-design", reason: "user-facing UI work benefits from a dedicated frontend-design pass" },
  { id: "wsh-design-system-patterns", reason: "user-facing UI work benefits from design-system consistency" },
  { id: "wsh-responsive-design", reason: "user-facing UI work benefits from a responsive-design review" },
];

const STACK_SKILL_MAP = {
  frameworks: {
    next: VERCEL_NEXT_SKILLS,
    nextjs: VERCEL_NEXT_SKILLS,
    supabase: [
      { id: "supabase", reason: "Supabase detected as the backend/data layer" },
    ],
  },
  keywords: [
    {
      // user-facing UI work
      triggers: ["ui", "frontend", "page", "screen", "component", "design", "layout"],
      skills: DESIGN_UX_SKILLS,
    },
    {
      // customer-facing copy
      triggers: ["copy", "content", "marketing", "brand", "branded", "messaging", "tone", "report"],
      skills: [
        { id: "muster-humanizer", reason: "customer-facing copy should pass an AI-tell humanizer review" },
      ],
    },
    {
      // integration/external-API claims
      triggers: ["api", "integration", "webhook", "external", "thirdparty", "third-party"],
      skills: [
        { id: "sp-verify", reason: "integration/external-API claims should go through verification-before-completion" },
      ],
    },
  ],
};

// Last colon-separated segment of a skill id (`vercel:nextjs` -> `nextjs`; `nextjs` ->
// `nextjs`). Comparing ids on this segment, rather than exact string equality, is a
// defensive namespace-insensitive match: it holds regardless of which side (the
// STACK_SKILL_MAP suggestion or the live inventory entry) happens to carry a
// colon-namespace prefix.
export function lastColonSegment(id) {
  const s = String(id ?? "");
  const i = s.lastIndexOf(":");
  return i === -1 ? s : s.slice(i + 1);
}

// Reverse lookup: does binding this skill id imply one of the review gate's surface
// types (ui/copy/integration)? Built from the same DESIGN_UX_SKILLS / humanizer /
// sp-verify groupings suggestSkillsForStack already uses, so the two stay in sync by
// construction rather than by two hand-maintained lists drifting apart. Namespace-
// insensitive (lastColonSegment), matching every other id comparison in this file.
// Returns null when the id implies no particular surface.
const SURFACE_IMPLYING_SKILL_IDS = {
  ui: DESIGN_UX_SKILLS.map((s) => s.id),
  copy: ["muster-humanizer"],
  integration: ["sp-verify"],
};

export function impliedSurfaceForSkillId(id) {
  const seg = lastColonSegment(id).toLowerCase();
  for (const [surface, ids] of Object.entries(SURFACE_IMPLYING_SKILL_IDS)) {
    if (ids.some((i) => lastColonSegment(i).toLowerCase() === seg)) return surface;
  }
  return null;
}

export function suggestSkillsForStack(signals = {}, inventory = []) {
  const installedLastSegments = new Set(inventory.map(e => lastColonSegment(e.id)));
  const suggestions = [];
  const seen = new Set();
  const pushAll = (list) => {
    for (const s of list) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      suggestions.push({ id: s.id, reason: s.reason, missing: !installedLastSegments.has(lastColonSegment(s.id)) });
    }
  };

  for (const fw of signals.frameworks || []) {
    const list = STACK_SKILL_MAP.frameworks[String(fw).toLowerCase()];
    if (list) pushAll(list);
  }

  const kw = new Set((signals.keywords || []).map(k => String(k).toLowerCase()));
  for (const group of STACK_SKILL_MAP.keywords) {
    if (group.triggers.some(t => kw.has(t))) pushAll(group.skills);
  }

  return suggestions;
}

// Default signals source for `match --skills` when no --stack/profile is supplied:
// tokenize the task text itself (same tokenizer as the rankers above) and feed the
// token set as both frameworks and keywords — suggestSkillsForStack only reacts to
// the tokens it recognizes, so free-form task prose is a safe, deterministic input.
export function signalsFromTask(task) {
  const tokens = [...new Set(tokenize(task))];
  return { frameworks: tokens, languages: [], keywords: tokens };
}
