import { escapeRe } from "./keyword.js";

const DOMAIN_KEYWORDS = {
  pm: ["prd", "product spec", "user story", "epic", "roadmap", "prioritize", "prioritization", "requirements", "product brief"],
  business: ["business case", "investor", "pitch", "financial model", "market analysis"],
  marketing: ["lead magnet", "campaign", "landing page", "go-to-market", "gtm", "email sequence"],
  ops: ["runbook", "sop", "operations", "process doc", "incident"],
  blog: ["blog post", "blog", "article"],
  social: ["social post", "social media", "tweet", "linkedin post", "x post", "thread", "instagram caption", "reel script"],
  newsletter: ["newsletter", "email newsletter"],
  sales: ["case study", "customer story", "sales deck", "battlecard"],
  book: ["book", "novel", "manuscript", "memoir"],
  video: ["video script", "video content", "screencast", "b-roll", "shot list", "video edit", "youtube script", "video plan", "video"],
  // "validate(s)"/"verify/verifies/verification"/"tdd"/"sha" (backlog item
  // codex-assess-criteria-detect, 2026-07-18 Codex dogfood): a concrete code outcome
  // ("buildBaseShaReceipt in src/wave-dispatch.js validates SHA format but never
  // verifies...") classified domain:unknown because neither the original keyword list nor
  // the workspace-shape fallback (profile.shape stays "unknown" for a repo like muster's own
  // -- no package.json main/exports, no FE/BE framework deps) caught it. Evidence-driven,
  // conservative addition: the dogfood text's own vocabulary plus its base verb forms. "test"
  // and "receipt" were considered and deliberately left out -- both are common outside code
  // (a QA/usability "test", a purchase/expense "receipt"), and every domain earlier in this
  // list already wins its outcomes on its own vocabulary, so a generic word here would only
  // ever fire as an unclaimed-elsewhere false positive, never a needed rescue.
  software: ["implement", "refactor", "bug", "api", "endpoint", "function", "deploy",
    "validate", "validates", "verify", "verifies", "verification", "tdd", "sha"]
};

// The domain vocabulary the classifier knows about (used by doctor's
// pipeline/domain alignment check — every pipelines/*.yaml `domain:` field
// must be one of these; the reverse is NOT required, since a domain like
// "software" legitimately has no content pipeline — the code route handles it).
export function knownDomains() {
  return Object.keys(DOMAIN_KEYWORDS);
}

export function classifyDomain(outcome, profile = {}, override) {
  if (override) return { domain: override, source: "override", confidence: 1 };
  const text = (outcome || "").toLowerCase();
  for (const [domain, kws] of Object.entries(DOMAIN_KEYWORDS)) {
    if (kws.some(k => new RegExp(`\\b${escapeRe(k)}\\b`, "i").test(text))) return { domain, source: "outcome", confidence: 0.8 };
  }
  if (profile.shape && profile.shape !== "unknown" && !profile.greenfield) {
    return { domain: "software", source: "workspace", confidence: 0.6 };
  }
  return { domain: "unknown", source: "none", confidence: 0 };
}
