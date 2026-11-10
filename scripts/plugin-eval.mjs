#!/usr/bin/env node
// Run muster's plugin eval suite (eval/plugin/) with `claude plugin eval` (Claude Code 2.1.269+).
//
//   npm run eval:plugin                       # every case, once each
//   npm run eval:plugin -- --case 'fence-*'   # extra args go to `claude plugin eval` as is
//   npm run eval:plugin -- --check            # check the environment, print the command, run nothing
//
// Each case starts a real `claude -p` session with plugin/ loaded, on your credentials, so a run
// costs money (about $0.15 for the suite on haiku; --max-cost-usd caps it). It is a manual
// gate: before a release and after a Claude Code update (CONTRIBUTING.md, docs/ship-checklist.md).
//
// This wrapper only fixes the defaults and the environment:
//   - the suite is ours, so --trust-plugin and --scaffold (scaffolds write fixture files only);
//   - --ablation none: the cases assert muster's own behavior, a no-plugin arm adds cost, no signal;
//   - Bash is granted, which `claude plugin eval` runs under its OS sandbox. On Linux that needs
//     bubblewrap and socat on PATH. The sandbox also refuses a PATH entry it cannot examine
//     (WSL's unreachable /mnt/c directories), so unreadable PATH entries are dropped;
//   - the sandbox hides /home and /tmp except PATH directories and the plugin, so the node running
//     this script is put first on PATH (and a Homebrew prefix, whose node links libraries outside
//     its bin directory) so the plugin's runtime/muster.sh can start node inside the sandbox;
//   - the sandbox's write rules deny all of /tmp, which on Linux (2.1.319) also makes a run
//     workspace under /tmp read-only to Bash (preflight fails with EROFS), so TMPDIR points the
//     run directories at ~/.cache/muster-plugin-eval instead (MUSTER_PLUGIN_EVAL_TMPDIR overrides).
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const MIN_CLAUDE = [2, 1, 269];

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const passthrough = args.filter((a) => a !== "--check");
const has = (flag) => passthrough.some((a) => a === flag || a.startsWith(`${flag}=`));

function readableDir(d) {
  try {
    if (!statSync(d).isDirectory()) return false;
    accessSync(d, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function evalPath(env = process.env, execPath = process.execPath) {
  const kept = (env.PATH || "").split(delimiter).filter((d) => d && readableDir(d));
  const front = [];
  let node = execPath;
  try { node = realpathSync(execPath); } catch { /* keep as is */ }
  front.push(dirname(node));
  const cellar = node.indexOf("/Cellar/");
  if (cellar > 0) front.push(node.slice(0, cellar)); // Homebrew: libnode and friends live under the prefix
  return [...new Set([...front, ...kept])].join(delimiter);
}

function which(bin, path) {
  for (const d of path.split(delimiter)) {
    const p = join(d, bin);
    try { accessSync(p, constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

function versionAtLeast(text, min) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text || "");
  if (!m) return false;
  const v = m.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
}

const PATH = evalPath();
const problems = [];

const claude = which("claude", PATH);
let claudeVersion = "";
if (!claude) problems.push("`claude` is not on PATH. Install Claude Code 2.1.269 or later.");
else {
  claudeVersion = spawnSync(claude, ["--version"], { encoding: "utf8" }).stdout?.trim() || "";
  if (!versionAtLeast(claudeVersion, MIN_CLAUDE)) {
    problems.push(`Claude Code ${claudeVersion || "(unknown version)"} predates \`claude plugin eval\` (2.1.269). Run \`claude update\`.`);
  }
}
if (process.platform === "linux") {
  for (const bin of ["bwrap", "socat"]) {
    if (!which(bin, PATH)) {
      problems.push(`${bin} is not on PATH. The eval sandbox needs it to run Bash: apt install bubblewrap socat (or put the binary on PATH).`);
    }
  }
}
if (process.platform === "win32") {
  problems.push("Native Windows has no sandbox backend for Bash-granting evals. Run under WSL2.");
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evalArgs = [
  "plugin", "eval", ".",
  "--eval-dir", "eval/plugin",
  "--trust-plugin",
  "--scaffold",
  "--no-publish",
];
if (!has("--ablation")) evalArgs.push("--ablation", "none");
if (!has("--judge-model")) evalArgs.push("--judge-model", "haiku");
if (!has("--max-cost-usd")) evalArgs.push("--max-cost-usd", "3");
if (!has("--output-dir")) evalArgs.push("--output-dir", join("eval", "plugin", "results", stamp));
evalArgs.push(...passthrough);
// --allow-tools takes a list, so it goes last (the docs: put the target before list options).
if (!has("--allow-tools")) evalArgs.push("--allow-tools", "Bash", "Write", "Edit", "Workflow");

console.log(`${claudeVersion || "claude (not found)"} · node ${process.version} at ${dirname(process.execPath)}`);
console.log(`$ claude ${evalArgs.map((a) => (/[\s*]/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
if (problems.length) {
  for (const p of problems) console.error(`plugin-eval: ${p}`);
  process.exit(1);
}
if (checkOnly) process.exit(0);
if (!existsSync(join(root, "eval", "plugin", "cases"))) {
  console.error("plugin-eval: eval/plugin/cases is missing; run from a muster source checkout.");
  process.exit(1);
}

const TMPDIR = process.env.MUSTER_PLUGIN_EVAL_TMPDIR
  || (process.platform === "win32" ? process.env.TMPDIR : join(homedir(), ".cache", "muster-plugin-eval"));
if (TMPDIR) mkdirSync(TMPDIR, { recursive: true });
const env = { ...process.env, PATH, ...(TMPDIR ? { TMPDIR } : {}) };
const r = spawnSync(claude, evalArgs, { cwd: root, stdio: "inherit", env });
if (r.error) {
  console.error(`plugin-eval: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
