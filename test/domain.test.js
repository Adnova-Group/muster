import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDomain, knownDomains } from "../src/domain.js";

test("override always wins", () => {
  assert.deepEqual(classifyDomain("anything", {}, "marketing"),
    { domain: "marketing", source: "override", confidence: 1 });
});
test("pm keyword in outcome", () => {
  assert.equal(classifyDomain("Write a PRD for checkout", {}).domain, "pm");
});
test("business keyword", () => {
  assert.equal(classifyDomain("Build a business case for X", {}).domain, "business");
});
test("workspace -> software when no keyword", () => {
  assert.equal(classifyDomain("make it faster", { shape: "backend", greenfield: false }).domain, "software");
});
test("unknown when nothing matches", () => {
  assert.equal(classifyDomain("hello there", { shape: "unknown", greenfield: true }).domain, "unknown");
});
test("classifyDomain matches keywords on word boundaries, not substrings", () => {
  assert.notEqual(classifyDomain("describe the epicenter of the outage").domain, "pm");
  assert.notEqual(classifyDomain("write a functional walkthrough").domain, "software");
});
test("video keyword in outcome routes to the video domain (reachable by domain, not just match list)", () => {
  assert.equal(classifyDomain("put together a screencast for onboarding").domain, "video");
  assert.equal(classifyDomain("write a video script about our launch").domain, "video");
});
test("knownDomains exposes the classifier's domain vocabulary, including video and software", () => {
  const domains = knownDomains();
  assert.ok(domains.includes("video"));
  assert.ok(domains.includes("software"));
  assert.ok(domains.includes("pm"));
});

// WHY (backlog item codex-assess-criteria-detect, 2026-07-18 Codex dogfood): a concrete code
// outcome ("buildBaseShaReceipt in src/wave-dispatch.js validates SHA format but never
// verifies...") classified as domain:unknown. Root cause: DOMAIN_KEYWORDS.software's
// vocabulary (implement/refactor/bug/api/endpoint/function/deploy) doesn't cover this
// outcome's actual engineering vocabulary, so the direct keyword match misses -- and the
// workspace-shape fallback ALSO misses for a repo like muster's own (no package.json
// main/exports, no FE/BE framework deps -> shape stays "unknown", proven directly against
// detectProject(process.cwd()) in this checkout), so classifyDomain falls all the way through
// to domain:unknown, source:none. This is the exact dogfood fixture (also used verbatim in
// test/interview.test.js), classified with NO profile at all -- i.e. the fix must come from
// the outcome-text keyword grammar, not from the workspace-shape fallback. Fixed via "tdd" and
// "sha" (both present in this fixture) -- NOT via "validate(s)"/"verify"/"verifies"/
// "verification", which review-gate fix-loop 1 proved misroute realistic non-software outcomes
// (a compliance memo that "validates customer identity documents", HR that "verifies employee
// timesheets", finance that "validates monthly expense claims") straight into domain:software.
const DOGFOOD_RECEIPT_VERIFICATION_OUTCOME =
  "buildBaseShaReceipt in src/wave-dispatch.js validates SHA format but never verifies the SHA " +
  "actually resolves to a real commit. Add real verification: the receipt builder accepts an " +
  "injected verifier that checks the SHA against the repo, receipts record verified: true/false " +
  "plus the verification mechanism, and callers that depend on the receipt fail loud when " +
  "verification is available but fails. TDD; keep the existing fail-loud behavior for malformed SHAs.";

test("dogfood fixture: concrete code-outcome vocabulary (TDD/SHA) classifies as software with NO profile fallback", () => {
  const r = classifyDomain(DOGFOOD_RECEIPT_VERIFICATION_OUTCOME);
  assert.equal(r.domain, "software", `expected software, got ${r.domain} (source: ${r.source})`);
  assert.equal(r.source, "outcome", "must classify from the outcome text's own vocabulary, not a workspace fallback");
});

// WHY: realistic variants of the same engineering vocabulary -- each on its own, with no other
// software keyword present, must independently route to software.
test("engineering vocabulary: 'TDD' alone routes to software", () => {
  assert.equal(classifyDomain("write the new parser TDD, red first").domain, "software");
});
test("engineering vocabulary: 'SHA' alone routes to software", () => {
  assert.equal(classifyDomain("pin the vendored dependency to an exact commit SHA").domain, "software");
});

// WHY: substring safety for the new keywords, mirroring the existing word-boundary guard above
// -- "tdd"/"sha" must not fire from an unrelated word merely containing them as a substring
// (e.g. "shape", "washable").
test("new software keywords match on word boundaries, not substrings", () => {
  assert.notEqual(classifyDomain("describe the shape of the outage timeline").domain, "software");
  assert.notEqual(classifyDomain("wash the dishes and shape the schedule for next week").domain, "software");
});

// WHY (review-gate fix-loop 1, adversarial finding): "validate(s)"/"verify"/"verifies"/
// "verification" were tried and reverted precisely because these realistic non-software
// outcomes (compliance/HR/finance/research, none of which any earlier domain in the list
// claims) must NOT be swept into domain:software just because they use a generic
// validate/verify verb. Pins the revert so it can't silently regress back in.
test("negative control: 'validate'/'verify' in realistic non-software outcomes does not route to software", () => {
  assert.notEqual(
    classifyDomain("Write a compliance memo explaining how we validate customer identity documents before onboarding.").domain,
    "software",
  );
  assert.notEqual(
    classifyDomain("Create a training deck to help HR verify employee timesheets each week.").domain,
    "software",
  );
  assert.notEqual(
    classifyDomain("Prepare a report on how the finance team validates monthly expense claims.").domain,
    "software",
  );
  assert.notEqual(
    classifyDomain("validate the customer survey responses for the research report").domain,
    "software",
  );
});
