import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { matchProviders, matchSkills, suggestSkillsForStack, signalsFromTask, lastColonSegment, impliedSurfaceForSkillId } from "../src/match.js";

const pexecFile = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CLI = join(REPO_ROOT, "src/cli.js");
function runCli(args) { return pexecFile(process.execPath, [CLI, ...args], { cwd: REPO_ROOT }); }

// A debugging task should rank a debug-role entry above an unrelated one.
test("ranks a role-matching entry above an unrelated one", () => {
  const catalog = [
    { id: "wsh-debugger", roles: ["debug"], kind: "agent", rank: 50 },
    { id: "wsh-frontend", roles: ["frontend"], kind: "agent", rank: 50 },
  ];
  const r = matchProviders("debug a failing flaky test", catalog);
  assert.equal(r[0].id, "wsh-debugger");
  // the unrelated frontend entry shares no tokens → score 0 → skipped entirely.
  assert.ok(!r.some(e => e.id === "wsh-frontend"));
  assert.deepEqual(r[0].matched, ["debug"]);
});

// Description-only match: id/roles don't carry the term but description does.
// It still matches, but scores lower than an id/role match for the same term.
test("description match scores lower than an id/role match", () => {
  const catalog = [
    // "performance" lives only in the description (LOW weight 1).
    { id: "profiler-x", roles: ["refactor"], kind: "agent", rank: 50,
      description: "tunes runtime performance of hot loops" },
    // "performance" lives in the role list (HIGH weight 3).
    { id: "perf-agent", roles: ["performance"], kind: "agent", rank: 50 },
  ];
  const r = matchProviders("improve performance", catalog);
  assert.equal(r.length, 2);
  assert.equal(r[0].id, "perf-agent");   // HIGH weight wins
  assert.equal(r[1].id, "profiler-x");   // description-only, lower score
  assert.ok(r[0].score > r[1].score);
  assert.deepEqual(r[1].matched, ["performance"]);
});

// An installed external entry edges out an equal-scoring builtin via the install boost.
test("installed external edges out an equal-scoring builtin", () => {
  const catalog = [
    { id: "builtin-debug", roles: ["debug"], kind: "builtin", rank: 50,
      provenance: { license: "Apache-2.0" } },
    { id: "ext-debug", roles: ["debug"], kind: "external", rank: 50,
      detect: { kind: "plugin", match: "ext-debug-plugin" } },
  ];
  const installed = { plugins: ["ext-debug-plugin"], skills: [], mcpServers: [], agents: [] };
  const r = matchProviders("debug this", catalog, installed);
  assert.equal(r[0].id, "ext-debug");
  assert.equal(r[0].source, "installed");
  assert.equal(r.find(e => e.id === "builtin-debug").source, "builtin");
  // not-installed external would be source "external"
  const r2 = matchProviders("debug this", catalog, { plugins: [], skills: [], mcpServers: [], agents: [] });
  assert.equal(r2.find(e => e.id === "ext-debug").source, "external");
});

// Empty / non-string task → [].
test("empty or non-string task returns []", () => {
  const catalog = [{ id: "x", roles: ["debug"], kind: "agent", rank: 50 }];
  assert.deepEqual(matchProviders("", catalog), []);
  assert.deepEqual(matchProviders("   ", catalog), []);
  assert.deepEqual(matchProviders(null, catalog), []);
  assert.deepEqual(matchProviders(42, catalog), []);
  assert.deepEqual(matchProviders(undefined, catalog), []);
});

// limit is respected.
test("respects opts.limit", () => {
  const catalog = Array.from({ length: 12 }, (_, i) => ({
    id: `debug-${i}`, roles: ["debug"], kind: "agent", rank: i,
  }));
  const r = matchProviders("debug", catalog, {}, { limit: 3 });
  assert.equal(r.length, 3);
  // default limit is 8
  assert.equal(matchProviders("debug", catalog).length, 8);
});

