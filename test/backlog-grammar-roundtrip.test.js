// test/backlog-grammar-roundtrip.test.js — round-trip check tying src/scope.js's widened
// detectScope contract (the authority for what counts as a backlog checklist file, any
// extension or none, per the scope-batch-harden widen) to the two backlog CONSUMERS that
// must stay in lockstep with it: plugin/commands/go-backlog.md step 1 and
// plugin/commands/plan-backlog.md B1. Both consumer files are prose, not code, so
// "consumable by the documented resolution" is checked two ways:
//
//   1. functionally -- for each representative scope:"backlog" verdict, the SAME
//      deterministic primitives both consumer bullets now cite (parseBacklogRef's
//      file-ref shape, or an existing readable file with checklist content) resolve it,
//      i.e. a consumer implementing the documented grammar has no dead end (go-backlog)
//      and no raw-intent misroute (plan-backlog);
//   2. textually -- neither file's grammar prose still hard-codes the pre-widen literal
//      ".muster/backlog.md"-only / ".md"-only shape that would reintroduce that dead end
//      or misroute even if the underlying primitives stay correct.
//
// Pre-fix, this would have failed two ways: go-backlog.md step 1 recognized ONLY the
// literal ".muster/backlog.md" token as a file ref (a differently-named or extensionless
// checklist had no matching bullet at all -- a dead end), and plan-backlog.md B1 described
// parseBacklogRef's file kind as ".md"-only and had no rule-2 fallback, so a readable
// extensionless checklist fell through to "anything else non-empty" and was decomposed as
// a raw intent instead of read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectScope } from "../src/scope.js";
import { parseBacklogRef } from "../src/batch-plan.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "muster-backlog-grammar-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Mirrors src/scope.js's rule 2 exactly (readBacklogCandidate is module-private, not
// exported): an existing, readable file relative to cwd containing at least one unchecked
// `- [ ] ` line. Duplicated here deliberately -- this test's whole point is pinning that
// BOTH consumer prose files resolve exactly what rule 2 resolves, so it has to check
// against rule 2's real, public contract (same read + same regex), not scope.js's private
// helper. Deliberately UNGUARDED (no traversal check of its own) -- isUnsafePath below is
// the separate, explicit gate that models the fixed prose's own refusal instruction, kept
// apart from "would a bare read succeed" so the two negative tests can tell them apart.
async function readsAsChecklist(cwd, rawSegment) {
  try {
    // resolve, not join: join would mangle an absolute rawSegment into a bogus nested
    // path (join(cwd, "/etc/passwd") !== "/etc/passwd"), masking exactly the absolute-path
    // case this file's negative tests target. resolve honors an absolute second argument
    // (ignoring cwd) the same way a naive "read whatever path this names" implementation
    // would, while still resolving a relative "../" segment normally for the traversal case.
    const content = await readFile(resolve(cwd, rawSegment), "utf8");
    return /^- \[ \] /m.test(content);
  } catch {
    return false;
  }
}

// Mirrors src/scope.js's isTraversalUnsafe exactly: an absolute path or any ".."
// substring. parseBacklogRef's own shape check now rejects both shapes too (the
// parseref-abs-guard fix -- confirmed live against the real function, not assumed), so
// this duplicates that coverage for the ref-shaped arm; it stays the ONLY gate for the
// readable-checklist-content fallback (arm 2), which never goes through parseBacklogRef
// at all -- that arm's own consumer-prose refusal is why this helper still earns its
// keep here.
function isUnsafePath(rawSegment) {
  return typeof rawSegment !== "string" || isAbsolute(rawSegment) || rawSegment.includes("..");
}

// A candidate is consumable by either delegate's FIXED documented resolution only if it
// clears the explicit refusal AND resolves via one of the two arms (file-ref shape, or an
// existing readable checklist file).
function consumable(ref, readable, rawSegment) {
  return !isUnsafePath(rawSegment) && (ref.kind === "file" || readable);
}

// Three representative scope:"backlog" verdicts, each targeting a distinct pre-fix gap:
//   - the literal default path -- always worked, included as the baseline.
//   - a plain extensionless checklist -- parseBacklogRef alone returns kind:"outcome" for
//     this (no dot-extension), exactly plan-backlog.md B1's pre-fix raw-intent misroute.
//   - a non-default `.md` checklist -- go-backlog.md step 1's pre-fix grammar recognized
//     ONLY the literal ".muster/backlog.md" token, so this one had no matching bullet at
//     all (a dead end), even though it already satisfied parseBacklogRef's file shape.
const CANDIDATES = [
  { path: ".muster/backlog.md", label: "the default backlog path" },
  { path: "TODO", label: "a plain extensionless checklist" },
  { path: "roadmap.md", label: "a non-default .md checklist" },
];

