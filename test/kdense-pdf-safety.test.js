// kdense-literature-review renders reviews that embed untrusted fetched text (paper titles and
// abstracts) through Pandoc and XeLaTeX. Pins the security adaptation recorded in
// vendor/manifest.yaml (source kdense-skills): raw TeX and raw-attribute blocks are disabled in
// the Markdown reader, the TeX engine runs with paranoid file access, resources resolve from the
// source directory only, and search_databases.py writes fetched fields as escaped data, so an
// injected \input or \include cannot embed a local file in the PDF.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);
const root = join(import.meta.dirname, "..");
const scripts = join(root, "plugin/builtins/kdense-literature-review/scripts");
const has = cmd => pexec(cmd, ["--version"]).then(() => true, () => false);
const [python, pandoc, xelatex, pdftotext] = await Promise.all(["python3", "pandoc", "xelatex", "pdftotext"].map(has));

// Runs a Python snippet with the skill's scripts importable (-I: no cwd or user site on sys.path).
const py = async (code, cwd = tmpdir()) => {
  const { stdout } = await pexec("python3", ["-I", "-B", "-c", `import sys; sys.path.insert(0, ${JSON.stringify(scripts)})\n${code}`], { cwd });
  return stdout;
};

test("generate_pdf builds a pandoc command with raw TeX disabled and a source-only resource path", { skip: python ? false : "python3 not installed" }, async () => {
  const out = JSON.parse(await py(`import json, generate_pdf as g
from pathlib import Path
print(json.dumps({"cmd": g.build_command(Path("/r/review.md"), Path("/r/review.pdf")), "env": g.tex_env({"PATH": "/bin"})}))`));
  const i = out.cmd.indexOf("-f");
  assert.ok(i > 0, "an explicit input format is passed");
  assert.equal(out.cmd[i + 1], "markdown-raw_tex-raw_attribute");
  assert.equal(out.cmd[out.cmd.indexOf("--resource-path") + 1], "/r", "resources resolve from the source directory only");
  assert.deepEqual(out.env, { PATH: "/bin", openin_any: "p", openout_any: "p", shell_escape: "f" });
  const source = await readFile(join(scripts, "generate_pdf.py"), "utf8");
  assert.match(source, /subprocess\.run\(cmd, [^)]*env=tex_env\(\), cwd=workdir\)/, "pandoc (and the TeX engine it spawns) gets the paranoid environment and an empty working directory");
  assert.doesNotMatch(source, /Path\.cwd\(\)/, "the working directory is not a resource path");
});

// Paranoid TeX file access still resolves relative names, and Pandoc passes math through
// verbatim, so $\input{notes/keys.txt}$ would read a file under the working directory. pandoc
// therefore runs from a fresh empty directory, never the caller's (often the checkout).
test("generate_pdf runs pandoc from a fresh empty directory, not the caller's or the source's", { skip: python ? false : "python3 not installed" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-kdense-cwd-"));
  try {
    await writeFile(join(dir, "review.md"), "# Review\n\nMath $\\input{notes/keys.txt}$.\n");
    const out = JSON.parse((await py(`import json, os, subprocess, generate_pdf as g
from pathlib import Path
seen = {}
def fake_run(cmd, **kw):
    seen["cwd"] = kw.get("cwd"); seen["entries"] = os.listdir(kw["cwd"]) if kw.get("cwd") else None
    seen["shell_escape"] = kw["env"].get("shell_escape")
    Path(cmd[cmd.index("-o") + 1]).write_bytes(b"%PDF-1.5\\n")
    return subprocess.CompletedProcess(cmd, 0, "", "")
g.subprocess.run = fake_run
src = Path(${JSON.stringify(join(dir, "review.md"))})
ok = g.run_pandoc(g.build_command(src, src.with_suffix(".pdf")), src.with_suffix(".pdf"), None, None, False, False, None, src)
seen["ok"] = ok; seen["exists_after"] = os.path.exists(seen["cwd"]); seen["caller"] = os.getcwd()
print(json.dumps(seen))`, dir)).trim().split("\n").pop());
    assert.equal(out.ok, true);
    assert.ok(out.cwd, "pandoc must get an explicit working directory");
    assert.notEqual(out.cwd, out.caller, "not the caller's working directory");
    assert.notEqual(out.cwd, dir, "not the review's directory");
    assert.deepEqual(out.entries, [], "the working directory is empty");
    assert.equal(out.exists_after, false, "and removed afterwards");
    assert.equal(out.shell_escape, "f");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("search_databases writes fetched text as escaped, single-line data", { skip: python ? false : "python3 not installed" }, async () => {
  const out = JSON.parse(await py(`import json, search_databases as s
r = [{"title": "T \\\\input{/etc/passwd} $\\\\include{x}$\\n\`\`\`{=latex}", "authors": "A", "year": 2020, "abstract": "[@k] <b>", "doi": "10.1/a(b)", "type": "art}icle"}]
print(json.dumps({"md": s.format_search_results(r, "markdown"), "bib": s.format_search_results(r, "bibtex")}))`));
  assert.doesNotMatch(out.md, /(^|[^\\])\\input\{/, "no live \\input control sequence in Markdown");
  assert.match(out.md, /\\\\input\\\{\/etc\/passwd\\\}/, "the backslash and braces are escaped");
  assert.match(out.md, /\\\$/, "math delimiters are escaped");
  assert.doesNotMatch(out.md, /^```/m, "a fetched field cannot open a raw block on its own line");
  assert.match(out.md, /\\\[\\@k\\\]/, "citation syntax in fetched text is inert");
  assert.match(out.bib, /^@article\{/m, "the entry type is reduced to letters");
  assert.match(out.bib, /title = \{T \\textbackslash\{\}input\\\{\/etc\/passwd\\\} \\\$/, "TeX specials are escaped in BibTeX fields");
});

test("pandoc with the adapted input format never emits an injected \\input", { skip: pandoc ? false : "pandoc not installed" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-kdense-pdf-"));
  try {
    const secret = join(dir, "secret.txt");
    await writeFile(secret, "MUSTER-SECRET-7f3a\n");
    await writeFile(join(dir, "review.md"), `# Review\n\nTitle \\input{${secret}} and \\include{${secret}}.\n\n\`\`\`{=latex}\n\\input{${secret}}\n\`\`\`\n`);
    const { stdout: tex } = await pexec("pandoc", [join(dir, "review.md"), "-f", "markdown-raw_tex-raw_attribute", "-t", "latex"], { cwd: dir });
    assert.doesNotMatch(tex, /MUSTER-SECRET/);
    assert.doesNotMatch(tex, /(^|[^{\\])\\(input|include)\{/m, "the control sequences are escaped as text");
    if (!xelatex || !python) return;
    const ok = await py(`import generate_pdf as g
print(g.generate_pdf(${JSON.stringify(join(dir, "review.md"))}, ${JSON.stringify(join(dir, "review.pdf"))}, toc=False))`, dir);
    assert.match(ok, /True/);
    assert.ok((await stat(join(dir, "review.pdf"))).size > 0);
    if (pdftotext) {
      const { stdout: text } = await pexec("pdftotext", [join(dir, "review.pdf"), "-"]);
      assert.doesNotMatch(text, /MUSTER-SECRET/);
      assert.match(text, /input/, "the injected text is rendered as literal text");
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
