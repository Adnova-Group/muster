import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  classifyDestructive,
  readStore,
  addKey,
  permissionKey,
  resolvePermission,
  appendLedger,
} from "../plugin/hooks/permission-policy.js";

// Direct unit coverage for permission-policy.js.

function tmpFile() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "muster-pp-test-"));
  return { dir, file: path.join(dir, "store.json") };
}

// ── classifyDestructive — positives ─────────────────────────────────────────

test("classifyDestructive: rm -rf matches", () => {
  const r = classifyDestructive("Bash", "rm -rf /some/path");
  assert.ok(r !== null, "should match");
  assert.ok(r.length > 0);
});

test("classifyDestructive: rm -fr matches (flag order swapped)", () => {
  assert.ok(classifyDestructive("Bash", "rm -fr /some/path") !== null);
});

test("classifyDestructive: rm -r /path -f matches", () => {
  assert.ok(classifyDestructive("Bash", "rm -r /some/path -f") !== null);
});

test("classifyDestructive: git push --force matches", () => {
  assert.ok(classifyDestructive("Bash", "git push origin main --force") !== null);
});

test("classifyDestructive: git push -f matches", () => {
  assert.ok(classifyDestructive("Bash", "git push -f") !== null);
});

test("classifyDestructive: git push --force-with-lease matches", () => {
  assert.ok(classifyDestructive("Bash", "git push --force-with-lease") !== null);
});

test("classifyDestructive: git reset --hard matches", () => {
  assert.ok(classifyDestructive("Bash", "git reset --hard HEAD~1") !== null);
});

test("classifyDestructive: git clean -fd matches", () => {
  assert.ok(classifyDestructive("Bash", "git clean -fd") !== null);
});

test("classifyDestructive: git clean -fdx matches", () => {
  assert.ok(classifyDestructive("Bash", "git clean -fdx") !== null);
});

test("classifyDestructive: DROP TABLE matches (SQL)", () => {
  assert.ok(classifyDestructive("Bash", "psql -c 'DROP TABLE users'") !== null);
});

test("classifyDestructive: DROP DATABASE matches (SQL)", () => {
  assert.ok(classifyDestructive("Bash", "mysql -e 'DROP DATABASE mydb'") !== null);
});

test("classifyDestructive: TRUNCATE matches (SQL)", () => {
  assert.ok(classifyDestructive("Bash", "psql -c 'TRUNCATE orders'") !== null);
});

test("classifyDestructive: dd matches", () => {
  assert.ok(classifyDestructive("Bash", "dd if=/dev/zero of=/dev/sda") !== null);
});

test("classifyDestructive: mkfs matches", () => {
  assert.ok(classifyDestructive("Bash", "mkfs.ext4 /dev/sdb1") !== null);
});

// ── classifyDestructive — negatives ─────────────────────────────────────────

test("classifyDestructive: rm file.txt (no -r or -f) does not match", () => {
  assert.equal(classifyDestructive("Bash", "rm file.txt"), null);
});

test("classifyDestructive: ls -r does not match", () => {
  assert.equal(classifyDestructive("Bash", "ls -r /some/dir"), null);
});

test("classifyDestructive: git push (no force flag) does not match", () => {
  assert.equal(classifyDestructive("Bash", "git push origin main"), null);
});

test("classifyDestructive: git reset --soft does not match", () => {
  assert.equal(classifyDestructive("Bash", "git reset --soft HEAD~1"), null);
});

test("classifyDestructive: git clean without -f does not match", () => {
  assert.equal(classifyDestructive("Bash", "git clean -n"), null);
});

test("classifyDestructive: SELECT does not match", () => {
  assert.equal(classifyDestructive("Bash", "psql -c 'SELECT * FROM users'"), null);
});

test("classifyDestructive: rm -r without -f does not match", () => {
  assert.equal(classifyDestructive("Bash", "rm -r /some/path"), null);
});

test("classifyDestructive: null command returns null", () => {
  assert.equal(classifyDestructive("Bash", null), null);
  assert.equal(classifyDestructive("Bash", ""), null);
});

test("classifyDestructive: non-Bash tool with null command returns null", () => {
  assert.equal(classifyDestructive("Edit", null), null);
});

// ── permissionKey ────────────────────────────────────────────────────────────