// Shape of returned entries.
test("returns the documented shape", () => {
  const catalog = [{ id: "wsh-debugger", roles: ["debug"], kind: "agent", rank: 50 }];
  const [e] = matchProviders("debug", catalog);
  assert.deepEqual(Object.keys(e).sort(), ["id", "kind", "matched", "roles", "score", "source"].sort());
});

// ---------------------------------------------------------------------------
// matchSkills — same weighted-bag ranking, scoped to the {id, source, description}
// skills-inventory shape resolveCapabilities returns (no roles/keywords fields).
// ---------------------------------------------------------------------------

test("matchSkills: id-token match scores above description-only match", () => {
  const skills = [
    { id: "muster-humanizer", source: "builtin", description: "" },
    { id: "profiler-x", source: "builtin", description: "tunes humanizer-adjacent tone of copy" },
  ];
  const r = matchSkills("humanizer pass on the copy", skills);
  assert.equal(r[0].id, "muster-humanizer");
  assert.ok(r[0].score > r.find(e => e.id === "profiler-x").score);
});

test("matchSkills: empty/non-string task returns []", () => {
  const skills = [{ id: "x", source: "builtin", description: "" }];
  assert.deepEqual(matchSkills("", skills), []);
  assert.deepEqual(matchSkills(null, skills), []);
});

test("matchSkills: no overlap -> []", () => {
  const skills = [{ id: "unrelated-thing", source: "builtin", description: "nothing shared" }];
  assert.deepEqual(matchSkills("zzz qqq", skills), []);
});

// Parity with matchProviders' installed boost: an equal-scoring installed skill edges
// out an equal-scoring builtin one (a present skill outranks a same-token builtin
// fallback).
test("matchSkills: installed edges out an equal-scoring builtin (+1 installed boost)", () => {
  const skills = [
    { id: "builtin-humanizer", source: "builtin", description: "" },
    { id: "installed-humanizer", source: "installed", description: "" },
  ];
  const r = matchSkills("humanizer", skills);
  assert.equal(r[0].id, "installed-humanizer");
  assert.ok(r[0].score > r.find(e => e.id === "builtin-humanizer").score);
});

test("matchSkills: returns the documented shape", () => {
  const skills = [{ id: "muster-humanizer", source: "builtin", description: "" }];
  const [e] = matchSkills("humanizer", skills);
  assert.deepEqual(Object.keys(e).sort(), ["id", "matched", "score", "source"].sort());
});

// ---------------------------------------------------------------------------
// suggestSkillsForStack — deterministic stack→skill map. missing:true when the
// suggested id isn't present in the live skills inventory (the router's gap protocol).
// ---------------------------------------------------------------------------

test("suggestSkillsForStack: nextjs framework suggests the three vercel skills (real un-namespaced ids)", () => {
  const r = suggestSkillsForStack({ frameworks: ["next"] }, []);
  const ids = r.map(s => s.id).sort();
  // ids match the real, un-namespaced on-disk skill-dir names (nextjs/shadcn/ai-sdk), not
  // a colon-namespaced `vercel:*` form — that form is never a real installed skill id.
  assert.deepEqual(ids, ["ai-sdk", "nextjs", "shadcn"]);
  assert.ok(r.every(s => s.missing === true), "none installed -> all missing");
  assert.ok(r.every(s => typeof s.reason === "string" && s.reason.length > 0));
});

test("suggestSkillsForStack: nextjs framework skills resolve missing:false against an inventory containing nextjs/shadcn/ai-sdk", () => {
  const inventory = [
    { id: "nextjs", source: "installed" },
    { id: "shadcn", source: "installed" },
    { id: "ai-sdk", source: "installed" },
  ];
  const r = suggestSkillsForStack({ frameworks: ["next"] }, inventory);
  assert.equal(r.length, 3);
  assert.ok(r.every(s => s.missing === false), "all three resolve against a live-shaped skills inventory");
});

