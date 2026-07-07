/**
 * detectScope: deterministic backlog-vs-item scope detection for the plan/go verb family.
 *
 * Only DETERMINISTIC signals live here (a parseable backlog ref, an existing file that
 * looks like a backlog checklist, or a live default .muster/backlog.md on a bare
 * invocation). Judgment about multi-deliverable intent from prose stays in mode prompts,
 * never in this module.
 *
 * Unit tests exercise detectScope() directly against temp-dir fixtures; the trailing
 * "cli wire" block spawns `node src/cli.js scope` to pin the verb's JSON contract, mirroring
 * test/cli-wire.test.js's execFile pattern.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, chmod, readFile as readFileFs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { detectScope } from "../src/scope.js";

const pexecFile = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CLI = join(REPO_ROOT, "src/cli.js");

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "muster-scope-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- cwd robustness: a non-string/empty cwd must degrade, never throw -----------------

test("detectScope: a non-string cwd (e.g. a number) falls back instead of throwing a TypeError", async () => {
  await assert.doesNotReject(() => detectScope({ cwd: 12345, text: "add dark mode" }));
  const r = await detectScope({ cwd: 12345, text: "add dark mode" });
  assert.equal(r.scope, "item");
});

test("detectScope: an empty-string cwd falls back instead of throwing", async () => {
  await assert.doesNotReject(() => detectScope({ cwd: "", text: "add dark mode" }));
  const r = await detectScope({ cwd: "", text: "" });
  // Falls back to process.cwd() -- must still resolve to a valid scope, not throw.
  assert.ok(["backlog", "item", "ambiguous"].includes(r.scope));
});

test("detectScope: a null cwd falls back instead of throwing", async () => {
  await assert.doesNotReject(() => detectScope({ cwd: null, text: "add dark mode" }));
});

// --- rule 1: text parses as a backlog ref (reuses batch-plan.js's parseBacklogRef) -----

test("detectScope: a whitespace-free .md token is a backlog file ref -> backlog", async () => {
  const r = await withTempDir(async (dir) =>
    detectScope({ cwd: dir, text: ".muster/backlog.md" })
  );
  assert.equal(r.scope, "backlog");
  assert.ok(r.signals.some((s) => s.includes(".muster/backlog.md")), `signals: ${JSON.stringify(r.signals)}`);
});

test("detectScope: an issues:<label> ref -> backlog", async () => {
  const r = await withTempDir(async (dir) => detectScope({ cwd: dir, text: "issues:sprint-1" }));
  assert.equal(r.scope, "backlog");
  assert.ok(r.signals.some((s) => s.includes("issues:sprint-1")), `signals: ${JSON.stringify(r.signals)}`);
});

test("detectScope: a linear:<key> ref -> backlog", async () => {
  const r = await withTempDir(async (dir) => detectScope({ cwd: dir, text: "linear:MUS" }));
  assert.equal(r.scope, "backlog");
  assert.ok(r.signals.some((s) => s.includes("linear:MUS")), `signals: ${JSON.stringify(r.signals)}`);
});

// --- rule 2: text names an existing readable file whose content looks like a backlog ---

test("detectScope: an existing file (no .md ext) with '- [ ]' items -> backlog", async () => {
  const r = await withTempDir(async (dir) => {
    await writeFile(join(dir, "TODO"), "# stuff\n- [ ] first item\n- [x] done item\n");
    return detectScope({ cwd: dir, text: "TODO" });
  });
  assert.equal(r.scope, "backlog");
  assert.ok(r.signals.some((s) => s.includes("TODO")), `signals: ${JSON.stringify(r.signals)}`);
});

test("detectScope: an existing file with no checklist items is NOT a backlog -> item", async () => {
  const r = await withTempDir(async (dir) => {
    await writeFile(join(dir, "notes.txt"), "just some prose, no checklist here\n");
    return detectScope({ cwd: dir, text: "notes.txt" });
  });
  assert.equal(r.scope, "item");
});

test("detectScope: a named file that does not exist -> item (not a crash)", async () => {
  const r = await withTempDir(async (dir) => detectScope({ cwd: dir, text: "does-not-exist.txt" }));
  assert.equal(r.scope, "item");
});

// Degrade paths the module comment claims but were previously untested: naming a
// directory (EISDIR) and naming an unreadable file (EACCES) must both fall through
// to readBacklogCandidate's catch-all "no" answer, not throw.

test("detectScope: text names a directory, not a file -> item, no throw (EISDIR degrades gracefully)", async () => {
  const r = await withTempDir(async (dir) => {
    await mkdir(join(dir, "just-a-dir"));
    return detectScope({ cwd: dir, text: "just-a-dir" });
  });
  assert.equal(r.scope, "item");
});

test("detectScope: an unreadable (chmod 000) file candidate -> item, no throw (EACCES degrades gracefully)", async (t) => {
  await withTempDir(async (dir) => {
    // Deliberately no .md extension: a bare ".md" token would satisfy rule 1
    // (parseable-ref, existence not required) regardless of readability, which would
    // mask the rule-2 EACCES degrade path this test targets.
    const filePath = join(dir, "locked");
    await writeFile(filePath, "- [ ] hidden item\n");
    await chmod(filePath, 0o000);
    try {
      // Writability probe: some platforms/users (root, some CI containers, some
      // filesystems) make chmod a no-op for the owner. If we can still read the
      // file back, this test's premise doesn't hold here -- skip rather than
      // assert something the platform can't actually exercise.
      let stillReadable = true;
      try {
        await readFileFs(filePath, "utf8");
      } catch {
        stillReadable = false;
      }
      if (stillReadable) {
        t.skip("chmod 000 did not restrict read access on this platform/user — EACCES degrade path not exercised");
        return;
      }
      const r = await detectScope({ cwd: dir, text: "locked" });
      assert.equal(r.scope, "item");
    } finally {
      await chmod(filePath, 0o644).catch(() => {});
    }
  });
});

// --- rule 3: bare invocation with a live default .muster/backlog.md --------------------

test("detectScope: empty text + live .muster/backlog.md (>=1 unchecked) -> backlog", async () => {
  const r = await withTempDir(async (dir) => {
    await mkdir(join(dir, ".muster"), { recursive: true });
    await writeFile(join(dir, ".muster", "backlog.md"), "# backlog\n- [ ] ship the thing\n");
    return detectScope({ cwd: dir, text: "" });
  });
  assert.equal(r.scope, "backlog");
  assert.ok(r.signals.some((s) => s.includes("backlog.md")), `signals: ${JSON.stringify(r.signals)}`);
});

test("detectScope: whitespace-only text behaves like empty text (live backlog present)", async () => {
  const r = await withTempDir(async (dir) => {
    await mkdir(join(dir, ".muster"), { recursive: true });
    await writeFile(join(dir, ".muster", "backlog.md"), "- [ ] ship the thing\n");
    return detectScope({ cwd: dir, text: "   \n  " });
  });
  assert.equal(r.scope, "backlog");
});

test("detectScope: empty text + backlog.md present but fully checked -> ambiguous, not backlog", async () => {
  const r = await withTempDir(async (dir) => {
    await mkdir(join(dir, ".muster"), { recursive: true });
    await writeFile(join(dir, ".muster", "backlog.md"), "- [x] already done\n");
    return detectScope({ cwd: dir, text: "" });
  });
  assert.equal(r.scope, "ambiguous");
});

test("detectScope: empty text + no .muster/backlog.md at all -> ambiguous", async () => {
  const r = await withTempDir(async (dir) => detectScope({ cwd: dir, text: "" }));
  assert.equal(r.scope, "ambiguous");
  assert.ok(r.signals.length > 0, "ambiguous still carries a human-readable signal");
});

// --- rule 4: a non-empty outcome sentence with none of the above -> item ---------------

test("detectScope: a plain outcome sentence -> item", async () => {
  const r = await withTempDir(async (dir) => detectScope({ cwd: dir, text: "Add dark mode toggle to settings" }));
  assert.equal(r.scope, "item");
  assert.ok(r.signals.length > 0, "item still carries a human-readable signal");
});

test("detectScope: an invalid issues: ref (empty label) is not a parseable backlog ref -> item, with a distinct malformed-ref signal", async () => {
  // parseBacklogRef("issues:") returns kind:"invalid", not one of file/issues/linear — a
  // malformed ref is deliberately NOT auto-classified as backlog here; mode-level
  // validation of the ref itself is a downstream concern, not this pure detector's job.
  // The boundary decision (item) holds, but the signal must say so distinctly instead of
  // reusing the generic "reads as an outcome" wording — a typo'd ref should not silently
  // look identical to a genuine outcome sentence.
  const r = await withTempDir(async (dir) => detectScope({ cwd: dir, text: "issues:" }));
  assert.equal(r.scope, "item");
  assert.deepEqual(r.signals, [
    '"issues:" looks like a malformed backlog reference — treating as an outcome; check the ref syntax if you meant a backlog',
  ]);
});

test("detectScope: an invalid linear: ref (empty key) -> item, with the same distinct malformed-ref signal shape", async () => {
  const r = await withTempDir(async (dir) => detectScope({ cwd: dir, text: "linear:" }));
  assert.equal(r.scope, "item");
  assert.equal(r.signals.length, 1);
  assert.ok(r.signals[0].includes("malformed backlog reference"), `signals: ${JSON.stringify(r.signals)}`);
  assert.notEqual(
    r.signals[0],
    '"linear:" reads as an outcome, not a backlog ref',
    "malformed-ref signal must not collapse to the generic outcome-sentence wording"
  );
});

// --- signal sanitization: raw user text must never interpolate unbounded/unescaped ----

test("detectScope: a huge, newline-and-quote-laden outcome text collapses to a short bounded signal", async () => {
  const unit = 'He said "hello"\n\n   multiple   spaces   here\n';
  const huge = unit.repeat(Math.ceil(200_000 / unit.length)); // > 200KB
  assert.ok(huge.length > 200_000, "fixture must exceed 200KB to match the reviewed scenario");

  const r = await withTempDir(async (dir) => detectScope({ cwd: dir, text: huge }));
  assert.equal(r.scope, "item");
  assert.equal(r.signals.length, 1);
  const [signal] = r.signals;
  assert.ok(signal.length < 120, `signal must be bounded (~120 chars); got ${signal.length}: ${signal}`);
  assert.ok(!/\n/.test(signal), "signal must not contain raw newlines");
  assert.ok(!/ {2,}/.test(signal), "signal must not contain collapsed multi-space runs");
});

test("detectScope: a backlog-file ref whose label/path portion is huge still yields a bounded signal", async () => {
  const hugeLabel = "x".repeat(200_000);
  const r = await withTempDir(async (dir) => detectScope({ cwd: dir, text: `issues:${hugeLabel}` }));
  assert.equal(r.scope, "backlog");
  assert.equal(r.signals.length, 1);
  // The quoted excerpt itself must be capped (80 chars + a 1-char ellipsis); the fixed
  // "issues:" prefix and trailing prose add a small, constant amount on top of that, so
  // the bound here is generous relative to the original 200,000-char input, not a tight
  // ~120 (that tighter bound is what the huge-outcome-text case above pins).
  assert.ok(r.signals[0].length < 200, `signal must be bounded; got ${r.signals[0].length}`);
  assert.ok(r.signals[0].includes("…"), "long label must be truncated with an ellipsis");
});

// --- cli wire: `muster scope <text>` -----------------------------------------------------

function run(args, cwd) {
  return pexecFile(process.execPath, [CLI, ...args], { cwd });
}

test("cli wire: scope on a named backlog file ref returns {scope:'backlog', signals}", async () => {
  const { stdout } = await run(["scope", ".muster/backlog.md"], REPO_ROOT);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.scope, "backlog");
  assert.ok(Array.isArray(parsed.signals) && parsed.signals.length > 0);
});

test("cli wire: scope on a plain outcome sentence returns {scope:'item', ...}", async () => {
  const { stdout } = await run(["scope", "add dark mode"], REPO_ROOT);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.scope, "item");
});

test("cli wire: bare scope invocation in a dir with a live backlog returns {scope:'backlog', ...}", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, ".muster"), { recursive: true });
    await writeFile(join(dir, ".muster", "backlog.md"), "- [ ] ship the thing\n");
    const { stdout } = await run(["scope", ""], dir);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.scope, "backlog");
  });
});
