// `muster doctor --codex`'s stale PATH-level muster detection (backlog item
// `run4-polish-pair`, part a): 2026-07-19's run 4 found a shadow `muster` on
// PATH (an old global npm install, /home/linuxbrew/.linuxbrew/bin/muster)
// that lacked the codex-conformance verb entirely -- a bare `muster`
// invocation would silently serve that stale behavior. Reuses the SAME
// injectable `execFile` param every other codex-doctor.js check already
// takes, so a fixture that never mentions this check (e.g. `execFile:
// absent`) still exercises it safely (command -v throws -> ok:true, no PATH
// muster found).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { runCodexDoctor } from "../src/codex-doctor.js";
import { repoRoot } from "../test-support/codex-helpers.js";

const OWN_HELP = "Usage: muster <detect|doctor [--codex]|codex-conformance [YYYY/MM/DD | --days N] [--cwd <substr>] [--current-pins-only]|help [command]>\n";

function fakeExec({ pathMuster, shadowHelp, ownFails = false, shadowFails = false, locateFails = false } = {}) {
  return async (file, args = []) => {
    if (file === "sh" && args[0] === "-c" && args[1] === "command -v muster") {
      if (locateFails || !pathMuster) throw Object.assign(new Error("not found"), { code: 1 });
      return { stdout: `${pathMuster}\n`, stderr: "" };
    }
    if (file === process.execPath) {
      if (ownFails) throw new Error("own probe crashed");
      return { stdout: OWN_HELP, stderr: "" };
    }
    if (file === pathMuster) {
      if (shadowFails) throw new Error("shadow probe crashed");
      return { stdout: shadowHelp, stderr: "" };
    }
    throw new Error(`unexpected execFile call: ${file} ${args.join(" ")}`);
  };
}

test("codex-path-shadow: no muster on PATH outside this package is ok:true", async () => {
  const report = await runCodexDoctor({ root: repoRoot, execFile: fakeExec({ pathMuster: null }) });
  const check = report.checks.find(c => c.name === "codex-path-shadow");
  assert.ok(check, "codex-path-shadow check must always be present");
  assert.equal(check.ok, true);
  assert.match(check.detail, /no `muster` found on PATH/);
});

test("codex-path-shadow: a PATH muster whose --help output matches this package is ok:true", async () => {
  const report = await runCodexDoctor({
    root: repoRoot,
    execFile: fakeExec({ pathMuster: "/usr/local/bin/muster", shadowHelp: OWN_HELP })
  });
  const check = report.checks.find(c => c.name === "codex-path-shadow");
  assert.equal(check.ok, true);
  assert.match(check.detail, /matches this package/);
});

test("codex-path-shadow: a stale PATH muster missing verbs is ok:false and names the path + remediation", async () => {
  const stalePath = "/home/linuxbrew/.linuxbrew/bin/muster";
  const staleHelp = "Usage: muster <detect|doctor [--codex]|help [command]>\n"; // no codex-conformance
  const report = await runCodexDoctor({
    root: repoRoot,
    execFile: fakeExec({ pathMuster: stalePath, shadowHelp: staleHelp })
  });
  const check = report.checks.find(c => c.name === "codex-path-shadow");
  assert.equal(check.ok, false);
  assert.equal(report.ok, false, "an incoherent PATH shadow must fail the overall doctor report");
  assert.match(check.detail, new RegExp(stalePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(check.detail, /npm uninstall -g.*npm i -g @adnova-group\/muster@latest.*remove the shadow/);
});

test("codex-path-shadow: fails OPEN (ok:true, named) when the probe itself errors", async () => {
  const report = await runCodexDoctor({
    root: repoRoot,
    execFile: fakeExec({ pathMuster: "/opt/broken/muster", shadowFails: true })
  });
  const check = report.checks.find(c => c.name === "codex-path-shadow");
  assert.equal(check.ok, true, "a broken PATH binary must not fail doctor incoherently");
  assert.match(check.detail, /\/opt\/broken\/muster/);
  assert.match(check.detail, /could not probe/);
});

test("codex-path-shadow: an execFile fixture with no PATH-lookup awareness (e.g. the shared `absent` fixture) fails open safely", async () => {
  const absent = async () => { throw new Error("not found"); };
  const report = await runCodexDoctor({ root: repoRoot, execFile: absent });
  const check = report.checks.find(c => c.name === "codex-path-shadow");
  assert.equal(check.ok, true);
});
