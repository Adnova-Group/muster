// Muster's security hardening of the vendored Trail of Bits supply-chain-risk-auditor scripts
// (vendor/manifest.yaml source trailofbits-skills; CC BY-SA 4.0, changes noted in each file):
// collect.py's git HEAD read refuses symlinks, stays inside the project and emits only a hex
// object id; render.py's _safe_text entity-escapes HTML, escapes Markdown code/emphasis
// characters and bounds publisher free text. Skipped when python3 >= 3.11 is unavailable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { trackedMkdtempSync as mkdtempSync } from "../test-support/helpers.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const scripts = fileURLToPath(new URL("../plugin/builtins/tob-supply-chain-risk-auditor/scripts/", import.meta.url));
const probe = spawnSync("python3", ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)"]);
const skip = probe.error || probe.status !== 0 ? "python3 >= 3.11 not available" : false;

// Runs a Python snippet with the scripts directory importable; -B: never writes bytecode into the plugin
// (-I ignores PYTHONDONTWRITEBYTECODE).
function py(code, args = []) {
  return execFileSync("python3", ["-I", "-B", "-c", `import sys; sys.path.insert(0, ${JSON.stringify(scripts)})\n${code}`, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" }
  }).trim();
}

const HEX = "0123456789abcdef0123456789abcdef01234567";
const gitCommit = dir => py("from pathlib import Path\nimport collect\nprint(repr(collect._git_commit(Path(sys.argv[1]))))", [dir]);

test("collect._git_commit refuses a symlinked .git/HEAD or .git that points outside the project", { skip }, () => {
  const base = mkdtempSync(join(tmpdir(), "muster-tob-"));
  try {
    const outside = join(base, "outside");
    mkdirSync(join(outside, "gitdir"), { recursive: true });
    writeFileSync(join(outside, "secret"), `${HEX}\n`);
    writeFileSync(join(outside, "gitdir", "HEAD"), `${HEX}\n`);

    const headLink = join(base, "head-link");
    mkdirSync(join(headLink, ".git"), { recursive: true });
    symlinkSync(join(outside, "secret"), join(headLink, ".git", "HEAD"));
    assert.equal(gitCommit(headLink), "None", "a symlinked HEAD discloses nothing");

    const gitLink = join(base, "git-link");
    mkdirSync(gitLink);
    symlinkSync(join(outside, "gitdir"), join(gitLink, ".git"));
    assert.equal(gitCommit(gitLink), "None", "a symlinked .git outside the project discloses nothing");

    const plain = join(base, "plain");
    mkdirSync(join(plain, ".git"), { recursive: true });
    writeFileSync(join(plain, ".git", "HEAD"), `${HEX}\n`);
    assert.equal(gitCommit(plain), `'${HEX.slice(0, 12)}'`, "a real detached HEAD still reports its commit");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("collect._git_commit emits only a 40-64 character hex object id", { skip }, () => {
  const base = mkdtempSync(join(tmpdir(), "muster-tob-"));
  try {
    mkdirSync(join(base, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(base, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(base, ".git", "refs", "heads", "main"), "<b>not-a-commit</b>\n");
    assert.equal(gitCommit(base), "None", "a non-hex ref value is not emitted");
    writeFileSync(join(base, ".git", "refs", "heads", "main"), `${HEX}\n`);
    assert.equal(gitCommit(base), `'${HEX.slice(0, 12)}'`);
    writeFileSync(join(base, ".git", "HEAD"), "ref: ../../outside\n");
    assert.equal(gitCommit(base), "None", "a ref outside .git is refused");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("render._safe_text escapes HTML, pipes and backticks and truncates publisher free text", { skip }, () => {
  const hostile = `<script>alert(1)</script> | \`rm -rf\` *bold* _em_ & ${"x".repeat(400)}`;
  const out = py("import render\nprint(render._safe_text(sys.argv[1]))", [hostile]);
  assert.ok(!out.includes("<script>") && !out.includes("</script>"), out);
  assert.ok(out.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), out);
  assert.ok(out.includes("\\|") && !/(^|[^\\])\|/.test(out), "every pipe is escaped");
  assert.ok(out.includes("\\`rm -rf\\`") && !/(^|[^\\])`/.test(out), "every backtick is escaped");
  assert.ok(out.includes("\\*bold\\*") && out.includes("\\_em\\_") && out.includes("&amp;"), out);
  assert.ok(out.endsWith("…"), "long text ends with an ellipsis");
  const visible = py("import render\nprint(len(render._safe_text('y' * 1000)))");
  assert.equal(Number(visible), 200, "free text is bounded to SAFE_TEXT_LIMIT characters");
});
