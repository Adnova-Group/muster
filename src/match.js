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