test("round-trip: every representative scope:'backlog' verdict is consumable by go-backlog.md step 1's documented resolution (no dead end)", async () => {
  for (const { path, label } of CANDIDATES) {
    await withTempDir(async (dir) => {
      const full = join(dir, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, "- [ ] a checklist item\n");

      const verdict = await detectScope({ cwd: dir, text: path });
      assert.equal(verdict.scope, "backlog", `${label} (${path}) must classify as scope:"backlog"`);

      // go-backlog.md step 1's documented resolution: empty -> .muster/backlog.md;
      // otherwise (not issues:/linear:) read the named path directly, provided it clears
      // the explicit `..`/absolute refusal AND is a parseable file ref OR an existing
      // readable file with checklist content. A candidate failing this is go-backlog.md's
      // dead end (no bullet in the prose grammar matches it at all).
      const ref = parseBacklogRef(path);
      const readable = await readsAsChecklist(dir, path);
      assert.ok(
        consumable(ref, readable, path),
        `${label} (${path}) must resolve via go-backlog.md step 1's widened grammar (parseBacklogRef file-ref, or an existing readable checklist file); neither matched`
      );
    });
  }
});

test("round-trip: every representative scope:'backlog' verdict is consumable by plan-backlog.md B1's documented resolution (no raw-intent misroute)", async () => {
  for (const { path, label } of CANDIDATES) {
    await withTempDir(async (dir) => {
      const full = join(dir, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, "- [ ] a checklist item\n");

      const verdict = await detectScope({ cwd: dir, text: path });
      assert.equal(verdict.scope, "backlog", `${label} (${path}) must classify as scope:"backlog"`);

      // plan-backlog.md B1's documented resolution: a parseable file ref (rule 1) OR a
      // non-ref-shaped but existing, readable checklist file (rule 2, the bullet this item
      // adds). `kind: "outcome"` with no readable-checklist fallback is exactly the
      // raw-intent misroute the item's brief describes -- B1 pre-fix sent a non-.md
      // checklist into Bootstrap's decomposition machinery instead of reading it.
      const ref = parseBacklogRef(path);
      const readable = await readsAsChecklist(dir, path);
      const misroutedAsRawIntent = ref.kind === "outcome" && !readable;
      assert.ok(
        !misroutedAsRawIntent,
        `${label} (${path}) must not fall through to plan-backlog.md B1's raw-intent Bootstrap path`
      );
      assert.ok(
        consumable(ref, readable, path),
        `${label} (${path}) must resolve via B1's file-ref bullet or its rule-2 fallback bullet; neither matched`
      );
    });
  }
});

// --- negative round-trip: a traversal-shaped or absolute candidate must never be
// consumable by either delegate's documented resolution, even when it resolves to a REAL
// checklist file. Pre-parseref-abs-guard, this was a real gap: parseBacklogRef's file-ref
// shape check rejected a ".." substring but NOT an absolute path (parseBacklogRef("/tmp/x.md")
// used to return kind:"file"), so a naive "resolve whatever parseBacklogRef or a bare read
// accepts" reading of the documented grammar would have let an absolute-path candidate
// through -- both consumer files carried compensating refusal prose to cover it. Now
// parseBacklogRef itself rejects an absolute path the same way it rejects a ".." substring,
// so the ref-shaped arm (below) is guarded upstream; the readable-checklist-content
// fallback (arm 2, never ref-shaped) still applies its own refusal directly in
// plan-backlog.md's rule-2 bullet, since no code path guards that arm. ---

test("round-trip: a relative '..'-bearing candidate that resolves to a real checklist file outside cwd is never consumable by either delegate", async () => {
  await withTempDir(async (parent) => {
    const child = join(parent, "child");
    await mkdir(child);
    // If the refusal didn't apply, join(child, "../secret.md") resolves to a real,
    // checklist-shaped file outside cwd -- readsAsChecklist (deliberately unguarded)
    // would report it readable, which is exactly why isUnsafePath has to gate separately.
    await writeFile(join(parent, "secret.md"), "- [ ] leaked item\n");
    const path = "../secret.md";

    const ref = parseBacklogRef(path);
    assert.equal(ref.kind, "invalid", "sanity: parseBacklogRef itself already rejects a '..'-bearing file-shaped token");
    const readable = await readsAsChecklist(child, path);
    assert.equal(readable, true, "sanity: the unguarded read helper WOULD resolve this outside-cwd file if nothing gated it");

    assert.equal(
      consumable(ref, readable, path),
      false,
      "a '..'-bearing candidate must never be consumable by either delegate's documented resolution, even though the unguarded read would have succeeded"
    );
  });
});

