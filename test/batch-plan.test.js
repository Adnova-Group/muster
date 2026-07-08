import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBacklogRef, crossItemConflicts } from "../src/batch-plan.js";

// --- parseBacklogRef: the batch-ref grammar formerly documented in the pre-rename run.md, now in plan-backlog.md's B1 step --------------------------------
// Mirrors go-backlog.md step 1's three source forms (file / issues:<label> / linear:<key>),
// plus the "everything else is an outcome" default that keeps /muster:run's single-outcome
// path byte-identical for plain outcomes.

test("parseBacklogRef: .muster/backlog.md is a file ref", () => {
  assert.deepEqual(parseBacklogRef(".muster/backlog.md"), { kind: "file", path: ".muster/backlog.md" });
});

test("parseBacklogRef: any single whitespace-free .md token is a file ref", () => {
  assert.deepEqual(parseBacklogRef("docs/sprint-backlog.md"), { kind: "file", path: "docs/sprint-backlog.md" });
});

test("parseBacklogRef: surrounding whitespace is trimmed off a file ref", () => {
  assert.deepEqual(parseBacklogRef("  .muster/backlog.md  "), { kind: "file", path: ".muster/backlog.md" });
});

test("parseBacklogRef: issues:<label> is an issues ref, label verbatim", () => {
  assert.deepEqual(parseBacklogRef("issues:sprint-1"), { kind: "issues", label: "sprint-1" });
});

test("parseBacklogRef: linear:<key> is a linear ref, key verbatim", () => {
  assert.deepEqual(parseBacklogRef("linear:MUS"), { kind: "linear", key: "MUS" });
});

test("parseBacklogRef: issues: with an empty label is invalid, not a silent outcome", () => {
  const r = parseBacklogRef("issues:");
  assert.equal(r.kind, "invalid");
  assert.match(r.reason, /issues/);
});

test("parseBacklogRef: linear: with an empty key is invalid, not a silent outcome", () => {
  const r = parseBacklogRef("linear:  ");
  assert.equal(r.kind, "invalid");
  assert.match(r.reason, /linear/);
});

test("parseBacklogRef: a plain outcome is an outcome", () => {
  assert.deepEqual(parseBacklogRef("Add dark mode toggle to the settings page"), { kind: "outcome" });
});

test("parseBacklogRef: an outcome MENTIONING a .md file is still an outcome (whitespace present)", () => {
  assert.deepEqual(parseBacklogRef("Fix the broken links in README.md"), { kind: "outcome" });
});

test("parseBacklogRef: an issue ref stays an outcome here (run.md step 0 owns issue refs)", () => {
  assert.deepEqual(parseBacklogRef("#42"), { kind: "outcome" });
});

test("parseBacklogRef: empty and non-string inputs are outcomes (run.md's empty-guard fires first)", () => {
  assert.deepEqual(parseBacklogRef(""), { kind: "outcome" });
  assert.deepEqual(parseBacklogRef("   "), { kind: "outcome" });
  assert.deepEqual(parseBacklogRef(undefined), { kind: "outcome" });
});

// --- WIDEN decision: file kind accepts any readable-checklist-shaped extension, not
// just .md -- existence/readability stays the caller's job (sprint-waves), same as the
// pre-widen .md-only stance. ------------------------------------------------------------

test("parseBacklogRef: a non-.md extension (e.g. .txt) is still a file ref (WIDEN decision)", () => {
  assert.deepEqual(parseBacklogRef("TODO.txt"), { kind: "file", path: "TODO.txt" });
  assert.deepEqual(parseBacklogRef("docs/checklist.yaml"), { kind: "file", path: "docs/checklist.yaml" });
});

test("parseBacklogRef: case-insensitive -- ISSUES:/LINEAR: prefixes and any-case extensions all match", () => {
  assert.deepEqual(parseBacklogRef("ISSUES:sprint-1"), { kind: "issues", label: "sprint-1" });
  assert.deepEqual(parseBacklogRef("Issues:sprint-1"), { kind: "issues", label: "sprint-1" });
  assert.deepEqual(parseBacklogRef("LINEAR:MUS"), { kind: "linear", key: "MUS" });
  assert.deepEqual(parseBacklogRef(".muster/BACKLOG.MD"), { kind: "file", path: ".muster/BACKLOG.MD" });
  assert.deepEqual(parseBacklogRef("notes.TXT"), { kind: "file", path: "notes.TXT" });
});

// --- traversal-rejection: a ".." path segment in an otherwise file-shaped token must
// never resolve to kind:"file" -- downstream consumers (plan-backlog.md B1, go-backlog.md
// step 1) treat kind:"file" as a green light to read/run sprint-waves against `path`. ----

