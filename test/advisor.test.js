/**
 * Tests for advisor-core (wave 1): src/model.js advisor role +
 * src/advisor.js (validateAdviceRequest / validateAdviceResponse / consultBudget)
 * + `muster advise` CLI verb.
 *
 * TDD: written before implementation. Run with `node --test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { modelForRole } from "../src/model.js";
import {
  validateAdviceRequest,
  validateAdviceResponse,
  consultBudget,
} from "../src/advisor.js";

// ---------------------------------------------------------------------------
// 1. modelForRole('advisor') — peak tier (mirrors 'judge' / 'architecture-review')
// ---------------------------------------------------------------------------

test("modelForRole('advisor'): degrades to opus by default (fable disabled)", () => {
  const prev = process.env.MUSTER_ENABLE_FABLE;
  delete process.env.MUSTER_ENABLE_FABLE;
  try {
    assert.equal(modelForRole("advisor"), "opus");
  } finally {
    if (prev !== undefined) process.env.MUSTER_ENABLE_FABLE = prev;
  }
});

test("modelForRole('advisor'): returns fable when MUSTER_ENABLE_FABLE='1'", () => {
  const prev = process.env.MUSTER_ENABLE_FABLE;
  process.env.MUSTER_ENABLE_FABLE = "1";
  try {
    assert.equal(modelForRole("advisor"), "fable");
  } finally {
    if (prev === undefined) delete process.env.MUSTER_ENABLE_FABLE;
    else process.env.MUSTER_ENABLE_FABLE = prev;
  }
});

// ---------------------------------------------------------------------------
// 2. validateAdviceRequest
// ---------------------------------------------------------------------------

const VALID_REQUEST = {
  question: "Should we migrate to microservices?",
  context: "Monolith with 50k LOC, team of 10, 2-year runway",
  decisionType: "architecture",
};

test("validateAdviceRequest: ok=true for a valid request with required fields", () => {
  const r = validateAdviceRequest(VALID_REQUEST);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test("validateAdviceRequest: ok=true when optional options array is present", () => {
  const r = validateAdviceRequest({ ...VALID_REQUEST, options: ["migrate", "stay", "hybrid"] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test("validateAdviceRequest: rejects null / non-object input", () => {
  for (const bad of [null, undefined, "string", 42, []]) {
    const r = validateAdviceRequest(bad);
    assert.equal(r.ok, false, `expected ok=false for ${JSON.stringify(bad)}`);
    assert.ok(r.errors.length > 0);
  }
});

test("validateAdviceRequest: error when 'question' is missing", () => {
  const { question: _, ...rest } = VALID_REQUEST;
  const r = validateAdviceRequest(rest);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes("question")), `errors must mention 'question': ${r.errors}`);
});

test("validateAdviceRequest: error when 'question' is empty string", () => {
  const r = validateAdviceRequest({ ...VALID_REQUEST, question: "   " });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes("question")), `errors must mention 'question': ${r.errors}`);
});

test("validateAdviceRequest: error when 'context' is missing", () => {
  const { context: _, ...rest } = VALID_REQUEST;
  const r = validateAdviceRequest(rest);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes("context")), `errors must mention 'context': ${r.errors}`);
});

test("validateAdviceRequest: error when 'decisionType' is missing", () => {
  const { decisionType: _, ...rest } = VALID_REQUEST;
  const r = validateAdviceRequest(rest);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes("decisionType")), `errors must mention 'decisionType': ${r.errors}`);
});

test("validateAdviceRequest: error when 'options' is present but not an array", () => {
  const r = validateAdviceRequest({ ...VALID_REQUEST, options: "not-an-array" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes("options")), `errors must mention 'options': ${r.errors}`);
});

test("validateAdviceRequest: accumulates multiple errors for multiple missing fields", () => {
  const r = validateAdviceRequest({});
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 3, `expected >= 3 errors, got ${r.errors.length}: ${r.errors}`);
});

// ---------------------------------------------------------------------------
// 3. validateAdviceResponse
// ---------------------------------------------------------------------------

const VALID_RESPONSE = {
  recommendation: "Migrate incrementally using the strangler fig pattern",
  rationale: "Lower risk than big-bang; team can learn as they go",
};

test("validateAdviceResponse: ok=true for a valid response", () => {
  const r = validateAdviceResponse(VALID_RESPONSE);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test("validateAdviceResponse: rejects null / non-object input", () => {
  for (const bad of [null, undefined, "string", 42, []]) {
    const r = validateAdviceResponse(bad);
    assert.equal(r.ok, false, `expected ok=false for ${JSON.stringify(bad)}`);
    assert.ok(r.errors.length > 0);
  }
});

test("validateAdviceResponse: error when 'recommendation' is missing", () => {
  const { recommendation: _, ...rest } = VALID_RESPONSE;
  const r = validateAdviceResponse(rest);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes("recommendation")), `errors must mention 'recommendation': ${r.errors}`);
});

test("validateAdviceResponse: error when 'recommendation' is empty string", () => {
  const r = validateAdviceResponse({ ...VALID_RESPONSE, recommendation: "" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes("recommendation")), `errors must mention 'recommendation': ${r.errors}`);
});

test("validateAdviceResponse: error when 'rationale' is missing", () => {
  const { rationale: _, ...rest } = VALID_RESPONSE;
  const r = validateAdviceResponse(rest);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes("rationale")), `errors must mention 'rationale': ${r.errors}`);
});

test("validateAdviceResponse: error when 'rationale' is empty string", () => {
  const r = validateAdviceResponse({ ...VALID_RESPONSE, rationale: "" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes("rationale")), `errors must mention 'rationale': ${r.errors}`);
});

test("validateAdviceResponse: error when 'rationale' is whitespace-only", () => {
  const r = validateAdviceResponse({ ...VALID_RESPONSE, rationale: "   " });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes("rationale")), `errors must mention 'rationale': ${r.errors}`);
});

test("validateAdviceResponse: accumulates multiple errors for both missing fields", () => {
  const r = validateAdviceResponse({});
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 2, `expected >= 2 errors, got ${r.errors.length}: ${r.errors}`);
});

// ---------------------------------------------------------------------------
// 4. consultBudget — mirrors loopState cap pattern
// ---------------------------------------------------------------------------

test("consultBudget: consult=true while consults < maxConsults", () => {
  assert.deepEqual(consultBudget({ consults: 0, maxConsults: 3 }), { consult: true, reason: "consult" });
  assert.deepEqual(consultBudget({ consults: 1, maxConsults: 3 }), { consult: true, reason: "consult" });
  assert.deepEqual(consultBudget({ consults: 2, maxConsults: 3 }), { consult: true, reason: "consult" });
});

test("consultBudget: consult=false reason=budget-exhausted when consults == maxConsults", () => {
  assert.deepEqual(consultBudget({ consults: 3, maxConsults: 3 }), { consult: false, reason: "budget-exhausted" });
});

test("consultBudget: consult=false reason=budget-exhausted when consults > maxConsults", () => {
  assert.deepEqual(consultBudget({ consults: 5, maxConsults: 3 }), { consult: false, reason: "budget-exhausted" });
});

test("consultBudget: default maxConsults is 3 (from env or hardcoded default)", () => {
  const prev = process.env.MUSTER_ADVISOR_MAX_CONSULTS;
  delete process.env.MUSTER_ADVISOR_MAX_CONSULTS;
  try {
    // 2 < default 3 → should consult
    assert.deepEqual(consultBudget({ consults: 2 }), { consult: true, reason: "consult" });
    // 3 >= default 3 → exhausted
    assert.deepEqual(consultBudget({ consults: 3 }), { consult: false, reason: "budget-exhausted" });
  } finally {
    if (prev !== undefined) process.env.MUSTER_ADVISOR_MAX_CONSULTS = prev;
  }
});

// ---------------------------------------------------------------------------
// 5. MUSTER_ADVISOR_MAX_CONSULTS env guard (mirrors fuse minDisagreementThreshold)
// ---------------------------------------------------------------------------

test("MUSTER_ADVISOR_MAX_CONSULTS env overrides default: =5 allows 4 consults", () => {
  const prev = process.env.MUSTER_ADVISOR_MAX_CONSULTS;
  process.env.MUSTER_ADVISOR_MAX_CONSULTS = "5";
  try {
    assert.deepEqual(consultBudget({ consults: 4 }), { consult: true, reason: "consult" });
    assert.deepEqual(consultBudget({ consults: 5 }), { consult: false, reason: "budget-exhausted" });
  } finally {
    if (prev === undefined) delete process.env.MUSTER_ADVISOR_MAX_CONSULTS;
    else process.env.MUSTER_ADVISOR_MAX_CONSULTS = prev;
  }
});

test("MUSTER_ADVISOR_MAX_CONSULTS negative clamps to default 3", () => {
  const prev = process.env.MUSTER_ADVISOR_MAX_CONSULTS;
  process.env.MUSTER_ADVISOR_MAX_CONSULTS = "-2";
  try {
    // With default 3: consults=2 → consult; consults=3 → exhausted
    assert.deepEqual(consultBudget({ consults: 2 }), { consult: true, reason: "consult" });
    assert.deepEqual(consultBudget({ consults: 3 }), { consult: false, reason: "budget-exhausted" });
  } finally {
    if (prev === undefined) delete process.env.MUSTER_ADVISOR_MAX_CONSULTS;
    else process.env.MUSTER_ADVISOR_MAX_CONSULTS = prev;
  }
});

test("MUSTER_ADVISOR_MAX_CONSULTS junk value clamps to default 3", () => {
  const prev = process.env.MUSTER_ADVISOR_MAX_CONSULTS;
  process.env.MUSTER_ADVISOR_MAX_CONSULTS = "not-a-number";
  try {
    assert.deepEqual(consultBudget({ consults: 2 }), { consult: true, reason: "consult" });
    assert.deepEqual(consultBudget({ consults: 3 }), { consult: false, reason: "budget-exhausted" });
  } finally {
    if (prev === undefined) delete process.env.MUSTER_ADVISOR_MAX_CONSULTS;
    else process.env.MUSTER_ADVISOR_MAX_CONSULTS = prev;
  }
});

test("MUSTER_ADVISOR_MAX_CONSULTS=0: never-consult (budget immediately exhausted)", () => {
  const prev = process.env.MUSTER_ADVISOR_MAX_CONSULTS;
  process.env.MUSTER_ADVISOR_MAX_CONSULTS = "0";
  try {
    assert.deepEqual(consultBudget({ consults: 0 }), { consult: false, reason: "budget-exhausted" });
  } finally {
    if (prev === undefined) delete process.env.MUSTER_ADVISOR_MAX_CONSULTS;
    else process.env.MUSTER_ADVISOR_MAX_CONSULTS = prev;
  }
});

// ---------------------------------------------------------------------------
// 6. CLI wire: muster advise <advice-request.json>
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const pexecFile = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "../src/cli.js");

async function cliRun(args, env = {}) {
  return pexecFile(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
}

test("cli wire: muster advise exits 0 on valid request and returns JSON with advisorModel", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-advise-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));

  const reqFile = join(tmp, "request.json");
  await writeFile(reqFile, JSON.stringify({
    question: "Should we adopt GraphQL?",
    context: "REST API, 3 frontend teams, mobile clients",
    decisionType: "api-design",
  }));

  const { stdout } = await cliRun(["advise", reqFile]);
  const result = JSON.parse(stdout);
  assert.ok(result && typeof result === "object", "must return a JSON object");
  assert.ok("advisorModel" in result, "result must include 'advisorModel'");
  assert.ok(typeof result.advisorModel === "string", "advisorModel must be a string");
  assert.ok("request" in result, "result must include 'request'");
});

test("cli wire: muster advise advisorModel is 'opus' by default (fable degraded)", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-advise-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));

  const reqFile = join(tmp, "request.json");
  await writeFile(reqFile, JSON.stringify({
    question: "Build vs buy?",
    context: "Early stage startup",
    decisionType: "make-vs-buy",
  }));

  const { stdout } = await cliRun(["advise", reqFile], { MUSTER_ENABLE_FABLE: "" });
  const result = JSON.parse(stdout);
  assert.equal(result.advisorModel, "opus");
});

test("cli wire: muster advise advisorModel is 'fable' when MUSTER_ENABLE_FABLE=1", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-advise-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));

  const reqFile = join(tmp, "request.json");
  await writeFile(reqFile, JSON.stringify({
    question: "Monorepo or polyrepo?",
    context: "Growing engineering org",
    decisionType: "repository-strategy",
  }));

  const { stdout } = await cliRun(["advise", reqFile], { MUSTER_ENABLE_FABLE: "1" });
  const result = JSON.parse(stdout);
  assert.equal(result.advisorModel, "fable");
});

test("cli wire: muster advise exits non-zero and prints errors for invalid request", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-advise-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));

  const reqFile = join(tmp, "request.json");
  // missing required fields
  await writeFile(reqFile, JSON.stringify({ decisionType: "architecture" }));

  try {
    await cliRun(["advise", reqFile]);
    assert.fail("should have exited non-zero");
  } catch (err) {
    assert.ok(err.code !== 0, "exit code must be non-zero when request is invalid");
  }
});

test("cli wire: muster advise exits non-zero when file arg is missing", async () => {
  try {
    await cliRun(["advise"]);
    assert.fail("should have exited non-zero");
  } catch (err) {
    assert.ok(err.code !== 0, "exit code must be non-zero when file arg is missing");
  }
});