test("permissionKey: Bash keys on full command string", () => {
  const k1 = permissionKey("Bash", { command: "echo hello" });
  const k2 = permissionKey("Bash", { command: "echo world" });
  assert.notEqual(k1, k2, "two distinct Bash commands must not collapse to the same key");
});

test("permissionKey: Bash key is stable across calls", () => {
  const k1 = permissionKey("Bash", { command: "npm test" });
  const k2 = permissionKey("Bash", { command: "npm test" });
  assert.equal(k1, k2);
});

test("permissionKey: editor tool keys on toolName:target", () => {
  const k = permissionKey("Edit", { target: "/src/foo.js" });
  assert.equal(k, "Edit:/src/foo.js");
});

test("permissionKey: Write tool keys on toolName:target", () => {
  const k = permissionKey("Write", { target: "/src/bar.js" });
  assert.equal(k, "Write:/src/bar.js");
});

test("permissionKey: two editor calls to different targets produce different keys", () => {
  const k1 = permissionKey("Edit", { target: "/src/a.js" });
  const k2 = permissionKey("Edit", { target: "/src/b.js" });
  assert.notEqual(k1, k2);
});

// ── resolvePermission ────────────────────────────────────────────────────────

test("resolvePermission: destructive command → prompt, reason set (overrides empty allowlists)", () => {
  const r = resolvePermission({
    toolName: "Bash",
    command: "rm -rf /build",
    target: null,
    runKeys: [],
    projectKeys: [],
  });
  assert.equal(r.decision, "prompt");
  assert.ok(typeof r.reason === "string" && r.reason.length > 0, "reason must be non-empty string");
});

test("resolvePermission: destructive command → prompt even when key is in runKeys (carve-out)", () => {
  // Build the key for the destructive command so we can inject it.
  const cmd = "rm -rf /tmp/build";
  const key = permissionKey("Bash", { command: cmd });
  const r = resolvePermission({
    toolName: "Bash",
    command: cmd,
    target: null,
    runKeys: [key],
    projectKeys: [],
  });
  assert.equal(r.decision, "prompt", "destructive must override runKeys allowlist");
  assert.ok(r.reason, "reason must be set for destructive override");
});

test("resolvePermission: destructive command → prompt even when key is in projectKeys (carve-out)", () => {
  const cmd = "git push --force";
  const key = permissionKey("Bash", { command: cmd });
  const r = resolvePermission({
    toolName: "Bash",
    command: cmd,
    target: null,
    runKeys: [],
    projectKeys: [key],
  });
  assert.equal(r.decision, "prompt", "destructive must override projectKeys allowlist");
  assert.ok(r.reason, "reason must be set for destructive override");
});

test("resolvePermission: key in runKeys → allow with scope=run", () => {
  const cmd = "npm test";
  const key = permissionKey("Bash", { command: cmd });
  const r = resolvePermission({
    toolName: "Bash",
    command: cmd,
    target: null,
    runKeys: [key],
    projectKeys: [],
  });
  assert.equal(r.decision, "allow");
  assert.equal(r.scope, "run");
});

test("resolvePermission: key in projectKeys → allow with scope=project", () => {
  const cmd = "npm run build";
  const key = permissionKey("Bash", { command: cmd });
  const r = resolvePermission({
    toolName: "Bash",
    command: cmd,
    target: null,
    runKeys: [],
    projectKeys: [key],
  });
  assert.equal(r.decision, "allow");
  assert.equal(r.scope, "project");
});

test("resolvePermission: key in both runKeys and projectKeys → scope=run (run takes precedence)", () => {
  const cmd = "npm ci";
  const key = permissionKey("Bash", { command: cmd });
  const r = resolvePermission({
    toolName: "Bash",
    command: cmd,
    target: null,
    runKeys: [key],
    projectKeys: [key],
  });
  assert.equal(r.decision, "allow");
  assert.equal(r.scope, "run");
});

test("resolvePermission: unknown command not in any allowlist → prompt", () => {
  const r = resolvePermission({
    toolName: "Bash",
    command: "some unknown command",
    target: null,
    runKeys: [],
    projectKeys: [],
  });
  assert.equal(r.decision, "prompt");
});