test("parseBacklogRef: a '..' segment in an otherwise file-shaped token is invalid, not a silent file ref", () => {
  const r = parseBacklogRef("../secrets.md");
  assert.equal(r.kind, "invalid");
  assert.match(r.reason, /\.\./);
});

test("parseBacklogRef: a '..' segment buried mid-path is also invalid", () => {
  const r = parseBacklogRef("docs/../../etc/passwd.md");
  assert.equal(r.kind, "invalid");
});

test("parseBacklogRef: a literal '..' substring in a filename (not a traversal segment) still trips the guard", () => {
  // "notes..txt" has a literal ".." substring in the filename itself, not a directory
  // traversal segment -- still flagged invalid under the memory.js-style substring guard
  // (mirrors writeMemory's slug check exactly), which deliberately trades a rare false
  // positive for a simple, auditable check over a segment-aware parser.
  const r = parseBacklogRef("notes..txt");
  assert.equal(r.kind, "invalid");
});

test("parseBacklogRef: an ordinary single-dot extension token is unaffected by the traversal guard", () => {
  assert.deepEqual(parseBacklogRef("notes.txt"), { kind: "file", path: "notes.txt" });
});

// --- absolute-path rejection: an absolute file-shaped token must never resolve to
// kind:"file" either -- sprint-waves.js's caller (go-backlog.md step 1 / plan-backlog.md
// B1) treats kind:"file" as a green light to read `path` directly, and an absolute path
// (unlike a relative "../" segment) needs no traversal at all to reach outside the
// project: it names an out-of-project file outright. Mirrors the ".." guard immediately
// above; isAbsolute is node:path's own platform-aware check (POSIX-absolute or a Windows
// drive-letter/UNC path), not a hand-rolled leading-slash test.

test("parseBacklogRef: an absolute .md path is invalid, not a silent file ref", () => {
  const r = parseBacklogRef("/etc/passwd.md");
  assert.equal(r.kind, "invalid");
  assert.match(r.reason, /absolute/);
});

test("parseBacklogRef: an absolute path is rejected even with no '..' segment present", () => {
  const r = parseBacklogRef("/tmp/backlog.md");
  assert.equal(r.kind, "invalid");
});

test("parseBacklogRef: surrounding whitespace does not hide an absolute path from the guard", () => {
  const r = parseBacklogRef("  /tmp/backlog.md  ");
  assert.equal(r.kind, "invalid");
});

// --- cross-platform absolute-path rejection: node:path's isAbsolute is platform-dynamic
// -- on a POSIX runtime it returns false for a Windows drive-letter path ("C:\x"), a
// Windows UNC path ("\\server\x"), or a Windows-rooted path with a single leading
// backslash ("\x" -- path.win32.isAbsolute treats this as absolute too, not just the
// double-backslash UNC form), so a Windows-absolute token would otherwise slip through
// this guard as merely "relative" (kind:"file") when run on a POSIX host, even though the
// exact same batch plan run on Windows would reject it via isAbsolute. Explicit drive-letter
// (/^[A-Za-z]:[\\/]/) and backslash-rooted (/^\\/, which also covers the double-backslash
// UNC form) checks alongside isAbsolute make the guard's verdict platform-independent
// instead of platform-dynamic.

test("parseBacklogRef: a Windows drive-letter path (C:\\x.md) is invalid, same as a POSIX absolute path", () => {
  const r = parseBacklogRef("C:\\x.md");
  assert.equal(r.kind, "invalid");
  assert.match(r.reason, /absolute/);
});

test("parseBacklogRef: a Windows UNC path (\\\\server\\x.md) is invalid, same as a POSIX absolute path", () => {
  const r = parseBacklogRef("\\\\server\\x.md");
  assert.equal(r.kind, "invalid");
  assert.match(r.reason, /absolute/);
});

test("parseBacklogRef: a single-leading-backslash Windows-rooted path (\\x.md) is invalid too, not just the double-backslash UNC form", () => {
  const r = parseBacklogRef("\\x.md");
  assert.equal(r.kind, "invalid");
  assert.match(r.reason, /absolute/);
});

test("parseBacklogRef: a bare version/decimal token is classified as a file ref -- accepted, documented tradeoff of the widened FILE_TOKEN_RE", () => {
  // "3.14" and "v2.0" are whitespace-free tokens ending in a dot-suffix, so they satisfy
  // the same shape test a real filename would. Excluding numeric-looking extensions would
  // need content/allowlist logic this pure, IO-free function deliberately doesn't have --
  // pinned here as a known characteristic, not a regression.
  assert.deepEqual(parseBacklogRef("3.14"), { kind: "file", path: "3.14" });
  assert.deepEqual(parseBacklogRef("v2.0"), { kind: "file", path: "v2.0" });
});

