import { test } from "node:test";
import assert from "node:assert/strict";
import { isInstalled } from "../src/installed.js";

// ---------------------------------------------------------------------------
// isInstalled unit tests
// ---------------------------------------------------------------------------

// Entries with no detect field must return false without throwing.
test("isInstalled: entry with no detect field returns false", () => {
  const entry = { id: "no-detect", kind: "external", roles: ["implement"] };
  assert.equal(isInstalled(entry, { plugins: [], skills: [], mcpServers: [], agents: [] }), false);
});

// Entries where detect exists but detect.match is absent must return false.
test("isInstalled: entry with detect but no detect.match returns false", () => {
  const entry = { id: "no-match", kind: "external", roles: ["implement"], detect: { kind: "mcp_server" } };
  assert.equal(isInstalled(entry, { plugins: [], skills: [], mcpServers: [], agents: [] }), false);
});

// Non-external entries must return false regardless of detect.
test("isInstalled: builtin kind always returns false", () => {
  const entry = { id: "builtin-x", kind: "builtin", roles: ["implement"], detect: { kind: "mcp_server", match: "builtin-x" } };
  assert.equal(isInstalled(entry, { plugins: ["builtin-x"], skills: ["builtin-x"], mcpServers: ["builtin-x"], agents: ["builtin-x"] }), false);
});

test("isInstalled: agent kind always returns false (only external resolves via installed)", () => {
  const entry = { id: "agent-x", kind: "agent", roles: ["implement"], detect: { kind: "agent", match: "agent-x" } };
  assert.equal(isInstalled(entry, { plugins: [], skills: [], mcpServers: [], agents: ["agent-x"] }), false);
});

// Match against plugins array.
test("isInstalled: external matches via installed.plugins", () => {
  const entry = { id: "my-plugin", kind: "external", detect: { kind: "plugin", match: "my-plugin" } };
  assert.equal(isInstalled(entry, { plugins: ["my-plugin"], skills: [], mcpServers: [], agents: [] }), true);
});

// Match against mcpServers array.
test("isInstalled: external matches via installed.mcpServers", () => {
  const entry = { id: "serena", kind: "external", detect: { kind: "mcp_server", match: "serena" } };
  assert.equal(isInstalled(entry, { plugins: [], skills: [], mcpServers: ["serena"], agents: [] }), true);
});

// Match against agents array.
test("isInstalled: external matches via installed.agents", () => {
  const entry = { id: "ext-agent", kind: "external", detect: { kind: "agent", match: "ext-agent" } };
  assert.equal(isInstalled(entry, { plugins: [], skills: [], mcpServers: [], agents: ["ext-agent"] }), true);
});

// Match against skills array.
test("isInstalled: external matches via installed.skills", () => {
  const entry = { id: "my-skill", kind: "external", detect: { kind: "skill", match: "my-skill" } };
  assert.equal(isInstalled(entry, { plugins: [], skills: ["my-skill"], mcpServers: [], agents: [] }), true);
});

// Partial installed shape (missing arrays) must not throw.
test("isInstalled: partial installed shape (no mcpServers array) does not throw", () => {
  const entry = { id: "x", kind: "external", detect: { match: "x" } };
  assert.doesNotThrow(() => isInstalled(entry, { plugins: ["x"] }));
  assert.equal(isInstalled(entry, { plugins: ["x"] }), true);
});

test("isInstalled: completely empty installed object does not throw", () => {
  const entry = { id: "x", kind: "external", detect: { match: "x" } };
  assert.doesNotThrow(() => isInstalled(entry, {}));
  assert.equal(isInstalled(entry, {}), false);
});

test("isInstalled: undefined installed arrays (partial shape) do not throw", () => {
  const entry = { id: "x", kind: "external", detect: { match: "x" } };
  // partial shape: only plugins present, others undefined — guarded by (... || [])
  assert.doesNotThrow(() => isInstalled(entry, { plugins: undefined, skills: undefined, mcpServers: undefined, agents: undefined }));
  assert.equal(isInstalled(entry, { plugins: undefined }), false);
});

// Not-found cases.
test("isInstalled: returns false when match is not in any installed list", () => {
  const entry = { id: "absent", kind: "external", detect: { match: "absent" } };
  assert.equal(isInstalled(entry, { plugins: ["other"], skills: ["other2"], mcpServers: ["other3"], agents: ["other4"] }), false);
});
