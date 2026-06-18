// Evaluator-optimizer loop: lint a prompt to find structural gaps, generate variations
// that each apply a best-practice technique to close a gap, re-evaluate every variation,
// and select the winner with the existing tournament pickWinner. A variation that scores
// below the pinned baseline is flagged as a regression.
//
// `evalFn(prompt) -> Promise<{ total, passing }>` is injected so the loop is testable
// offline and can be backed by runEval (or a promptfoo adapter) in production.
import { lintPrompt } from "./prompt-lint.js";
import { pickWinner } from "./tournament.js";

// Deterministic technique transforms. Each closes the gap named by a lint rule id.
// Wrap both {{var}} and ${var} (the linter flags both as interpolation, so the fix must
// cover both or the re-lint would still fail). Idempotent: skip a var already wrapped in
// a like-named tag, so re-running (or the combined pass) never produces nested tags.
const VAR_RE = /\{\{\s*(\w+)\s*\}\}|\$\{\s*(\w+)\s*\}/g;
const wrapXml = (p) => p.replace(VAR_RE, (m, a, b) => {
  const k = a || b;
  return new RegExp(`<${k}\\b`).test(p) ? m : `<${k}>\n${m}\n</${k}>`;
});

const TRANSFORMS = {
  "ANTH-ROLE-001": { technique: "add-role",
    apply: (p) => `You are an expert assistant specialized in this task.\n\n${p}` },
  "ANTH-FMT-001": { technique: "specify-output-format",
    apply: (p) => `${p}\n\nFormat your response exactly as requested; if a structured result is implied, return valid JSON only.` },
  "ANTH-XML-001": { technique: "wrap-xml", apply: wrapXml },
  "GUARD-SEP-003": { technique: "wrap-xml", apply: wrapXml },
  "ANTH-SHOT-001": { technique: "add-examples",
    apply: (p) => `${p}\n\n<example>\n<input>EXAMPLE INPUT</input>\n<output>IDEAL OUTPUT</output>\n</example>` },
  "ANTH-POS-001": { technique: "positive-framing",
    apply: (p) => `${p}\n\n(Express the constraints above as positive instructions — state what to do.)` },
  "LINT-STOP-002": { technique: "add-stop-conditions",
    apply: (p) => `${p}\n\nStop once the task is complete or after a reasonable number of attempts.` },
  "GUARD-IDK-001": { technique: "allow-idk",
    apply: (p) => `${p}\n\nIf the context does not contain the answer, reply "I don't know" rather than guessing.` },
  "GUARD-CITE-002": { technique: "require-citations",
    apply: (p) => `${p}\n\nSupport every factual claim with a direct quote or citation from the provided sources.` },
};

export function proposeVariations(prompt, ctx = {}) {
  const { findings } = lintPrompt(prompt, ctx);
  const variations = [{ id: "baseline", technique: "baseline", prompt }];
  const seen = new Set();
  const applied = [];

  for (const f of findings) {
    const t = TRANSFORMS[f.id];
    if (!t || seen.has(t.technique)) continue;
    seen.add(t.technique);
    applied.push(t);
    variations.push({ id: t.technique, technique: t.technique, prompt: t.apply(prompt), addresses: f.id });
  }

  // A combined variation that applies every technique — often the strongest candidate.
  if (applied.length > 1) {
    const combined = applied.reduce((p, t) => t.apply(p), prompt);
    variations.push({ id: "all-improvements", technique: "all-improvements", prompt: combined });
  }
  return variations;
}

// Deterministic winner selection over already-scored candidates. Each candidate:
// { id, prompt?, total, passing }. Reused by the `muster prompt optimize` CLI and by
// optimizePrompt. A non-baseline winner scoring below the pinned baseline is a regression.
export function selectWinner(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0)
    throw new Error("selectWinner: candidates must be a non-empty array");
  const baseline = candidates.find(s => s.id === "baseline");
  // The regression guard compares the winner against the pinned baseline — without a
  // baseline candidate it would silently report regression:false. Fail loud instead.
  if (!baseline)
    throw new Error('selectWinner: candidates must include a "baseline" row to anchor regression detection');
  const { winner, escalate, ranking } = pickWinner(candidates);
  const winnerRow = winner ? candidates.find(s => s.id === winner) : null;
  // baseline is guaranteed present (thrown above), so no need to re-guard it here.
  const regression = !!winnerRow && winnerRow.id !== "baseline" && winnerRow.total < baseline.total;
  return {
    winner: winner ?? null,
    escalate,
    regression,
    winnerPrompt: winnerRow ? winnerRow.prompt ?? null : null,
    baselineScore: baseline ? baseline.total : null,
    ranking,
    candidates,
  };
}

export async function optimizePrompt({ prompt, evalFn, ctx = {} }) {
  const variations = proposeVariations(prompt, ctx);
  const scored = [];
  for (const v of variations) {
    const { total, passing } = await evalFn(v.prompt);
    scored.push({ id: v.id, technique: v.technique, prompt: v.prompt, total, passing });
  }
  return selectWinner(scored);
}
