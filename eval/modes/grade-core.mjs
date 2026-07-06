// Shared, cross-layer grading helpers for eval/modes/ -- genuinely reused by more than one
// of the layer modules (grade-modes.mjs/grade-skills.mjs/grade-pipelines.mjs/
// grade-builtins.mjs), so they live here rather than being duplicated or homed arbitrarily
// in whichever layer happened to need them first. No IO here, same rule as every other
// eval/modes module -- callers read fixtures/build artifacts and pass them in.
import { scoreArtifact } from "../../src/score.js";
import { fileURLToPath } from "node:url";
import { relative, isAbsolute } from "node:path";

// [P2 sec] grade.mjs resolves dataset.json's `artifact` field (a relative path) against
// eval/modes/ via `new URL(relPath, baseUrl)` before reading it. A bare `new URL(...)`
// happily resolves `../../etc/passwd`-style traversal (or an absolute/`file://` override)
// to anywhere on disk -- this wraps that resolution and rejects anything that lands
// outside `baseUrl`'s own directory tree, with a clear error instead of a silent read from
// an unexpected location. dataset.json is checked-in/reviewed today, but the containment
// check is cheap insurance, not a reaction to an exploited path.
export function resolveArtifactUrl(relPath, baseUrl) {
  const resolved = new URL(relPath, baseUrl);
  if (resolved.protocol !== "file:") {
    throw new Error(`artifact path must resolve to a local file, got protocol "${resolved.protocol}": ${relPath}`);
  }
  const baseDir = fileURLToPath(baseUrl);
  const resolvedPath = fileURLToPath(resolved);
  const rel = relative(baseDir, resolvedPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`artifact path "${relPath}" escapes the eval/modes/ tree (resolved outside ${baseDir})`);
  }
  return resolved;
}

// Shared "every non-empty line matches rowRe" grader. Six call sites across three layers
// (grade-modes' audit-ledger, grade-builtins' video-shot-list-shape, grade-pipelines'
// runbook-step-pairs/book-chapter-manifest/ai-test-plan-case-table/adr-status-lifecycle)
// all did this exact split-trim-filter -> regex-match-every-line -> report dance
// independently before this extraction. `wantFormatValid` defaults to true (matching every
// call site's un-gated original behavior when a case doesn't set `expect.formatValid`);
// pass `expect.formatValid ?? true` explicitly where a case can flip it. `filterLines`
// lets a caller drop rows before matching (ai-test-plan-case-table skips its markdown
// table's header/separator rows) without changing the row-format contract itself. Returns
// `lines`/`parsed`/`formatValid` too so a caller needing a capture group for a follow-on
// check (book-chapter-manifest's chapter number, ai-test-plan's case type) doesn't have to
// re-split/re-match.
export function rowFormatCheck(text, rowRe, itemLabel, { wantFormatValid = true, filterLines } = {}) {
  let lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (filterLines) lines = lines.filter(filterLines);
  const parsed = lines.map((l) => rowRe.exec(l));
  const bad = lines.filter((_, i) => !parsed[i]);
  const formatValid = bad.length === 0;
  const check = {
    name: "formatValid",
    ok: formatValid === wantFormatValid,
    detail: formatValid
      ? `all ${lines.length} ${itemLabel} row(s) match the expected shape`
      : `malformed ${itemLabel} row(s): ${JSON.stringify(bad)}`,
  };
  return { lines, parsed, bad, formatValid, check };
}

// Generic gate-achievability check: `scoreArtifact` (src/score.js) takes only
// `{scores, gate}` -- nothing prd-specific -- so the SAME grader parameterizes over any
// pipeline's real `gate` object (pipelines/*.yaml's `gate: {criteria, floor, pass_total}`).
// Dispatched under both "prd-gate-achievability" (grade-skills.mjs, the prd-pipeline
// skill's original cases) and "gate-achievability" (grade-pipelines.mjs, the
// content-pipeline layer's cases) -- same function either way, hence its home here.
export function gateAchievabilityCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const { scores, gate } = artifacts || {};
  const r = scoreArtifact(scores, gate);
  const checks = [];
  if (expect.total !== undefined) checks.push({ name: "total", ok: r.total === expect.total, detail: `total=${r.total}, expected ${expect.total}` });
  if (expect.weakestCriterion !== undefined) checks.push({ name: "weakestCriterion", ok: r.weakest.criterion === expect.weakestCriterion, detail: `weakest.criterion="${r.weakest.criterion}", expected "${expect.weakestCriterion}"` });
  if (expect.passing !== undefined) checks.push({ name: "passing", ok: r.passing === expect.passing, detail: `passing=${r.passing}, expected ${expect.passing}` });
  return checks;
}
