// Mode layer of eval/modes/'s grading logic: the 6 verb prompts (run.md/autopilot.md/
// diagnose.md/audit.md's mode steps that are themselves deterministic pipeline code --
// assessOutcome, parseIssueRef, classifyFailure, buildDiagnoseManifest,
// buildAuditManifest, computeSprintWaves). One of grade-lib.mjs's layer modules (see
// grade-lib.mjs's header for the full layer list); grade-lib.mjs composes this module's
// CHECKS/ARTIFACT_KIND with the other layers' into the public dispatch tables. No IO here,
// same rule as every other eval/modes module -- callers read fixtures/build artifacts and
// pass them in via `artifacts`.
import { validateManifest } from "../../src/manifest.js";
import { computeSprintWaves } from "../../src/sprint-waves.js";
import { assessOutcome } from "../../src/interview.js";
import { parseIssueRef } from "../../src/issue.js";
import { classifyFailure, buildDiagnoseManifest } from "../../src/diagnose.js";
import { buildAuditManifest } from "../../src/audit.js";
import { parseBacklogRef, crossItemConflicts } from "../../src/batch-plan.js";
import { rowFormatCheck } from "./grade-core.mjs";

// Fences invariant (run.md/autopilot.md: parallel plan tasks must carry owns/frozen so
// concurrent workers don't collide). Only applies once a plan actually has more than one
// task — a single-task plan has nothing to fence. A task that DEPENDS on something isn't
// "parallel" in the collision sense (it runs after its deps), so a dep is also exempt.
export function planFencesOk(m) {
  const plan = Array.isArray(m?.plan) ? m.plan : [];
  if (plan.length <= 1) return true;
  return plan.every(
    (p) =>
      (Array.isArray(p.deps) && p.deps.length > 0) ||
      (Array.isArray(p.owns) && p.owns.length > 0) ||
      (Array.isArray(p.frozen) && p.frozen.length > 0)
  );
}

// autopilot.md step 8 + its Unattended subsection: merge-local/merge-push downgrade to pr
// when there is no attended human to push/merge to the base branch for. Attended, or any
// other declared value (pr/keep/ask), passes through unchanged.
export function resolveMergeDisposition(declared, { attended } = {}) {
  if (!attended && (declared === "merge-local" || declared === "merge-push")) return "pr";
  return declared;
}

// autopilot.md step 6: "commit (`feat(wave N): <summary>`)" per green + reviewed wave.
export const WAVE_COMMIT_RE = /^feat\(wave \d+\): .+/;

// coordination/SKILL.md Binding B's exact receipt grammar (the run STATE's `## Coordination`
// section) plus the BLOCKED->RESUME `ANSWER <slug>: <text>` line it also documents.
export const RECEIPT_PATTERNS = {
  CLAIMED: /^CLAIMED (\S+) (\S+) (\S+)(?:\s+.*)?$/,
  DONE: /^DONE (\S+) (\S+) (\S+) (\S+)$/,
  BLOCKED: /^BLOCKED (\S+) (\S+) (\S+) (.+)$/,
  FAILED: /^FAILED (\S+) (\S+) (\S+) (.+)$/,
  IDLE: /^IDLE (\S+) (\S+) — nothing claimable$/,
  LEDGER: /^LEDGER (\S+) last-seen=(\S+) last-item=(\S+) result=(claimed|done|blocked|failed|idle)$/,
  ANSWER: /^ANSWER (\S+): (.+)$/,
};

