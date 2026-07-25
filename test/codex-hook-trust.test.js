// Codex trusts hooks per CONTENT HASH and SKIPS new-or-changed hooks until a
// human trusts them, so every install that alters a hook body silently disables
// it. muster's existing reconciliation catches STALE trust entries; this covers
// the dangerous inverse — a MISSING one. Evidence: docs/research/codex-cli.md 10.3.
import { test } from "node:test";
import assert from "node:assert/strict";
import { musterHookTrustGaps } from "../src/codex-install.js";

const HOOKS_JSON = "/home/u/.codex/hooks.json";
const group = cmd => ({ hooks: [{ type: "command", command: cmd }] });
const CONFIG = { hooks: { PreToolUse: [group("a")], SessionStart: [group("b")] } };
const OWNED = { PreToolUse: [group("a")], SessionStart: [group("b")] };

const trustToml = keys => keys.map(k => `[hooks.state."${HOOKS_JSON}:${k}"]\ntrusted_hash = "sha256:x"\n`).join("\n");

test("musterHookTrustGaps: fully trusted install reports no gaps", () => {
  const r = musterHookTrustGaps({
    configTomlText: trustToml(["pre_tool_use:0:0", "session_start:0:0"]),
    hooksJsonPath: HOOKS_JSON, config: CONFIG, hookGroups: OWNED
  });
  assert.deepEqual(r.untrusted, []);
  assert.equal(r.owned.length, 2);
  assert.equal(r.trusted.length, 2);
});

test("musterHookTrustGaps: a changed hook that lost its trust entry is SURFACED, not silently skipped", () => {
  // The real scenario: reinstall rewrites the PreToolUse body, its hash changes,
  // Codex drops the trust entry, and that gate stops firing.
  const r = musterHookTrustGaps({
    configTomlText: trustToml(["session_start:0:0"]),
    hooksJsonPath: HOOKS_JSON, config: CONFIG, hookGroups: OWNED
  });
  assert.deepEqual(r.untrusted, ["pre_tool_use:0:0"]);
});

test("musterHookTrustGaps: a fresh install with no trust state reports every hook untrusted", () => {
  const r = musterHookTrustGaps({ configTomlText: "", hooksJsonPath: HOOKS_JSON, config: CONFIG, hookGroups: OWNED });
  assert.deepEqual(r.untrusted.sort(), ["pre_tool_use:0:0", "session_start:0:0"]);
});

test("musterHookTrustGaps: trust entries for ANOTHER hooks.json never count as ours", () => {
  const foreign = trustToml(["pre_tool_use:0:0", "session_start:0:0"]).replaceAll(HOOKS_JSON, "/other/hooks.json");
  const r = musterHookTrustGaps({ configTomlText: foreign, hooksJsonPath: HOOKS_JSON, config: CONFIG, hookGroups: OWNED });
  assert.equal(r.untrusted.length, 2);
});

test("musterHookTrustGaps: owning no hook groups is vacuously fine", () => {
  const r = musterHookTrustGaps({ configTomlText: "", hooksJsonPath: HOOKS_JSON, config: { hooks: {} }, hookGroups: {} });
  assert.deepEqual(r, { owned: [], untrusted: [], trusted: [] });
});

test("musterHookTrustGaps: a co-located NON-muster hook shifts our index and we track the real one", () => {
  // A foreign group installed ahead of ours moves our PreToolUse group to index 1.
  const config = { hooks: { PreToolUse: [group("foreign"), group("a")] } };
  const owned = { PreToolUse: [group("a")] };
  const r = musterHookTrustGaps({ configTomlText: trustToml(["pre_tool_use:1:0"]), hooksJsonPath: HOOKS_JSON, config, hookGroups: owned });
  assert.deepEqual(r.owned, ["pre_tool_use:1:0"]);
  assert.deepEqual(r.untrusted, []);
});
