import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMemory, readMemory } from "../src/memory.js";

async function dir() { return mkdtemp(join(tmpdir(), "muster-mem-")); }

async function fileExists(p) {
  try { await readFile(p, "utf8"); return true; } catch { return false; }
}

test("writeMemory rejects a slug with path traversal and writes nothing outside dir", async () => {
  const d = await dir();
  // A "../escape" slug would resolve to a sibling of the memory dir — a write
  // primitive that escapes the named store. Must be rejected before any write.
  await assert.rejects(
    () => writeMemory(d, { slug: "../escape", title: "T", outcome: "O", body: "B" }),
    /invalid slug "\.\.\/escape" \(no path separators or \.\.\)/,
    "a slug containing .. or a separator must throw");
  // Prove nothing leaked to the parent of the memory dir.
  assert.equal(await fileExists(join(d, "..", "escape.md")), false,
    "no file may be written outside the target dir");
});

test("writeMemory rejects entries missing required fields and writes nothing", async () => {
  const d = await dir();
  await assert.rejects(
    () => writeMemory(d, { title: "T", outcome: "O", body: "B" }),
    /missing required field "slug"/,
    "a missing slug must throw, not write undefined.md");
  await assert.rejects(
    () => writeMemory(d, { slug: "s", title: "T", outcome: "O" }),
    /missing required field "body"/,
    "a missing body must throw, not interpolate the literal 'undefined'");
  // No undefined.md leaked from the missing-slug case.
  assert.equal(await fileExists(join(d, "undefined.md")), false,
    "no undefined.md may be written");
});

test("writeMemory creates a markdown entry and an INDEX line", async () => {
  const d = await dir();
  const entry = { slug: "rate-limit-run", title: "Rate limit run",
    outcome: "Add rate limiting", body: "Chose token bucket.", links: ["express-notes"] };
  await writeMemory(d, entry);
  const md = await readFile(join(d, "rate-limit-run.md"), "utf8");
  assert.match(md, /title: Rate limit run/);
  assert.match(md, /Chose token bucket/);
  assert.match(md, /\[\[express-notes\]\]/);
  const index = await readFile(join(d, "INDEX.md"), "utf8");
  assert.match(index, /rate-limit-run\.md/);
});

test("readMemory returns entries matching a query substring", async () => {
  const d = await dir();
  await writeMemory(d, { slug: "a", title: "Auth refactor", outcome: "auth", body: "x" });
  await writeMemory(d, { slug: "b", title: "Billing", outcome: "billing", body: "y" });
  const hits = await readMemory(d, "auth");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].slug, "a");
});

test("readMemory on empty dir returns []", async () => {
  assert.deepEqual(await readMemory(await dir(), "anything"), []);
});

test("readMemory on a missing dir returns [] (ENOENT -> absent, no throw)", async () => {
  const missing = join(await dir(), "does", "not", "exist");
  assert.deepEqual(await readMemory(missing, "anything"), []);
});