function receiptLines(text) {
  return String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function classifyReceiptLine(line) {
  for (const [type, re] of Object.entries(RECEIPT_PATTERNS)) {
    const m = re.exec(line);
    if (m) return { type, m, line };
  }
  return null;
}

// audit.md step 4's ledger line shape: `- P[0-2] \`path:line\` — problem — Fix: fix text.`
export const LEDGER_LINE_RE = /^- (P[0-2]) `([^`\n]+:\d+)` — (.+?) — Fix: (.+)$/;
const SEVERITY_RANK = { P0: 0, P1: 1, P2: 2 };

// --- per-check graders: (testCase, artifacts) -> [{name, ok, detail}] -----------------

function diagnoseClassifyCheck(testCase) {
  const expect = testCase.expect || {};
  if (expect.throws) {
    let threw = false;
    try {
      classifyFailure(testCase.outcome);
    } catch {
      threw = true;
    }
    return [{ name: "throws", ok: threw, detail: threw ? "classifyFailure threw as expected on empty input" : "classifyFailure did not throw" }];
  }
  const c = classifyFailure(testCase.outcome);
  return [{ name: "mode", ok: c.mode === expect.mode, detail: `classifyFailure(outcome).mode = "${c.mode}", expected "${expect.mode}"` }];
}

function diagnoseManifestCheck(testCase) {
  const expect = testCase.expect || {};
  const classified = classifyFailure(testCase.outcome);
  const m = buildDiagnoseManifest(classified, {});
  const v = validateManifest(m);
  const checks = [{ name: "validates", ok: v.ok, detail: v.ok ? "manifest valid" : `invalid: ${v.errors.join("; ")}` }];
  if (expect.planIds) {
    const ids = m.plan.map((p) => p.id);
    checks.push({ name: "planIds", ok: JSON.stringify(ids) === JSON.stringify(expect.planIds), detail: `plan ids ${JSON.stringify(ids)}, expected ${JSON.stringify(expect.planIds)}` });
  }
  if (expect.crewRoles) {
    const roles = m.crew.map((c) => c.stage);
    checks.push({ name: "crewRoles", ok: JSON.stringify(roles) === JSON.stringify(expect.crewRoles), detail: `crew roles ${JSON.stringify(roles)}, expected ${JSON.stringify(expect.crewRoles)}` });
  }
  return checks;
}

// audit.md's prompt-quality dimension is gated on a "prompting" signal computed upstream
// by src/detect.js's hasPromptingSignal — filesystem-bound async I/O over a real
// package.json (already exercised end-to-end with real fixtures in test/detect.test.js).
// gradeCase is called synchronously and un-awaited by the frozen grade.mjs CLI report, so
// this eval cannot also re-run that live async detection without forking that consumer's
// contract. These audit-manifest cases therefore grade buildAuditManifest's *construction*
// given a signal value the case supplies directly — `expect.givenPromptingSignal`, named
// so it reads honestly as a construction input, not a re-derivation of live detection.
function auditManifestCheck(testCase) {
  const expect = testCase.expect || {};
  const m = buildAuditManifest({}, { prompting: !!expect.givenPromptingSignal });
  const v = validateManifest(m);
  const checks = [{ name: "validates", ok: v.ok, detail: v.ok ? "manifest valid" : `invalid: ${v.errors.join("; ")}` }];
  if (expect.planIdsInclude) {
    const ids = m.plan.map((p) => p.id);
    const missing = expect.planIdsInclude.filter((id) => !ids.includes(id));
    checks.push({ name: "planIdsInclude", ok: missing.length === 0, detail: missing.length ? `missing plan ids: ${missing.join(", ")}` : `plan includes all of ${JSON.stringify(expect.planIdsInclude)}` });
  }
  if (expect.planIdsExclude) {
    const ids = m.plan.map((p) => p.id);
    const present = expect.planIdsExclude.filter((id) => ids.includes(id));
    checks.push({ name: "planIdsExclude", ok: present.length === 0, detail: present.length ? `unexpectedly present plan ids: ${present.join(", ")}` : `plan excludes all of ${JSON.stringify(expect.planIdsExclude)}` });
  }
  if (expect.crewCoversRoles) {
    // Exact stage match, not the router grade-lib's substring-based `covers()`: audit's
    // crew shape is ours (makeStage(role, ...) sets `stage` to the role verbatim), and
    // buildAuditManifest's task text ends in trailing punctuation (e.g. "...fix)"), whose
    // `split(/\W+/)` yields an empty-string token that trivially substring-matches ANY
    // role under `covers()` — exact match is both correct and meaningful here.
    const stages = new Set((m.crew || []).map((c) => c.stage));
    const missing = expect.crewCoversRoles.filter((r) => !stages.has(r));
    checks.push({ name: "crewCoversRoles", ok: missing.length === 0, detail: missing.length ? `crew missing role coverage: ${missing.join(", ")}` : "crew covers all expected roles" });
  }
  return checks;
}

function auditLedgerCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const { lines, parsed, check } = rowFormatCheck(artifacts, LEDGER_LINE_RE, "finding");
  const checks = [check];
  if (expect.minFindings != null) checks.push({ name: "minFindings", ok: lines.length >= expect.minFindings, detail: `${lines.length} finding(s), expected >= ${expect.minFindings}` });
  if (expect.sortedBySeverity) {
    const sevs = parsed.filter(Boolean).map((m) => SEVERITY_RANK[m[1]]);
    const sorted = sevs.every((s, i) => i === 0 || s >= sevs[i - 1]);
    checks.push({ name: "sortedBySeverity", ok: sorted, detail: sorted ? "findings ranked P0 before P1 before P2" : `severity order violated: ${JSON.stringify(sevs)}` });
  }
  return checks;
}

function sprintWavesCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const r = computeSprintWaves(artifacts);
  const checks = [];
  if (expect.ok !== undefined) checks.push({ name: "ok", ok: r.ok === expect.ok, detail: `ok=${r.ok}, expected ${expect.ok}` });
  if (expect.annotated !== undefined) checks.push({ name: "annotated", ok: r.annotated === expect.annotated, detail: `annotated=${r.annotated}, expected ${expect.annotated}` });
  if (expect.waves !== undefined) checks.push({ name: "waves", ok: JSON.stringify(r.waves) === JSON.stringify(expect.waves), detail: `waves=${JSON.stringify(r.waves)}, expected ${JSON.stringify(expect.waves)}` });
  if (expect.errorsNonEmpty) checks.push({ name: "errorsNonEmpty", ok: r.errors.length > 0, detail: `errors=${JSON.stringify(r.errors)}` });
  if (expect.itemDispositions) {
    for (const [id, disp] of Object.entries(expect.itemDispositions)) {
      const got = r.items[id] && r.items[id].disposition;
      checks.push({ name: `disposition:${id}`, ok: got === disp, detail: `items[${id}].disposition=${got}, expected ${disp}` });
    }
  }
  if (expect.itemEscalated) {
    for (const [id, esc] of Object.entries(expect.itemEscalated)) {
      const got = r.items[id] && r.items[id].escalated;
      checks.push({ name: `escalated:${id}`, ok: got === esc, detail: `items[${id}].escalated=${got}, expected ${esc}` });
    }
  }
  return checks;
}

function oneAttendedStopCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const marker = expect.marker || "## Batch report";
  const text = String(artifacts);
  const markerCount = text.split(marker).length - 1;
  const promptCount = (text.match(/AskUserQuestion/g) || []).length;
  const expectPrompts = expect.promptCount ?? 1;
  return [
    { name: "singleBatchReportMarker", ok: markerCount === 1, detail: `found ${markerCount} occurrence(s) of "${marker}", expected exactly 1` },
    { name: "singleAttendedPrompt", ok: promptCount === expectPrompts, detail: `found ${promptCount} AskUserQuestion occurrence(s), expected ${expectPrompts}` },
  ];
}

function assessCheck(testCase) {
  const expect = testCase.expect || {};
  const r = assessOutcome(testCase.outcome);
  const checks = [{ name: "clear", ok: r.clear === expect.clear, detail: `assessOutcome(outcome).clear = ${r.clear}, expected ${expect.clear}` }];
  if (expect.signalsInclude) {
    const missing = expect.signalsInclude.filter((s) => !r.signals.includes(s));
    checks.push({ name: "signalsInclude", ok: missing.length === 0, detail: missing.length ? `missing signal(s): ${missing.join(", ")} (got ${JSON.stringify(r.signals)})` : `signals include ${JSON.stringify(expect.signalsInclude)}` });
  }
  return checks;
}

function issueRefCheck(testCase) {
  const expect = testCase.expect || {};
  const r = parseIssueRef(testCase.outcome);
  const isIssueRef = r.kind === "issue";
  const checks = [{ name: "isIssueRef", ok: isIssueRef === expect.isIssueRef, detail: `parseIssueRef(outcome).kind = "${r.kind}", expected isIssueRef=${expect.isIssueRef}` }];
  if (expect.number != null) checks.push({ name: "number", ok: r.number === expect.number, detail: `number=${r.number}, expected ${expect.number}` });
  return checks;
}

// run.md step 0b: the batch-ref grammar (file | issues:<label> | linear:<key> |
// outcome | invalid) that decides whether run plans a single outcome or renders the
// batch plan. Grades src/batch-plan.js's parseBacklogRef directly, same tier as
// issue-ref grading parseIssueRef.
function backlogRefCheck(testCase) {
  const expect = testCase.expect || {};
  const r = parseBacklogRef(testCase.outcome);
  const checks = [{ name: "kind", ok: r.kind === expect.kind, detail: `parseBacklogRef(outcome).kind = "${r.kind}", expected "${expect.kind}"` }];
  if (expect.path != null) checks.push({ name: "path", ok: r.path === expect.path, detail: `path=${r.path}, expected ${expect.path}` });
  if (expect.label != null) checks.push({ name: "label", ok: r.label === expect.label, detail: `label=${r.label}, expected ${expect.label}` });
  if (expect.key != null) checks.push({ name: "key", ok: r.key === expect.key, detail: `key=${r.key}, expected ${expect.key}` });
  return checks;
}

// run.md's Batch plan section: cross-item file-conflict flags over per-item fence
// labels (the union of each item manifest's plan[].owns). Advisory flags, never a
// gate. Artifact: JSON `{ items: [{id, owns: [...]}] }` (or a bare array).
function batchConflictsCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const items = Array.isArray(artifacts) ? artifacts : artifacts && artifacts.items;
  const r = crossItemConflicts(items);
  const checks = [];
  if (expect.conflictPairs !== undefined) {
    const pairs = r.conflicts.map((c) => [c.a, c.b]);
    checks.push({ name: "conflictPairs", ok: JSON.stringify(pairs) === JSON.stringify(expect.conflictPairs), detail: `conflict pairs ${JSON.stringify(pairs)}, expected ${JSON.stringify(expect.conflictPairs)}` });
  }
  if (expect.unfenced !== undefined) {
    checks.push({ name: "unfenced", ok: JSON.stringify(r.unfenced) === JSON.stringify(expect.unfenced), detail: `unfenced ${JSON.stringify(r.unfenced)}, expected ${JSON.stringify(expect.unfenced)}` });
  }
  if (expect.overlapsInclude) {
    const all = r.conflicts.flatMap((c) => c.overlaps);
    const missing = expect.overlapsInclude.filter((o) => !all.includes(o));
    checks.push({ name: "overlapsInclude", ok: missing.length === 0, detail: missing.length ? `missing overlap(s): ${missing.join(", ")} (got ${JSON.stringify(all)})` : `overlaps include ${JSON.stringify(expect.overlapsInclude)}` });
  }
  return checks;
}

function manifestCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const v = validateManifest(artifacts);
  const wantValid = expect.validates ?? true;
  const checks = [{ name: "validates", ok: v.ok === wantValid, detail: v.ok ? "manifest valid" : `invalid: ${v.errors.join("; ")}` }];
  if (expect.requireFences) {
    const ok = planFencesOk(artifacts);
    checks.push({ name: "fences", ok, detail: ok ? "parallel plan tasks carry owns/frozen fences" : "a parallel plan task is missing both owns and frozen" });
  }
  if (expect.expectRoles) {
    // Exact stage match (crew[i].stage is always the role name — validateManifest requires
    // it, and every builder in this codebase sets it verbatim). Deliberately not router
    // grade-lib's substring-based `covers()`: its plan-text tokenizer (`split(/\W+/)`) can
    // yield an empty-string token on trailing punctuation, which trivially substring-matches
    // ANY role and silently defeats a missing-role check — exact match sidesteps that.
    const stages = new Set((artifacts.crew || []).map((c) => c.stage));
    const missing = expect.expectRoles.filter((r) => !stages.has(r));
    checks.push({ name: "roleCoverage", ok: missing.length === 0, detail: missing.length ? `missing role coverage: ${missing.join(", ")}` : "all expected roles covered" });
  }
  if (expect.nonInline) {
    const crew = artifacts.crew || [];
    const ok = crew.length > 0 && !crew.every((c) => c.source === "inline");
    checks.push({ name: "nonInline", ok, detail: ok ? "crew is not all-inline" : "crew is all-inline (routing bypassed)" });
  }
  return checks;
}

function dispositionCheck(testCase) {
  const expect = testCase.expect || {};
  const resolved = resolveMergeDisposition(expect.declared, { attended: expect.attended });
  return [{ name: "resolvedDisposition", ok: resolved === expect.expected, detail: `resolveMergeDisposition("${expect.declared}", attended=${expect.attended}) = "${resolved}", expected "${expect.expected}"` }];
}

function commitMessageCheck(testCase, artifacts) {
  const lines = String(artifacts).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bad = lines.filter((l) => !WAVE_COMMIT_RE.test(l));
  return [{ name: "allMatchWaveConvention", ok: bad.length === 0, detail: bad.length ? `non-conforming line(s): ${JSON.stringify(bad)}` : `all ${lines.length} commit message(s) match "feat(wave N): ..."` }];
}

function runnerReceiptsCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const lines = receiptLines(artifacts);
  const parsed = lines.map(classifyReceiptLine);
  const checks = [];

  const badLines = lines.filter((_, i) => !parsed[i]);
  checks.push({ name: "grammarValid", ok: badLines.length === 0, detail: badLines.length ? `unrecognized receipt line(s): ${JSON.stringify(badLines)}` : `all ${lines.length} receipt line(s) match the coordination grammar` });

  const claimedByItem = new Map();
  for (const p of parsed) {
    if (p && p.type === "CLAIMED") {
      const id = p.m[1], ts = p.m[3];
      if (!claimedByItem.has(id)) claimedByItem.set(id, []);
      claimedByItem.get(id).push(ts);
    }
  }
  const terminal = parsed.filter((p) => p && (p.type === "DONE" || p.type === "BLOCKED" || p.type === "FAILED"));
  const unclaimed = terminal.filter((p) => {
    const claims = claimedByItem.get(p.m[1]) || [];
    return !claims.some((c) => c <= p.m[3]);
  });
  checks.push({ name: "claimBeforeWork", ok: unclaimed.length === 0, detail: unclaimed.length ? `terminal receipt(s) with no prior CLAIMED: ${unclaimed.map((p) => p.line).join(" | ")}` : "every terminal receipt is preceded by a CLAIMED receipt for the same item" });

  if (expect.expectDisposition) {
    const doneLines = parsed.filter((p) => p && p.type === "DONE");
    const bad = doneLines.filter((p) => p.m[4] !== expect.expectDisposition);
    checks.push({ name: "dispositionForced", ok: bad.length === 0, detail: bad.length ? `DONE line(s) with unexpected disposition: ${bad.map((p) => p.line).join(" | ")}` : `every DONE receipt carries disposition "${expect.expectDisposition}"` });
  }

  const ledgerByRunner = new Map();
  for (const p of parsed) if (p && p.type === "LEDGER") ledgerByRunner.set(p.m[1], (ledgerByRunner.get(p.m[1]) || 0) + 1);
  const overLimit = [...ledgerByRunner.entries()].filter(([, n]) => n > 1);
  checks.push({ name: "oneLedgerHeartbeatPerRunner", ok: overLimit.length === 0, detail: overLimit.length ? `runner(s) with >1 LEDGER line: ${overLimit.map(([r, n]) => `${r}:${n}`).join(", ")}` : "every runner has at most one LEDGER heartbeat line" });

  return checks;
}

export const ARTIFACT_KIND = {
  "diagnose-classify": "none",
  "diagnose-manifest": "none",
  "audit-manifest": "none",
  "audit-ledger": "text",
  "audit-backlog-waves": "text",
  assess: "none",
  "issue-ref": "none",
  "backlog-ref": "none",
  "batch-conflicts": "json",
  manifest: "json",
  "sprint-waves": "text",
  "sprint-one-attended-stop": "text",
  disposition: "none",
  "commit-message": "text",
  "runner-receipts": "text",
};

export const CHECKS = {
  "diagnose-classify": diagnoseClassifyCheck,
  "diagnose-manifest": diagnoseManifestCheck,
  "audit-manifest": auditManifestCheck,
  "audit-ledger": auditLedgerCheck,
  "audit-backlog-waves": sprintWavesCheck,
  assess: assessCheck,
  "issue-ref": issueRefCheck,
  "backlog-ref": backlogRefCheck,
  "batch-conflicts": batchConflictsCheck,
  manifest: manifestCheck,
  "sprint-waves": sprintWavesCheck,
  "sprint-one-attended-stop": oneAttendedStopCheck,
  disposition: dispositionCheck,
  "commit-message": commitMessageCheck,
  "runner-receipts": runnerReceiptsCheck,
};
