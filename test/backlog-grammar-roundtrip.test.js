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
import { join, dirname } from "node:path";
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
// helper.
async function readsAsChecklist(cwd, rawSegment) {
  try {
    const content = await readFile(join(cwd, rawSegment), "utf8");
    return /^- \[ \] /m.test(content);
  } catch {
    return false;
  }
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
      // otherwise (not issues:/linear:) read the named path directly, provided it's a
      // parseable file ref OR an existing readable file with checklist content. Assert at
      // least one arm resolves it -- a candidate satisfying neither is go-backlog.md's
      // dead end (no bullet in the prose grammar matches it at all).
      const ref = parseBacklogRef(path);
      const readable = await readsAsChecklist(dir, path);
      assert.ok(
        ref.kind === "file" || readable,
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
        ref.kind === "file" || readable,
        `${label} (${path}) must resolve via B1's file-ref bullet or its rule-2 fallback bullet; neither matched`
      );
    });
  }
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
