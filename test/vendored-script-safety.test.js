// Static safety scan of every vendored builtin script (plugin/builtins/**/*.{sh,bash,py,js,mjs,cjs}).
// Muster runs these on repositories that may be untrusted, often with model output as input, a
// setting their authors did not design for. The scan is deterministic, offline and cheap (plain
// regexes over ~25k lines); it fails on high-confidence dangerous patterns:
//   - bash `[[ ... -eq|-ne|-lt|-le|-gt|-ge ... ]]`, `(( ))`, `$(( ))` or `let` on a variable assigned
//     from command output ($(...), backticks) or `read`, with no earlier `=~ ^[0-9]+$` check of it
//     (bash evaluates those operands arithmetically: `a[$(cmd)]` runs cmd);
//   - `eval` of a variable (shell), `eval(`/`exec(` of a non-literal (python), `eval(`/`new Function(` (js);
//   - python `shell=True` whose command is an f-string or built with `+`, `%` or `.format(`;
//   - `os.system(`/`os.popen(` with anything but a plain string literal;
//   - `yaml.load(` without a safe Loader; `pickle`/`cPickle`/`dill`/`marshal` loads, `shelve.open`;
//   - node `exec(`/`execSync(` with a template literal or a concatenated string;
// and, for the Markdown that runs them, a `uv run` command without `--no-config` and an absolute
// `--python` (a checkout's .python-version or .venv otherwise chooses the interpreter).
// Vetted exceptions live in ALLOWLIST with a reason; an entry that no longer matches fails, so the
// list cannot rot. Detector self-tests below keep every rule from passing vacuously.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const ROOT = join(repo, "plugin", "builtins");
const SCRIPT_EXT = new Set([".sh", ".bash", ".py", ".js", ".mjs", ".cjs"]);