test("round-trip: an absolute-path candidate naming a real checklist file is never consumable by either delegate", async () => {
  await withTempDir(async (outside) => {
    const absolutePath = join(outside, "outside-backlog.md");
    await writeFile(absolutePath, "- [ ] leaked item\n");

    const ref = parseBacklogRef(absolutePath);
    assert.equal(
      ref.kind,
      "invalid",
      "sanity: parseBacklogRef itself now rejects an absolute path the same way it rejects a '..' substring (parseref-abs-guard)"
    );
    await withTempDir(async (cwd) => {
      const readable = await readsAsChecklist(cwd, absolutePath);
      assert.equal(readable, true, "sanity: the unguarded read helper WOULD resolve this absolute path if nothing gated it");

      assert.equal(
        consumable(ref, readable, absolutePath),
        false,
        "an absolute-path candidate must never be consumable by either delegate's documented resolution"
      );
    });
  });
});

// --- textual pin: the prose itself must no longer hard-code the pre-widen literal shape --
// (functional primitives alone don't prove the CONSUMER prose was actually widened -- these
// pin the two command files' own text so a regression back to the narrow grammar fails here
// even if src/scope.js and src/batch-plan.js stay untouched.)

test("prose pin: go-backlog.md step 1 no longer restricts the file form to the literal '.muster/backlog.md' token alone", async () => {
  const text = await readFile(join(REPO_ROOT, "plugin/commands/go-backlog.md"), "utf8");
  assert.ok(
    !/empty or `\.muster\/backlog\.md` — read `\.muster\/backlog\.md`/.test(text),
    "go-backlog.md step 1 still reads as if only the literal '.muster/backlog.md' token resolves as a file ref"
  );
  assert.match(
    text,
    /readable checklist file path/,
    "go-backlog.md step 1 should describe accepting an arbitrary readable checklist file path"
  );
});

test("prose pin: plan-backlog.md B1 no longer restricts the file-ref form to '.md'-only, and documents the rule-2 fallback", async () => {
  const text = await readFile(join(REPO_ROOT, "plugin/commands/plan-backlog.md"), "utf8");
  assert.ok(
    !/a lone whitespace-free token ending in `\.md`/.test(text),
    "plan-backlog.md B1 still describes parseBacklogRef's file kind as .md-only (stale, pre-WIDEN)"
  );
  assert.match(
    text,
    /existing, readable file whose content looks like a checklist/,
    "plan-backlog.md B1 should document the rule-2 fallback for a non-ref-shaped but readable checklist file"
  );
});

// --- parseref-abs-guard: parseBacklogRef itself now rejects an absolute path (kind:
// "invalid"), the same way it already rejected a ".." substring -- retiring the
// compensating absolute-refusal prose PR #22 had bolted onto both consumer files to cover
// the gap. These pins now assert the OPPOSITE of the old ones above: the stale over-claim
// text ("parseBacklogRef alone does not reject" an absolute path) must be gone, since it
// is no longer true, while an absolute path must still be mentioned as one of the
// rejected shapes (accurate, not compensating -- it just names what parseBacklogRef does).

test("prose pin: go-backlog.md step 1 no longer claims parseBacklogRef's shape check leaves an absolute path unguarded", async () => {
  const text = await readFile(join(REPO_ROOT, "plugin/commands/go-backlog.md"), "utf8");
  assert.ok(
    !/shape check alone only rejects a `\.\.` substring/.test(text),
    "go-backlog.md step 1 still carries the stale compensating claim that parseBacklogRef's shape check alone only rejects '..'"
  );
  assert.match(
    text,
    /an absolute path is never read/,
    "go-backlog.md step 1 should still document that an absolute path is never read (now via parseBacklogRef itself, not compensating prose)"
  );
});

test("prose pin: plan-backlog.md B1 no longer claims parseBacklogRef's file-ref shape check leaves an absolute path unguarded", async () => {
  const text = await readFile(join(REPO_ROOT, "plugin/commands/plan-backlog.md"), "utf8");
  assert.ok(
    !/file-ref shape check alone does not reject this/.test(text),
    "plan-backlog.md B1 still carries the stale compensating claim that parseBacklogRef's file-ref shape check alone does not reject an absolute path"
  );
  assert.match(
    text,
    /or an absolute path/,
    "plan-backlog.md B1's file-ref bullet should still document an absolute path as one of the kind:invalid shapes (now via parseBacklogRef itself, not compensating prose)"
  );
});