test("suggestSkillsForStack: last-colon-segment matching is namespace-insensitive in either direction", () => {
  // inventory id is colon-namespaced, mapped suggestion id is bare -> still resolves.
  const r1 = suggestSkillsForStack({ frameworks: ["supabase"] }, [{ id: "vendor:supabase", source: "installed" }]);
  assert.equal(r1[0].missing, false, "bare suggestion id matches a namespaced inventory id");

  // symmetric: lastColonSegment agrees regardless of which side carries the namespace,
  // so a future namespaced STACK_SKILL_MAP entry would equally match a bare inventory id.
  assert.equal(lastColonSegment("vercel:nextjs"), lastColonSegment("nextjs"));
  assert.equal(lastColonSegment("nextjs"), lastColonSegment("vercel:nextjs"));
});

test("suggestSkillsForStack: supabase framework suggests the supabase skill", () => {
  const r = suggestSkillsForStack({ frameworks: ["supabase"] }, []);
  assert.deepEqual(r.map(s => s.id), ["supabase"]);
  assert.equal(r[0].missing, true);
});

test("suggestSkillsForStack: an installed id is not flagged missing", () => {
  const r = suggestSkillsForStack({ frameworks: ["supabase"] }, [{ id: "supabase", source: "installed" }]);
  assert.equal(r[0].missing, false);
});

test("suggestSkillsForStack: user-facing UI keyword suggests frontend-design + design/UX skills", () => {
  const r = suggestSkillsForStack({ keywords: ["ui"] }, []);
  assert.ok(r.some(s => s.id === "frontend-design"));
  assert.ok(r.length >= 2, "should include frontend-design plus at least one design/UX skill");
});

test("suggestSkillsForStack: customer-facing copy keyword suggests the humanizer skill", () => {
  const r = suggestSkillsForStack({ keywords: ["copy"] }, []);
  assert.deepEqual(r.map(s => s.id), ["muster-humanizer"]);
});

test("suggestSkillsForStack: integration/external-API keyword suggests the verification skill", () => {
  const r = suggestSkillsForStack({ keywords: ["api"] }, []);
  assert.deepEqual(r.map(s => s.id), ["sp-verify"]);
});

test("suggestSkillsForStack: unknown framework/keyword -> []", () => {
  assert.deepEqual(suggestSkillsForStack({ frameworks: ["cobol"], keywords: ["nonsense"] }, []), []);
});

test("suggestSkillsForStack: no duplicate ids across overlapping triggers", () => {
  const r = suggestSkillsForStack({ frameworks: ["next", "next"], keywords: ["ui", "page"] }, []);
  const ids = r.map(s => s.id);
  assert.deepEqual(ids, [...new Set(ids)]);
});

// ---------------------------------------------------------------------------
// impliedSurfaceForSkillId — reverse lookup used by manifest.js's surface-mismatch
// warning: does binding this skill id imply a ui/copy/integration surface?
// ---------------------------------------------------------------------------

test("impliedSurfaceForSkillId: a design/UX skill implies surface ui", () => {
  assert.equal(impliedSurfaceForSkillId("frontend-design"), "ui");
  assert.equal(impliedSurfaceForSkillId("wsh-design-system-patterns"), "ui");
  assert.equal(impliedSurfaceForSkillId("wsh-responsive-design"), "ui");
});

test("impliedSurfaceForSkillId: the humanizer skill implies surface copy", () => {
  assert.equal(impliedSurfaceForSkillId("muster-humanizer"), "copy");
});

test("impliedSurfaceForSkillId: sp-verify implies surface integration", () => {
  assert.equal(impliedSurfaceForSkillId("sp-verify"), "integration");
});

test("impliedSurfaceForSkillId: an id with no surface implication returns null", () => {
  assert.equal(impliedSurfaceForSkillId("muster-builder"), null);
  assert.equal(impliedSurfaceForSkillId("totally-unrelated-skill"), null);
});