// { file, match, rule, reason }: `match` is a substring of the offending line (not a line number,
// so unrelated edits do not churn the list). Every entry must match a finding.
const ALLOWLIST = [
  {
    file: "plugin/builtins/splab-finding-duplicate-functions/scripts/generate-report.sh",
    match: "high_count=$((high_count + h))",
    rule: "bash-arithmetic-taint",
    reason: "h, m and l come from jq `length` and are each checked against ^[0-9]+$ by the loop just above (for n in \"$h\" \"$m\" \"$l\")",
  },
  {
    file: "plugin/builtins/splab-finding-duplicate-functions/scripts/generate-report.sh",
    match: "medium_count=$((medium_count + m))",
    rule: "bash-arithmetic-taint",
    reason: "same validation loop as high_count",
  },
  {
    file: "plugin/builtins/splab-finding-duplicate-functions/scripts/generate-report.sh",
    match: "low_count=$((low_count + l))",
    rule: "bash-arithmetic-taint",
    reason: "same validation loop as high_count",
  },
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

const SHELL = new Set([".sh", ".bash"]);
const PY = new Set([".py"]);
const JS = new Set([".js", ".mjs", ".cjs"]);

const isComment = (line, ext) => (SHELL.has(ext) || PY.has(ext) ? /^\s*#/.test(line) : /^\s*(\/\/|\*|\/\*)/.test(line));

// Text of a call starting at `index` in `text`, up to its balanced closing paren (bounded).
function callText(text, index) {
  const open = text.indexOf("(", index);
  let depth = 0;
  for (let i = open; i < text.length && i < open + 4000; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(index, i + 1);
  }
  return text.slice(index, open + 4000);
}

function shellFindings(lines) {
  const findings = [];
  const tainted = new Map(); // name -> first assignment line index
  const validated = new Map(); // name -> first validation line index
  lines.forEach((line, i) => {
    if (isComment(line, ".sh")) return;
    for (const m of line.matchAll(/(?:^|[\s;&|(])(?:local\s+|export\s+|readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)=["']?(?:\$\((?!\()|`)/g)) {
      if (!tainted.has(m[1])) tainted.set(m[1], i);
    }
    const read = /\bread\b((?:\s+-[A-Za-z]+(?:\s+(?:''|""|\S+))?)*)\s+([A-Za-z_][\w\s]*)/.exec(line);
    if (read) for (const name of read[2].trim().split(/\s+/)) if (/^[A-Za-z_]\w*$/.test(name) && !tainted.has(name)) tainted.set(name, i);
    for (const m of line.matchAll(/\$\{?([A-Za-z_]\w*)\}?"?\s*=~\s*['"]?\^-?\??\[0-9\]\+\$/g)) if (!validated.has(m[1])) validated.set(m[1], i);
  });
  const uses = (expr, name) => new RegExp(`(?<![\\w$])\\$?\\{?${name}\\}?(?!\\w)`).test(expr);
  lines.forEach((line, i) => {
    if (isComment(line, ".sh")) return;
    const contexts = [];
    for (const m of line.matchAll(/\[\[([^\]]*?)\]\]/g)) if (/\s-(eq|ne|lt|le|gt|ge)\s/.test(m[1])) contexts.push(m[1]);
    for (const m of line.matchAll(/\$?\(\(([^)]*)\)\)/g)) contexts.push(m[1]);
    const letLine = /^\s*let\s+(.*)$/.exec(line);
    if (letLine) contexts.push(letLine[1]);
    for (const [name, at] of tainted) {
      if (at > i) continue;
      if (validated.has(name) && validated.get(name) <= i) continue;
      if (contexts.some(c => uses(c, name))) {
        findings.push({ line: i + 1, rule: "bash-arithmetic-taint", text: line.trim(), detail: `${name} comes from command output or read` });
        break;
      }
    }
    if (/^\s*eval\s+.*\$/.test(line) || /[;&|]\s*eval\s+.*\$/.test(line)) findings.push({ line: i + 1, rule: "eval-variable", text: line.trim() });
  });
  return findings;
}

const composed = arg => /^\s*(?:[rRbB]?[fF][rRbB]?["']|.*(?:["']\s*\+|\+\s*["']|["']\s*%|\.format\())/.test(arg);

function pythonFindings(text, lines) {
  const findings = [];
  const lineOf = index => text.slice(0, index).split("\n").length;
  const live = index => !isComment(lines[lineOf(index) - 1] ?? "", ".py");
  for (const m of text.matchAll(/\bsubprocess\.(?:run|call|Popen|check_output|check_call|getoutput|getstatusoutput)\s*\(/g)) {
    if (!live(m.index)) continue;
    const call = callText(text, m.index);
    const firstArg = call.slice(call.indexOf("(") + 1);
    if (/getoutput|getstatusoutput/.test(m[0]) ? !/^\s*["'][^"'{}%]*["']\s*\)/.test(firstArg) : /\bshell\s*=\s*True\b/.test(call) && composed(firstArg)) {
      findings.push({ line: lineOf(m.index), rule: "python-shell-composed", text: lines[lineOf(m.index) - 1].trim() });
    }
  }
  for (const m of text.matchAll(/\bos\.(?:system|popen)\s*\(/g)) {
    if (!live(m.index)) continue;
    const arg = callText(text, m.index).replace(/^[^(]*\(/, "");
    if (!/^\s*["'][^"'{}%]*["']\s*\)$/.test(arg)) findings.push({ line: lineOf(m.index), rule: "os-system-interpolated", text: lines[lineOf(m.index) - 1].trim() });
  }
  for (const m of text.matchAll(/\byaml\.load\s*\(/g)) {
    if (!live(m.index)) continue;
    const call = callText(text, m.index);
    if (!/Loader\s*=/.test(call) || /Loader\s*=\s*(?:yaml\.)?(?:Unsafe|Full)?Loader\b/.test(call)) findings.push({ line: lineOf(m.index), rule: "yaml-unsafe-load", text: lines[lineOf(m.index) - 1].trim() });
  }
  for (const m of text.matchAll(/\b(?:yaml\.(?:unsafe_load|full_load)|c?[pP]ickle\.loads?|dill\.loads?|marshal\.loads?|shelve\.open|joblib\.load)\s*\(/g)) {
    if (live(m.index)) findings.push({ line: lineOf(m.index), rule: "unsafe-deserialization", text: lines[lineOf(m.index) - 1].trim() });
  }
  for (const m of text.matchAll(/(?<![.\w])(eval|exec)\s*\(\s*(?!["')])/g)) {
    if (live(m.index)) findings.push({ line: lineOf(m.index), rule: "eval-variable", text: lines[lineOf(m.index) - 1].trim() });
  }
  return findings;
}

function jsFindings(lines) {
  const findings = [];
  lines.forEach((line, i) => {
    if (isComment(line, ".js")) return;
    if (/(?:^|[^.\w]|(?:child_process|childProcess|cp)\.)(?:exec|execSync)\s*\(\s*(?:`[^`]*\$\{|["'][^"']*["']\s*\+|[A-Za-z_$][\w$]*\s*\+)/.test(line)) {
      findings.push({ line: i + 1, rule: "node-exec-interpolated", text: line.trim() });
    }
    if (/(?<![.\w])eval\s*\(|\bnew\s+Function\s*\(/.test(line)) findings.push({ line: i + 1, rule: "eval-variable", text: line.trim() });
  });
  return findings;
}

// `uv run` resolves its interpreter and settings from the working directory unless told not to.
function markdownFindings(lines) {
  const findings = [];
  lines.forEach((line, i) => {
    if (!/^\s*(?:\$\s*)?uv\s+run\b/.test(line)) return;
    if (!/--no-config\b/.test(line) || !/--python\s+(?:"\$\(command -v python3\)"|\/\S+)/.test(line)) {
      findings.push({ line: i + 1, rule: "uv-run-unpinned", text: line.trim() });
    }
  });
  return findings;
}

export function scan(text, ext) {
  const lines = text.split("\n");
  if (SHELL.has(ext)) return shellFindings(lines);
  if (PY.has(ext)) return pythonFindings(text, lines);
  if (JS.has(ext)) return jsFindings(lines);
  if (ext === ".md") return markdownFindings(lines);
  return [];
}

test("detector self-test: every rule fires on a known-bad sample and stays quiet on its safe form", () => {
  const bad = [
    [".sh", 'count=$(jq length x.json)\nif [[ "$count" -ge 3 ]]; then :; fi', "bash-arithmetic-taint"],
    [".sh", "while IFS=$'\\t' read -r category count; do\n  if [[ \"$count\" -ge 3 ]]; then :; fi\ndone", "bash-arithmetic-taint"],
    [".sh", "n=`curl -s x`\ntotal=$((total + n))", "bash-arithmetic-taint"],
    [".sh", "n=$(cat f)\nlet total+=n", "bash-arithmetic-taint"],
    [".sh", 'cmd=$(cat f)\neval "$cmd"', "eval-variable"],
    [".py", 'import subprocess\nsubprocess.run(f"git log {ref}", shell=True)', "python-shell-composed"],
    [".py", 'import subprocess\nsubprocess.check_output("ls " + path,\n    shell=True)', "python-shell-composed"],
    [".py", 'import subprocess\nsubprocess.call("rm %s" % p, shell=True)', "python-shell-composed"],
    [".py", 'import os\nos.system(f"open {url}")', "os-system-interpolated"],
    [".py", "import os\nos.system(cmd)", "os-system-interpolated"],
    [".py", "import yaml\ndata = yaml.load(open(p))", "yaml-unsafe-load"],
    [".py", "import yaml\ndata = yaml.load(s, Loader=yaml.Loader)", "yaml-unsafe-load"],
    [".py", "import pickle\nobj = pickle.load(fh)", "unsafe-deserialization"],
    [".py", "result = eval(expr)", "eval-variable"],
    [".js", "import { execSync } from 'node:child_process';\nexecSync(`git show ${ref}`);", "node-exec-interpolated"],
    [".mjs", "cp.exec('open ' + url);", "node-exec-interpolated"],
    [".js", "const f = new Function(body);", "eval-variable"],
    [".md", "uv run --isolated --with requests python scripts/x.py", "uv-run-unpinned"],
  ];
  for (const [ext, text, rule] of bad) {
    assert.ok(scan(text, ext).some(f => f.rule === rule), `${rule} must fire on: ${text}`);
  }
  const good = [
    [".sh", 'count=$(jq length x.json)\n[[ "$count" =~ ^[0-9]+$ ]] || exit 1\nif [[ "$count" -ge 3 ]]; then :; fi'],
    [".sh", "COUNT=0\nCOUNT=$((COUNT + 1))\nwhile [[ $# -gt 0 ]]; do shift; done"],
    [".sh", "# eval $x in a comment\njq '.name != \"let\" and ((.a // 1) > 0)' f"],
    [".py", 'import subprocess\nsubprocess.run(["git", "log", ref], check=True)\nsubprocess.run("ls -la", shell=True)'],
    [".py", 'import yaml\ndata = yaml.load(s, Loader=yaml.SafeLoader)\nos.system("clear")'],
    [".js", "const m = /a(b)/.exec(text);\nexecFileSync('git', ['show', ref]);\nexecSync('npm root -g');"],
    [".md", 'uv run --no-config --python "$(command -v python3)" scripts/collect.py .\nIt needs only Python 3 (`uv run` works too).'],
  ];
  for (const [ext, text] of good) assert.deepEqual(scan(text, ext), [], `no finding expected for: ${text}`);
});

test("kill check: the scan flags the original splab arithmetic injection in its upstream base copy", () => {
  const upstream = join(repo, "vendor/upstream/superpowers-lab/skills/finding-duplicate-functions/scripts/prepare-category-analysis.sh");
  const findings = scan(readFileSync(upstream, "utf8"), ".sh");
  assert.ok(findings.some(f => f.rule === "bash-arithmetic-taint" && /"\$count" -ge 3/.test(f.text)), JSON.stringify(findings));
});

test("vendored builtin scripts contain no high-confidence dangerous pattern outside the reasoned allowlist", () => {
  const started = Date.now();
  const files = walk(ROOT).filter(f => SCRIPT_EXT.has(extname(f)) || extname(f) === ".md");
  const found = [];
  for (const file of files) {
    const rel = relative(repo, file).split("\\").join("/");
    for (const finding of scan(readFileSync(file, "utf8"), extname(file))) found.push({ file: rel, ...finding });
  }
  const used = new Set();
  const unexpected = found.filter(f => {
    const entry = ALLOWLIST.find(a => a.file === f.file && a.rule === f.rule && f.text.includes(a.match));
    if (entry) used.add(entry);
    return !entry;
  });
  assert.deepEqual(unexpected.map(f => `${f.file}:${f.line} [${f.rule}] ${f.text}${f.detail ? ` (${f.detail})` : ""}`), [],
    "fix the script, or add a reasoned ALLOWLIST entry if the pattern is provably safe");
  const stale = ALLOWLIST.filter(a => !used.has(a));
  assert.deepEqual(stale.map(a => `${a.file} [${a.rule}] ${a.match}`), [], "these ALLOWLIST entries no longer match anything; remove them");
  for (const entry of ALLOWLIST) assert.ok(entry.reason && entry.reason.length > 20, `allowlist entry needs a reason: ${entry.match}`);
  assert.ok(files.filter(f => SCRIPT_EXT.has(extname(f))).length >= 50, "the scan must actually cover the vendored scripts");
  assert.ok(Date.now() - started < 5_000, `the scan must stay cheap (took ${Date.now() - started} ms)`);
});
