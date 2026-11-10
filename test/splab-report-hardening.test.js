// Muster's security hardening of the vendored superpowers-lab finding-duplicate-functions scripts
// (vendor/manifest.yaml source superpowers-lab, MIT; each change is noted in the file header).
// duplicates/*.json is model output about an untrusted codebase. Upstream generate-report.sh
// interpolated its fields into the Markdown report raw, so a field could add headings, images
// (a beacon on preview), links or HTML, and a backtick broke out of the code spans. The scripts
// also wrote through a symlink planted at their output path. The upstream base copy is run as
// the kill check. Skipped without bash or jq (and rg for extract-functions.sh).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from "node:fs";
import { trackedMkdtempSync as mkdtempSync } from "../test-support/helpers.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const scripts = join(repo, "plugin/builtins/splab-finding-duplicate-functions/scripts");
const upstreamReport = join(repo, "vendor/upstream/superpowers-lab/skills/finding-duplicate-functions/scripts/generate-report.sh");
const has = cmd => !spawnSync(cmd, ["--version"]).error;
const skip = has("bash") && has("jq") ? false : "bash or jq not available";

const hostile = [
  {
    confidence: "HIGH",
    intent: "x\n\n![](https://evil.example/b?leak)\n## Fake section <script>alert(1)</script>",
    functions: [
      { name: "a`b", file: "src/x.ts", line: 3, notes: "n | col" },
      { name: "c", file: "y`.ts", line: "4\n# forged" },
    ],
    differences: "[click](javascript:alert(1))",
    recommendation: { survivor: "a` <img src=x onerror=alert(1)>", reason: "*why*" },
  },
  { confidence: "MEDIUM", intent: "m", functions: [{ name: "q", file: "f", line: 1 }], recommendation: { action: "## act", reason: "r" } },
  { confidence: "LOW", intent: "l", functions: [{ name: "z", file: "g", line: 2 }], differences: "<b>x</b>" },
];

function runReport(script, dir, output) {
  return spawnSync("bash", [script, join(dir, "dups"), output], { encoding: "utf8" });
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "muster-splab-report-"));
  mkdirSync(join(dir, "dups"));
  writeFileSync(join(dir, "dups", "strings.json"), JSON.stringify(hostile));
  return dir;
}

// The report's structure: only the script's own headings, one `###` per group, function lines
// whose two code spans stay closed, no image/link/HTML syntax from model text.
function injected(report) {
  const problems = [];
  const headings = report.split("\n").filter(l => /^#{1,6}\s/.test(l));
  const fixed = new Set(["# Duplicate Functions Report", "## Summary", "## HIGH Confidence Duplicates", "## MEDIUM Confidence Duplicates", "## LOW Confidence (Possibly Related)"]);
  const groupHeadings = headings.filter(h => !fixed.has(h));
  if (groupHeadings.length !== 3 || groupHeadings.some(h => !h.startsWith("### "))) problems.push(`headings: ${JSON.stringify(groupHeadings)}`);
  if (/<script|<img|<b>/i.test(report.replace(/`[^`\n]*`/g, ""))) problems.push("raw HTML outside code spans");
  if (/(^|[^\\])!\[/.test(report)) problems.push("image syntax");
  if (/(^|[^\\])\[click\]\(/.test(report)) problems.push("link syntax");
  for (const line of report.split("\n").filter(l => l.startsWith("- `"))) {
    if (!/^- `[^`]*` in `[^`]*`( - .*)?$/.test(line)) problems.push(`code span broken: ${line}`);
  }
  return problems;
}

test("generate-report.sh escapes model-written fields so they cannot restructure the Markdown report", { skip }, () => {
  const dir = fixture();
  try {
    const out = join(dir, "report.md");
    const result = runReport(join(scripts, "generate-report.sh"), dir, out);
    assert.equal(result.status, 0, result.stderr);
    const report = readFileSync(out, "utf8");
    assert.deepEqual(injected(report), []);
    assert.match(report, /\| HIGH \| 1 \|/);
    assert.match(report, /x \\!\\\[\\\]\(https:\/\/evil\.example\/b\?leak\) \\#\\# Fake section &lt;script&gt;/, "the text survives, inert");

    // Kill check: the upstream copy lets the same input inject structure.
    const upstreamOut = join(dir, "upstream.md");
    const upstream = runReport(upstreamReport, dir, upstreamOut);
    assert.equal(upstream.status, 0, upstream.stderr);
    assert.notDeepEqual(injected(readFileSync(upstreamOut, "utf8")), [], "the kill check must detect injection in the upstream script");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generate-report.sh and prepare-category-analysis.sh refuse to write through a planted symlink", { skip }, () => {
  const dir = fixture();
  try {
    const target = join(dir, "victim.txt");
    writeFileSync(target, "untouched\n");
    symlinkSync(target, join(dir, "report.md"));
    const result = runReport(join(scripts, "generate-report.sh"), dir, join(dir, "report.md"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symlink/);
    assert.equal(readFileSync(target, "utf8"), "untouched\n");

    const rows = [0, 1, 2].map(i => ({ name: `f${i}`, file: "src/x.ts", category: "strings" }));
    writeFileSync(join(dir, "categorized.json"), JSON.stringify(rows));
    mkdirSync(join(dir, "categories"));
    symlinkSync(target, join(dir, "categories", "strings.json"));
    const split = spawnSync("bash", [join(scripts, "prepare-category-analysis.sh"), join(dir, "categorized.json"), join(dir, "categories")], { encoding: "utf8" });
    assert.notEqual(split.status, 0);
    assert.match(split.stderr, /symlink/);
    assert.equal(readFileSync(target, "utf8"), "untouched\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extract-functions.sh refuses to write its catalog through a planted symlink", { skip: skip || (has("rg") ? false : "rg not available") }, () => {
  const dir = mkdtempSync(join(tmpdir(), "muster-splab-extract-"));
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.js"), "function hello() {\n  return 1;\n}\n");
    const target = join(dir, "victim.txt");
    writeFileSync(target, "untouched\n");
    symlinkSync(target, join(dir, "catalog.json"));
    const result = spawnSync("bash", [join(scripts, "extract-functions.sh"), join(dir, "src"), "-o", join(dir, "catalog.json")], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symlink/);
    assert.equal(readFileSync(target, "utf8"), "untouched\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
