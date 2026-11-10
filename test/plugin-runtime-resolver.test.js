// plugin/runtime/muster.sh resolves the CLI for the Claude plugin's commands. An installed plugin
// (marketplace cache) has no source checkout beside it, and a globally installed `muster` may be an
// older release that lacks the verbs the commands call (preflight, merge-wave, build-args), so the
// resolver must never fall back to an unpinned global or project install. It uses the source
// checkout when present (--plugin-dir development), else the bundled runtime committed beside it
// (runtime/cli/), else npx pinned to the plugin's own version.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync, chmodSync, cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { trackedMkdtempSync as mkdtempSync } from "../test-support/helpers.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugin", "runtime", "muster.sh");
const VERSION = JSON.parse(readFileSync(path.join(ROOT, "plugin", ".claude-plugin", "plugin.json"), "utf8")).version;

// An installed-plugin layout without the bundled runtime (the npx fallback):
// <cache>/runtime/muster.sh + <cache>/.claude-plugin/plugin.json, no src/, no runtime/cli/.
function installedCopy() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "muster-plugin-cache-"));
  mkdirSync(path.join(dir, "runtime"), { recursive: true });
  mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  cpSync(SCRIPT, path.join(dir, "runtime", "muster.sh"));
  cpSync(path.join(ROOT, "plugin", ".claude-plugin", "plugin.json"), path.join(dir, ".claude-plugin", "plugin.json"));
  return dir;
}

// Fake `muster` and `npx` on PATH that print which one ran and with what arguments.
function fakeBin() {
  const bin = mkdtempSync(path.join(os.tmpdir(), "muster-fake-bin-"));
  for (const name of ["muster", "npx"]) {
    writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*"\n`);
    chmodSync(path.join(bin, name), 0o755);
  }
  return bin;
}

test("installed plugin: an older global muster on PATH is ignored; npx is pinned to the plugin version", () => {
  const cache = installedCopy();
  const bin = fakeBin();
  const out = execFileSync("sh", [path.join(cache, "runtime", "muster.sh"), "preflight", "x"], {
    cwd: cache, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  }).trim();
  assert.equal(out, `npx -y @adnova-group/muster@${VERSION} preflight x`);
});

test("installed plugin: a project-local node_modules muster is ignored too", () => {
  const cache = installedCopy();
  const bin = fakeBin();
  const project = mkdtempSync(path.join(os.tmpdir(), "muster-project-"));
  mkdirSync(path.join(project, "node_modules", ".bin"), { recursive: true });
  writeFileSync(path.join(project, "node_modules", ".bin", "muster"), "#!/bin/sh\necho local-muster\n");
  chmodSync(path.join(project, "node_modules", ".bin", "muster"), 0o755);
  const out = execFileSync("sh", [path.join(cache, "runtime", "muster.sh"), "next"], {
    cwd: project, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  }).trim();
  assert.equal(out, `npx -y @adnova-group/muster@${VERSION} next`);
});

test("source checkout (--plugin-dir development): the repo's own src/cli.js runs", () => {
  const bin = fakeBin();
  const out = execFileSync("sh", [SCRIPT, "help", "preflight"], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.doesNotMatch(out, /^(npx|muster) /m, "neither the global muster nor npx ran");
  assert.match(out, /preflight/);
});

// An installed plugin that carries the bundled runtime (every marketplace install from this repo):
// a full copy of plugin/ with no repository around it. The bundle runs, its assets resolve beside
// it, and neither npx nor an older global or project muster is consulted.
function installedFullCopy() {
  const cache = mkdtempSync(path.join(os.tmpdir(), "muster-plugin-cache-full-"));
  cpSync(path.join(ROOT, "plugin"), cache, { recursive: true });
  return cache;
}

test("installed plugin with the bundled runtime: the bundle runs, never npx or a global muster", () => {
  const cache = installedFullCopy();
  const bin = fakeBin();
  const project = mkdtempSync(path.join(os.tmpdir(), "muster-project-"));
  const run = (...args) => execFileSync("sh", [path.join(cache, "runtime", "muster.sh"), ...args], {
    cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  const preflight = run("preflight", "add a login page", "--json");
  assert.doesNotMatch(preflight, /^(npx|muster) /m, "neither npx nor the global muster ran");
  assert.ok(JSON.parse(preflight).runId, "preflight answered from the bundled runtime");
  assert.equal(JSON.parse(run("next")).position, "new");
  // Assets resolve beside the bundle (runtime/cli/pipelines, runtime/cli/catalog).
  assert.equal(JSON.parse(run("pipeline", "prd")).id, "prd");
  assert.equal(JSON.parse(run("route", "write a prd for login")).pipeline, "prd");
  assert.match(run("help", "merge-wave"), /merge-wave/);
  assert.throws(() => run("plan-lint"), (error) => /expected one PLAN\.md path/.test(error.stderr));
});
