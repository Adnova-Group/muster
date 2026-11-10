// plugin/runtime/muster.sh resolves the CLI for the Claude plugin's commands. An installed plugin
// (marketplace cache) has no source checkout beside it, and a globally installed `muster` may be an
// older release that lacks the verbs the commands call (preflight, merge-wave, build-args), so the
// resolver must never fall back to an unpinned global or project install. It uses the source
// checkout when present (--plugin-dir development), else npx pinned to the plugin's own version.
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

// An installed-plugin layout: <cache>/runtime/muster.sh + <cache>/.claude-plugin/plugin.json, no src/.
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
