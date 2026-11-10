// Muster's security hardening of the vendored superpowers-lab prepare-category-analysis.sh
// (vendor/manifest.yaml source superpowers-lab, MIT; the change is noted in the file header).
// categorized.json is model output about an untrusted codebase: the upstream loop split it on
// tabs and fed the second field to `[[ "$count" -ge 3 ]]`, whose arithmetic evaluation runs
// `a[$(cmd)]`. The hardened script filters inside jq, loops over NUL-separated names and
// sanitizes file names. The upstream base copy is run too, as the kill check that this test
// detects the injection. Skipped without bash or jq.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import { trackedMkdtempSync as mkdtempSync } from "../test-support/helpers.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const hardened = join(repo, "plugin/builtins/splab-finding-duplicate-functions/scripts/prepare-category-analysis.sh");
const upstream = join(repo, "vendor/upstream/superpowers-lab/skills/finding-duplicate-functions/scripts/prepare-category-analysis.sh");
const has = cmd => !spawnSync(cmd, ["--version"]).error;
const skip = has("bash") && has("jq") ? false : "bash or jq not available";

// Hostile categories: a tab that forges a count field holding an arithmetic command
// substitution (BASH_VERSINFO is always set, so `set -u` does not stop the evaluation), a
// newline, a bare $(...), and a path traversal.
// The kill check keeps only the tab and traversal cases: upstream aborts on the newline case
// (its forged file name contains a slash) before it reaches the tab case.
function fixture(dir, { killOnly = false } = {}) {
  const fn = (category, i) => ({ name: `f${i}`, file: "src/x.ts", category, count: `BASH_VERSINFO[$(touch ${join(dir, "MARKER-count")})]` });
  const hostile = [
    `x\tBASH_VERSINFO[$(touch ${join(dir, "MARKER-tab")})]+`,
    ...(killOnly ? [] : [`line\nbreak $(touch ${join(dir, "MARKER-newline")})`]),
    "../../escape",
    ...(killOnly ? [] : ["string utils"])
  ];
  const rows = hostile.flatMap((c, k) => [0, 1, 2].map(i => fn(c, k * 3 + i)));
  rows.push(fn("lonely", 99));
  mkdirSync(join(dir, "work"));
  writeFileSync(join(dir, "work", "categorized.json"), JSON.stringify(rows));
}

// Output goes to work/out, so a ../../ traversal would land in the temp root, checked below.
const run = (script, dir) => spawnSync("bash", [script, join(dir, "work", "categorized.json"), join(dir, "work", "out")], { cwd: join(dir, "work"), encoding: "utf8" });
const markers = dir => readdirSync(dir).filter(f => f.startsWith("MARKER"));

test("prepare-category-analysis.sh never executes or path-splits model-controlled category text", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "muster-splab-"));
  try {
    fixture(dir);
    const r = run(hardened, dir);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(markers(dir), [], "no command substitution from categorized.json ran");
    const out = readdirSync(join(dir, "work", "out")).sort();
    assert.equal(out.length, 4, `one file per 3+ category: ${out.join(", ")}`);
    assert.ok(out.every(f => /^[A-Za-z0-9._-]+\.json$/.test(f) && !f.startsWith(".")), out.join(", "));
    assert.ok(out.includes("string-utils.json") && out.includes("category-..-..-escape.json"), out.join(", "));
    assert.ok(!existsSync(join(dir, "escape.json")), "nothing written outside work/out/");
    for (const f of out) assert.equal(JSON.parse(readFileSync(join(dir, "work", "out", f), "utf8")).length, 3, `${f} keeps its three functions`);
    assert.match(r.stderr, /"lonely": 1 functions \(skipped, < 3\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kill check: the unhardened upstream script runs the injected arithmetic command", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "muster-splab-"));
  try {
    fixture(dir, { killOnly: true });
    run(upstream, dir);
    assert.ok(markers(dir).includes("MARKER-tab"), "the fixture must exercise the upstream injection");
    assert.ok(existsSync(join(dir, "escape.json")), "and the upstream path traversal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
