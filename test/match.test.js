import { test } from "node:test";
import assert from "node:assert/strict";
import { matchProviders } from "../src/match.js";

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
