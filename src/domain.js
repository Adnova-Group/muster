const DOMAIN_KEYWORDS = {
  pm: ["prd", "product spec", "user story", "epic", "roadmap", "requirements", "product brief"],
  business: ["business case", "investor", "pitch", "financial model", "market analysis"],
  marketing: ["lead magnet", "campaign", "landing page", "go-to-market", "gtm", "email sequence"],
  ops: ["runbook", "sop", "operations", "process doc", "incident"],
  blog: ["blog post", "blog", "article"],
  social: ["social post", "social media", "tweet", "linkedin post", "x post", "thread", "instagram caption", "reel script"],
  newsletter: ["newsletter", "email newsletter"],
  sales: ["case study", "customer story", "sales deck", "battlecard"],
  book: ["book", "novel", "manuscript", "memoir"],
  software: ["implement", "refactor", "bug", "api", "endpoint", "function", "deploy"]
};

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

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