// --- crossItemConflicts: the batch plan's advisory cross-item file-conflict flags --------
// Deliberately ADVISORY, never a gate: manifest fences stay opaque path labels
// (validateManifest does no glob matching; disjointness stays orchestrator judgment).
// This function only surfaces prefix-shaped overlaps for the human to weigh at the
// batch-plan approval stop.

test("crossItemConflicts: identical owns labels across two items are flagged", () => {
  const r = crossItemConflicts([
    { id: "a", owns: ["src/auth/**"] },
    { id: "b", owns: ["src/auth/**"] },
  ]);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].a, "a");
  assert.equal(r.conflicts[0].b, "b");
  assert.deepEqual(r.unfenced, []);
});

test("crossItemConflicts: a glob prefix covering another item's file is flagged", () => {
  const r = crossItemConflicts([
    { id: "auth", owns: ["src/auth/**", "test/auth/**"] },
    { id: "sessions", owns: ["src/auth/session.js"] },
    { id: "docs", owns: ["docs/**"] },
  ]);
  assert.equal(r.conflicts.length, 1);
  assert.deepEqual([r.conflicts[0].a, r.conflicts[0].b], ["auth", "sessions"]);
  assert.ok(r.conflicts[0].overlaps.length >= 1);
});

test("crossItemConflicts: disjoint trees produce no flags", () => {
  const r = crossItemConflicts([
    { id: "retry", owns: ["src/fetch/retry.js"] },
    { id: "logging", owns: ["src/logging/**"] },
  ]);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.unfenced, []);
});

test("crossItemConflicts: a sibling name that merely shares a string prefix is NOT flagged", () => {
  // 'src/auth' vs 'src/auth-tokens' share a string prefix but not a path boundary.
  const r = crossItemConflicts([
    { id: "a", owns: ["src/auth/**"] },
    { id: "b", owns: ["src/auth-tokens/**"] },
  ]);
  assert.deepEqual(r.conflicts, []);
});

test("crossItemConflicts: an item with no owns is reported unfenced, never flagged", () => {
  const r = crossItemConflicts([
    { id: "retry", owns: ["src/fetch/**"] },
    { id: "metrics", owns: [] },
    { id: "docs" },
  ]);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.unfenced, ["metrics", "docs"]);
});

test("crossItemConflicts: a bare '**' owns everything and conflicts with any fenced item", () => {
  const r = crossItemConflicts([
    { id: "sweep", owns: ["**"] },
    { id: "docs", owns: ["docs/**"] },
  ]);
  assert.equal(r.conflicts.length, 1);
  assert.deepEqual([r.conflicts[0].a, r.conflicts[0].b], ["sweep", "docs"]);
});

test("crossItemConflicts: pair order follows input order and each pair appears once", () => {
  const r = crossItemConflicts([
    { id: "one", owns: ["shared/**"] },
    { id: "two", owns: ["shared/a.js"] },
    { id: "three", owns: ["shared/b.js"] },
  ]);
  assert.deepEqual(
    r.conflicts.map((c) => [c.a, c.b]),
    [["one", "two"], ["one", "three"]]
  );
});

test("crossItemConflicts: non-array input degrades to empty results, never throws", () => {
  assert.deepEqual(crossItemConflicts(undefined), { conflicts: [], unfenced: [] });
  assert.deepEqual(crossItemConflicts("nope"), { conflicts: [], unfenced: [] });
});

// --- backslash-fence-overlap: normalizeFenceLabel must strip a glob segment wherever it
// falls in the path (not just a trailing one), on backslash-separated (Windows-style)
// labels as well as forward-slash ones -- the pre-fix version only stripped a *trailing*
// glob, so a mid-path glob on a backslash label silently escaped normalization and a real
// overlap went unflagged. ------------------------------------------------------------

test("crossItemConflicts: a mid-path glob on a backslash-separated label is normalized and flagged (previously a false negative)", () => {
  const r = crossItemConflicts([
    { id: "wildcard", owns: ["src\\auth\\*\\session.js"] },
    { id: "literal", owns: ["src\\auth\\session.js"] },
  ]);
  assert.equal(r.conflicts.length, 1, `expected an overlap flag; got ${JSON.stringify(r)}`);
  assert.deepEqual([r.conflicts[0].a, r.conflicts[0].b], ["wildcard", "literal"]);
});

test("crossItemConflicts: forward-slash mid-path glob normalizes the same way as the backslash form", () => {
  const r = crossItemConflicts([
    { id: "wildcard", owns: ["src/auth/*/session.js"] },
    { id: "literal", owns: ["src/auth/session.js"] },
  ]);
  assert.equal(r.conflicts.length, 1);
});
