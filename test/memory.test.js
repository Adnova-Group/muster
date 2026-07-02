import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { writeMemory, readMemory, appendState, appendFollowup } from "../src/memory.js";

// Pull the YAML frontmatter block (between the first two `---` fences) out of a
// memory doc and parse it, so a test can assert on the *parsed* key set rather
// than on raw text — the only way to prove an injected key did not materialize.
function frontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, "doc must open with a YAML frontmatter fence");
  return parseYaml(m[1]);
}

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

test("writeMemory cannot be tricked into forging frontmatter keys via a newline in title", async () => {
  const d = await dir();
  // A title carrying a newline + a fake key is the injection: with raw string
  // interpolation this would close the value and inject `malicious: true` as a
  // real frontmatter key. Built through yaml.stringify it must stay a quoted
  // scalar of `title`, never a key of its own.
  const entry = { slug: "inject", title: "Pwned\n---\nmalicious: true",
    outcome: "O", body: "B" };
  await writeMemory(d, entry);
  const md = await readFile(join(d, "inject.md"), "utf8");
  const fm = frontmatter(md);
  assert.equal("malicious" in fm, false, "injected key must NOT appear in parsed frontmatter");
  assert.equal(fm.title, "Pwned\n---\nmalicious: true", "title round-trips intact as a scalar");
  assert.equal(fm.outcome, "O");
});

test("writeMemory output stays readable for a normal entry (round-trips via yaml)", async () => {
  const d = await dir();
  const entry = { slug: "normal", title: "Rate limit run",
    outcome: "Add rate limiting", body: "Chose token bucket.", links: ["express-notes", "redis"] };
  await writeMemory(d, entry);
  const md = await readFile(join(d, "normal.md"), "utf8");
  const fm = frontmatter(md);
  assert.equal(fm.title, "Rate limit run");
  assert.equal(fm.outcome, "Add rate limiting");
  assert.match(md, /Chose token bucket/);
  assert.match(md, /\[\[express-notes\]\] \[\[redis\]\]/);
});

test("writeMemory rejects a [[link]] value carrying a newline or closing brackets", async () => {
  const d = await dir();
  // A link value that contains `]]` or a newline could break out of the link
  // line / inject markup. It must be rejected, not silently emitted.
  await assert.rejects(
    () => writeMemory(d, { slug: "badlink", title: "T", outcome: "O", body: "B", links: ["ok]] evil"] }),
    /invalid link/,
    "a link containing ]] must throw");
  await assert.rejects(
    () => writeMemory(d, { slug: "badlink2", title: "T", outcome: "O", body: "B", links: ["line1\nline2"] }),
    /invalid link/,
    "a link containing a newline must throw");
});

test("writeMemory INDEX.md dedups a repeated slug but appends a distinct one", async () => {
  const d = await dir();
  await writeMemory(d, { slug: "dup", title: "First", outcome: "O1", body: "B" });
  // Re-writing the SAME slug must not append a second index line for it.
  await writeMemory(d, { slug: "dup", title: "Second", outcome: "O2", body: "B" });
  let index = await readFile(join(d, "INDEX.md"), "utf8");
  const dupLines = index.split("\n").filter(l => l.includes("dup.md"));
  assert.equal(dupLines.length, 1, `exactly one index line for dup.md, got: ${JSON.stringify(dupLines)}`);
  // A distinct slug appends a second line.
  await writeMemory(d, { slug: "other", title: "Other", outcome: "O3", body: "B" });
  index = await readFile(join(d, "INDEX.md"), "utf8");
  assert.equal(index.split("\n").filter(l => l.includes("dup.md")).length, 1, "dup.md still single");
  assert.equal(index.split("\n").filter(l => l.includes("other.md")).length, 1, "other.md appended once");
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

// ── A-SEC7: appendState / appendFollowup runId path-traversal guard ───────────
// appendState and appendFollowup join runId directly into a path. A traversal
// runId like "../escape" would write STATE/followup files outside the named dir.
// The guard (mirroring initScratchpad's runId check) must reject before any
// mkdir or appendFile runs.

test("A-SEC7: appendState rejects a runId with .. (path traversal)", async () => {
  const d = await dir();
  await assert.rejects(
    () => appendState(d, "../escape", "some state line"),
    /invalid runId/,
    "appendState must throw on traversal runId",
  );
});

test("A-SEC7: appendState rejects a runId with / separator", async () => {
  const d = await dir();
  await assert.rejects(
    () => appendState(d, "a/b", "some state line"),
    /invalid runId/,
    "appendState must throw on runId containing /",
  );
});

test("A-SEC7: appendState rejects a runId with \\ separator", async () => {
  const d = await dir();
  await assert.rejects(
    () => appendState(d, "a\\b", "some state line"),
    /invalid runId/,
    "appendState must throw on runId containing \\",
  );
});

test("A-SEC7: appendFollowup rejects a runId with .. (path traversal)", async () => {
  const d = await dir();
  await assert.rejects(
    () => appendFollowup(d, "../escape", { severity: "P1", note: "test" }),
    /invalid runId/,
    "appendFollowup must throw on traversal runId",
  );
});

test("A-SEC7: appendFollowup rejects a runId with / separator", async () => {
  const d = await dir();
  await assert.rejects(
    () => appendFollowup(d, "a/b", { severity: "P1", note: "test" }),
    /invalid runId/,
    "appendFollowup must throw on runId containing /",
  );
});

test("A-SEC7: appendState accepts a valid runId and writes correctly", async () => {
  const d = await dir();
  await appendState(d, "run-001", "checkpoint reached");
  const content = await readFile(join(d, "run-001.state.md"), "utf8");
  assert.match(content, /checkpoint reached/, "appendState must write the line");
});

test("A-SEC7: appendFollowup accepts a valid runId and writes correctly", async () => {
  const d = await dir();
  await appendFollowup(d, "run-002", { severity: "P2", note: "needs review" });
  const content = await readFile(join(d, "run-002.followups.md"), "utf8");
  assert.match(content, /needs review/, "appendFollowup must write the finding");
});
