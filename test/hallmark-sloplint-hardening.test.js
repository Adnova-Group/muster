// Muster's security hardening of the vendored hallmark sloplint (vendor/manifest.yaml source
// hallmark, MIT; noted in each script's header, base copies in vendor/upstream/hallmark/).
// sloplint runs in the project being linted, which may be an untrusted checkout:
//   - `--before` wrote .hallmark/before.json and before.txt (page text included) through a
//     symlink planted at .hallmark or at the file;
//   - an aria-labelledby value was spliced into a RegExp unescaped (ReDoS on page content).
// The upstream base copy is run as the kill check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { trackedMkdtempSync as mkdtempSync } from "../test-support/helpers.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const SLOPLINT = join(repo, "plugin/builtins/hallmark/scripts/sloplint.mjs");
const UPSTREAM = join(repo, "vendor/upstream/hallmark/skills/hallmark/scripts/sloplint.mjs");

const PAGE = "<!doctype html><html><head><title>t</title></head><body><main><h1>Hi</h1><p style=\"color:#808080\">$(touch pwned) text</p></main></body></html>\n";

function lint(script, cwd, args, timeout = 60_000) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", timeout });
}

test("sloplint --before refuses to write through a symlink planted at .hallmark or its files", () => {
  const dir = mkdtempSync(join(tmpdir(), "muster-hallmark-"));
  try {
    const project = join(dir, "project");
    const outside = join(dir, "outside");
    mkdirSync(project);
    mkdirSync(outside);
    writeFileSync(join(project, "index.html"), PAGE);

    symlinkSync(outside, join(project, ".hallmark"));
    const linkedDir = lint(SLOPLINT, project, ["index.html", "--before"]);
    assert.equal(linkedDir.status, 2, linkedDir.stderr);
    assert.match(linkedDir.stderr, /refusing to write through a symlink/);
    assert.equal(existsSync(join(outside, "before.json")), false, "nothing lands in the link's target");

    const upstream = lint(UPSTREAM, project, ["index.html", "--before"]);
    assert.ok(existsSync(join(outside, "before.json")), `kill check: upstream writes through the link (${upstream.stderr})`);
    rmSync(join(outside, "before.json"));

    rmSync(join(project, ".hallmark"));
    mkdirSync(join(project, ".hallmark"));
    const victim = join(outside, "rc");
    writeFileSync(victim, "untouched\n");
    symlinkSync(victim, join(project, ".hallmark", "before.json"));
    const linkedFile = lint(SLOPLINT, project, ["index.html", "--before"]);
    assert.equal(linkedFile.status, 2, linkedFile.stderr);
    assert.equal(readFileSync(victim, "utf8"), "untouched\n");

    rmSync(join(project, ".hallmark", "before.json"));
    const plain = lint(SLOPLINT, project, ["index.html", "--before"]);
    assert.notEqual(plain.status, 2, plain.stderr);
    assert.ok(existsSync(join(project, ".hallmark", "before.json")), "a real .hallmark directory is still written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sloplint escapes an aria-labelledby value before building a pattern from it (no ReDoS)", () => {
  const dir = mkdtempSync(join(tmpdir(), "muster-hallmark-redos-"));
  try {
    const page = `<!doctype html><html><head><title>t</title></head><body><main><h1>x</h1>`
      + `<section aria-labelledby="(a+)+$"><div id="${"a".repeat(40)}!">label</div><p>body</p></section></main></body></html>\n`;
    writeFileSync(join(dir, "index.html"), page);
    const started = Date.now();
    const run = lint(SLOPLINT, dir, ["index.html"], 30_000);
    assert.equal(run.signal, null, "sloplint must finish rather than backtrack");
    assert.ok(Date.now() - started < 30_000);

    const upstream = lint(UPSTREAM, dir, ["index.html"], 3_000);
    assert.equal(upstream.signal, "SIGTERM", "kill check: upstream backtracks on the injected pattern");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