test("resolvePermission: editor tool key in runKeys → allow with scope=run", () => {
  const key = permissionKey("Edit", { target: "/src/index.js" });
  const r = resolvePermission({
    toolName: "Edit",
    command: null,
    target: "/src/index.js",
    runKeys: [key],
    projectKeys: [],
  });
  assert.equal(r.decision, "allow");
  assert.equal(r.scope, "run");
});

// ── readStore ────────────────────────────────────────────────────────────────

test("readStore: missing file → []", () => {
  const { dir, file } = tmpFile();
  try {
    assert.deepEqual(readStore(file), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readStore: corrupt JSON → []", () => {
  const { dir, file } = tmpFile();
  try {
    writeFileSync(file, "not-json{{{{");
    assert.deepEqual(readStore(file), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readStore: valid JSON but not an array → [] (e.g. {x:1})", () => {
  const { dir, file } = tmpFile();
  try {
    writeFileSync(file, JSON.stringify({ x: 1 }));
    assert.deepEqual(readStore(file), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readStore: filters non-string entries from array", () => {
  const { dir, file } = tmpFile();
  try {
    writeFileSync(file, JSON.stringify(["a", 42, null, "b", { x: 1 }, true]));
    assert.deepEqual(readStore(file), ["a", "b"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readStore: valid string array returned as-is", () => {
  const { dir, file } = tmpFile();
  try {
    writeFileSync(file, JSON.stringify(["key1", "key2", "key3"]));
    assert.deepEqual(readStore(file), ["key1", "key2", "key3"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── addKey ───────────────────────────────────────────────────────────────────

test("addKey: adds a key to an empty store", () => {
  const { dir, file } = tmpFile();
  try {
    addKey(file, "my-key");
    assert.deepEqual(readStore(file), ["my-key"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("addKey: idempotent — adding same key twice yields one entry", () => {
  const { dir, file } = tmpFile();
  try {
    addKey(file, "my-key");
    addKey(file, "my-key");
    assert.deepEqual(readStore(file), ["my-key"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("addKey: multiple distinct keys accumulate", () => {
  const { dir, file } = tmpFile();
  try {
    addKey(file, "key-a");
    addKey(file, "key-b");
    addKey(file, "key-c");
    const stored = readStore(file);
    assert.equal(stored.length, 3);
    assert.ok(stored.includes("key-a"));
    assert.ok(stored.includes("key-b"));
    assert.ok(stored.includes("key-c"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("addKey: never throws on a bad/unwritable path (best-effort)", () => {
  // Pass a path whose parent directory does not exist.
  assert.doesNotThrow(() => addKey("/nonexistent/deep/dir/store.json", "k"));
});

// ── appendLedger ─────────────────────────────────────────────────────────────

test("appendLedger: writes a parseable JSON line to the ledger file", () => {
  const { dir, file } = tmpFile();
  try {
    appendLedger(file, {
      toolName: "Bash",
      verdict: "allow",
      scope: "run",
      runId: "run-001",
      reason: undefined,
    });
    const content = readFileSync(file, "utf8").trim();
    const line = JSON.parse(content);
    assert.equal(line.toolName, "Bash");
    assert.equal(line.verdict, "allow");
    assert.equal(line.scope, "run");
    assert.equal(line.runId, "run-001");
    assert.ok(typeof line.ts === "string" && line.ts.length > 0, "ts field must be a non-empty ISO string");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("appendLedger: appends multiple lines (JSONL format)", () => {
  const { dir, file } = tmpFile();
  try {
    appendLedger(file, { toolName: "Bash", verdict: "prompt", scope: null, runId: "r1", reason: "rm -rf" });
    appendLedger(file, { toolName: "Edit", verdict: "allow", scope: "project", runId: "r1", reason: undefined });
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    assert.equal(first.toolName, "Bash");
    assert.equal(second.toolName, "Edit");
    assert.ok(first.ts, "first line must have ts");
    assert.ok(second.ts, "second line must have ts");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("appendLedger: never throws on a bad path (best-effort)", () => {
  assert.doesNotThrow(() =>
    appendLedger("/nonexistent/deep/dir/ledger.jsonl", {
      toolName: "Bash",
      verdict: "deny",
      scope: null,
      runId: "r-bad",
      reason: "test",
    }),
  );
});