test("impliedSurfaceForSkillId: namespace-insensitive, same as lastColonSegment elsewhere", () => {
  assert.equal(impliedSurfaceForSkillId("vendor:frontend-design"), "ui");
  assert.equal(impliedSurfaceForSkillId("vendor:muster-humanizer"), "copy");
});

// ---------------------------------------------------------------------------
// signalsFromTask — free-text -> ProjectProfile-style signals (default source for
// the CLI's stack suggestions when no --stack/profile is supplied).
// ---------------------------------------------------------------------------

test("signalsFromTask: tokenizes into frameworks + keywords", () => {
  const s = signalsFromTask("build a Next.js chat page over Supabase with a branded report");
  assert.ok(s.frameworks.includes("next"));
  assert.ok(s.frameworks.includes("supabase"));
  assert.ok(s.keywords.includes("page"));
  assert.ok(s.keywords.includes("branded"));
});

// ---------------------------------------------------------------------------
// CLI wiring: `match --skills <task> [--stack <csv>]`
// ---------------------------------------------------------------------------

test("cli wire: match --skills returns {ranked, suggested}", async () => {
  const { stdout } = await runCli(["match", "--skills", "humanizer pass please"]);
  const parsed = JSON.parse(stdout);
  assert.ok(Array.isArray(parsed.ranked), "'ranked' must be an array");
  assert.ok(Array.isArray(parsed.suggested), "'suggested' must be an array");
});

// Note: `missing` reflects the CALLING MACHINE's real ~/.claude inventory (same as
// every other capabilities-driven verb — see cli-wire.test.js's capabilities tests),
// so this only pins the parts that hold on any machine: the suggestion ids themselves
// (the real, un-namespaced on-disk skill-dir names — nextjs/shadcn/ai-sdk, not a
// colon-namespaced vercel:* form) and that `missing` is always a boolean. The
// deterministic missing:false / namespace-insensitive-matching behavior itself is
// pinned above against a controlled inventory (see the suggestSkillsForStack tests).
test("cli wire: match --skills on a Next.js/Supabase task suggests nextjs/shadcn/ai-sdk/supabase/frontend/humanizer skills with missing flags", async () => {
  const { stdout } = await runCli(["match", "--skills", "build a Next.js chat page over Supabase with a branded report"]);
  const { suggested } = JSON.parse(stdout);
  const byId = Object.fromEntries(suggested.map(s => [s.id, s]));
  for (const id of ["nextjs", "shadcn", "ai-sdk", "supabase", "frontend-design", "muster-humanizer"]) {
    assert.ok(id in byId, `expected suggestion for ${id}`);
    assert.equal(typeof byId[id].missing, "boolean", `${id}.missing must be boolean`);
  }
});

test("cli wire: match --skills --stack overrides the task-text-derived signals", async () => {
  const { stdout } = await runCli(["match", "--skills", "totally unrelated task text", "--stack", "supabase"]);
  const { suggested } = JSON.parse(stdout);
  assert.deepEqual(suggested.map(s => s.id), ["supabase"]);
});

test("cli wire: match --skills missing task fails", async () => {
  try {
    await runCli(["match", "--skills"]);
    assert.fail("should have exited non-zero");
  } catch (err) {
    assert.ok(err.code !== 0);
  }
});

// Flag-collision guard: when --skills is immediately followed by another flag (no task
// text supplied), the CLI must not swallow that flag token as the task — it must fail
// with the same "missing task" error as the bare `match --skills` case above, not exit 0
// with nonsense ranked/suggested results built from the literal string "--stack".
test("cli wire: match --skills --stack foo (no task text) fails rather than treating --stack as the task", async () => {
  try {
    await runCli(["match", "--skills", "--stack", "foo"]);
    assert.fail("should have exited non-zero");
  } catch (err) {
    assert.ok(err.code !== 0, "exit code must be non-zero");
    assert.match(err.stderr, /missing task/i, "stderr must explain the missing task, not silently succeed");
  }
});
