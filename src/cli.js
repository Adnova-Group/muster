#!/usr/bin/env node
import { detectProject, hasPromptingSignal } from "./detect.js";
import { loadCatalog } from "./catalog.js";
import { readInstalled, readInstalledCowork } from "./harness.js";
import { resolveCapabilities } from "./capabilities.js";
import { validateManifest, manifestWarnings } from "./manifest.js";
import { writeMemory, readMemory } from "./memory.js";
import { computeWaves, nextTasks } from "./wave.js";
import { computeSprintWaves } from "./sprint-waves.js";
import { tallyReview } from "./review.js";
import { pickWinner } from "./tournament.js";
import { homedir } from "node:os";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runDoctor } from "./doctor.js";
import { initScratchpad } from "./scratchpad.js";
import { readProfile } from "./profile.js";
import { buildSignals } from "./signals.js";
import { validateVendorManifest, runVendor } from "./vendor.js";
import { parse as parseYaml } from "yaml";
import { scaffoldProject } from "./setup.js";
import { renderPlanChecklist } from "./checklist.js";
import { classifyDomain } from "./domain.js";
import { loadPipelines, pipelineForDomain, routePipeline } from "./pipeline.js";
import { scoreArtifact } from "./score.js";
import { classifyFailure, buildDiagnoseManifest } from "./diagnose.js";
import { buildAuditManifest } from "./audit.js";
import { runInstall, runUninstall } from "./install.js";
import { assessOutcome } from "./interview.js";
import { parseDomainArgs, formatError, requireArg, flagValue } from "./cli-args.js";
import { dirFromImportMeta } from "./fs-util.js";
import { matchProviders } from "./match.js";
import { prioritize } from "./prioritize.js";
import { parseIssueRef, resolveIssue } from "./issue.js";
import { classifySteer } from "./steer.js";
import { lintPrompt, lintChat, lintWorkflow } from "./prompt-lint.js";
import { scoreHumanness } from "./humanizer-score.js";
import { gradeCollected } from "./prompt-eval.js";
import { proposeVariations, selectWinner } from "./prompt-optimize.js";
import { scanRepoPrompts } from "./prompt-scan.js";
import { fuse } from "./fusion.js";
import { validateAdviceRequest } from "./advisor.js";
import { modelForRole } from "./model.js";

const CATALOG_DIR = new URL("../catalog/", import.meta.url);

function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + "\n"); }
function fail(msg) { process.stderr.write(`muster: ${msg}\n`); process.exit(1); }

// Shared stdin/text reader for every command that accepts a file-or-stdin arg. Caps stdin so an
// untrusted caller can't pump unbounded input into a linter/scorer (used by `prompt` and `humanize-score`).
const MAX_STDIN_BYTES = 1_048_576; // 1 MB — far above any realistic prompt
function readStdin() {
  return new Promise((resolve, reject) => {
    let d = "", bytes = 0; process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => {
      bytes += Buffer.byteLength(c, "utf8");
      if (bytes > MAX_STDIN_BYTES) { process.stdin.destroy(); reject(new Error(`stdin exceeds ${MAX_STDIN_BYTES} byte limit`)); return; }
      d += c;
    });
    process.stdin.on("end", () => resolve(d));
    process.stdin.on("error", reject);
  });
}
// A "-", a missing arg, or a flag (e.g. `lint --agent`) all mean: read stdin.
const readText = async (arg) =>
  (!arg || arg === "-" || arg.startsWith("--")) ? await readStdin() : await readFile(arg, "utf8");

async function main() {
const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "detect") {
    out(await detectProject(rest[0] || process.cwd()));
  } else if (cmd === "capabilities") {
    const catalog = await loadCatalog(CATALOG_DIR);
    const home = rest.find(a => !a.startsWith("-")) || homedir();
    // --cowork resolves providers from Cowork's MCP registry instead of ~/.claude;
    // declared remote connectors (not disk-discoverable) come from --connectors or env.
    let installed;
    if (rest.includes("--cowork")) {
      const declared = (flagValue(rest, "--connectors") || process.env.MUSTER_COWORK_CONNECTORS || "")
        .split(",").map(s => s.trim()).filter(Boolean);
      installed = await readInstalledCowork(home, { declaredConnectors: declared });
    } else {
      installed = await readInstalled(home);
    }
    out(resolveCapabilities(catalog, installed));
  } else if (cmd === "match") {
    if (!rest[0]) fail("match <task>: missing task");
    const catalog = await loadCatalog(CATALOG_DIR);
    out(matchProviders(rest[0], catalog, await readInstalled(homedir())));
  } else if (cmd === "manifest" && rest[0] === "validate") {
    const file = requireArg(rest, 1, "manifest validate <file>: missing file path", fail);
    const obj = JSON.parse(await readFile(file, "utf8"));
    const r = validateManifest(obj);
    const warnings = manifestWarnings(obj);
    out(warnings.length ? { ...r, warnings } : r);
    if (!r.ok) process.exit(2);
  } else if (cmd === "memory" && rest[0] === "write") {
    const dir = requireArg(rest, 1, "memory write <dir> <entry.json>: missing args", fail);
    const entryFile = requireArg(rest, 2, "memory write <dir> <entry.json>: missing args", fail);
    const entry = JSON.parse(await readFile(entryFile, "utf8"));
    await writeMemory(dir, entry); out({ ok: true });
  } else if (cmd === "memory" && rest[0] === "read") {
    if (!rest[1]) fail("memory read <dir> [query]: missing dir");
    out(await readMemory(rest[1], rest[2] || ""));
  } else if (cmd === "wave") {
    const file = requireArg(rest, 0, "wave <manifest.json>: missing file path", fail);
    const m = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(m.plan)) fail("wave: manifest has no 'plan' array");
    out(computeWaves(m.plan));
  } else if (cmd === "next") {
    const file = requireArg(rest, 0, "next <manifest.json> [--done a,b]: missing file path", fail);
    const m = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(m.plan)) fail("next: manifest has no 'plan' array");
    const doneArg = flagValue(rest, "--done");
    out(nextTasks(m.plan, doneArg ? doneArg.split(",") : []));
  } else if (cmd === "sprint-waves") {
    const file = requireArg(rest, 0, "sprint-waves <backlog.md>: missing file path", fail);
    const content = await readFile(file, "utf8");
    const r = computeSprintWaves(content);
    out(r);
    if (!r.ok) process.exit(2);
  } else if (cmd === "tally") {
    const file = requireArg(rest, 0, "tally <verdicts.json>: missing file path", fail);
    out(tallyReview(JSON.parse(await readFile(file, "utf8"))));
  } else if (cmd === "pick") {
    const file = requireArg(rest, 0, "pick <candidates.json>: missing file path", fail);
    out(pickWinner(JSON.parse(await readFile(file, "utf8"))));
  } else if (cmd === "fuse") {
    const candidatesFile = requireArg(rest, 0, "fuse <candidates.json> <fusion-map.json>: missing candidates file path", fail);
    const mapFile = requireArg(rest, 1, "fuse <candidates.json> <fusion-map.json>: missing fusion-map file path", fail);
    const candidates = JSON.parse(await readFile(candidatesFile, "utf8"));
    const map = JSON.parse(await readFile(mapFile, "utf8"));
    out(fuse(candidates, map));
  } else if (cmd === "advise") {
    const file = requireArg(rest, 0, "advise <advice-request.json>: missing file path", fail);
    const req = JSON.parse(await readFile(file, "utf8"));
    const v = validateAdviceRequest(req);
    if (!v.ok) fail(v.errors.join("\n"));
    out({ advisorModel: modelForRole("advisor"), request: req });
  } else if (cmd === "vendor") {
    const manifestUrl = new URL("../vendor/manifest.yaml", import.meta.url);
    const manifest = parseYaml(await readFile(manifestUrl, "utf8"));
    const v = validateVendorManifest(manifest);
    if (!v.ok) { process.stderr.write(`muster: ${v.errors.join("\n")}\n`); process.exit(2); }
    const repoRoot = dirFromImportMeta(import.meta.url, "../");
    const res = await runVendor({ repoRoot, manifest });
    res.warnings.forEach(w => process.stderr.write(`warn: ${w}\n`));
    out({ vendored: res.count, warnings: res.warnings.length });
  } else if (cmd === "setup") {
    out(await scaffoldProject(rest[0] || process.cwd()));
  } else if (cmd === "plan-checklist") {
    const file = requireArg(rest, 0, "plan-checklist <manifest.json> [--done a,b]: missing file path", fail);
    const m = JSON.parse(await readFile(file, "utf8"));
    const doneArg = flagValue(rest, "--done");
    const done = doneArg ? doneArg.split(",") : [];
    process.stdout.write(renderPlanChecklist(m.plan || [], done) + "\n");
  } else if (cmd === "score") {
    const file = requireArg(rest, 0, "score <file.json>: missing file path ({scores, gate})", fail);
    const { scores, gate } = JSON.parse(await readFile(file, "utf8"));
    out(scoreArtifact(scores, gate));
  } else if (cmd === "prompt") {
    const sub = rest[0];
    if (sub === "lint" && rest.includes("--chat")) {
      // lintlang H7: lint a chat-format prompt (array of {role, content}) for role-ordering hygiene.
      const file = flagValue(rest, "--chat");
      const messages = JSON.parse(file ? await readFile(file, "utf8") : await readStdin());
      out(lintChat(messages));
    } else if (sub === "lint" && rest.includes("--workflow")) {
      // lintlang H4: lint a workflow (array of sibling prompts) for shared-state context-boundary erosion.
      const file = flagValue(rest, "--workflow");
      const prompts = JSON.parse(file ? await readFile(file, "utf8") : await readStdin());
      out(lintWorkflow(prompts));
    } else if (sub === "lint" || sub === "variations") {
      const text = await readText(rest[1]);
      const ctx = { isAgent: rest.includes("--agent"), hasTools: rest.includes("--tools") };
      // --system lints in the instruction/system genre (matches `prompt scan` for prompt
      // docs); --task forces the single-task rubric. Default is task.
      if (rest.includes("--system")) ctx.genre = "system";
      else if (rest.includes("--task")) ctx.genre = "task";
      // --tool-schema <file>: pass the real tool schemas so the schema↔intent rule (LINT-SCHEMA-003)
      // can check the prompt references each tool + its required fields (bare --tools stays a boolean).
      const schemaFile = flagValue(rest, "--tool-schema");
      if (schemaFile) {
        const parsed = JSON.parse(await readFile(schemaFile, "utf8"));
        ctx.tools = Array.isArray(parsed) ? parsed : parsed.tools;
        ctx.isAgent = true;
      }
      out(sub === "lint" ? lintPrompt(text, ctx) : proposeVariations(text, ctx));
    } else if (sub === "eval") {
      const file = requireArg(rest, 1, "prompt eval <suite.json>: missing suite ({dataset:[{output,format?,graderResponse?}], passThreshold?})", fail);
      const suite = JSON.parse(await readFile(file, "utf8"));
      out(gradeCollected(suite));
    } else if (sub === "optimize") {
      const file = requireArg(rest, 1, "prompt optimize <file.json>: missing file ({candidates:[{id,prompt?,total,passing}]})", fail);
      const { candidates } = JSON.parse(await readFile(file, "utf8"));
      out(selectWinner(candidates));
    } else if (sub === "scan") {
      out(await scanRepoPrompts(rest[1] || process.cwd()));
    } else {
      fail("prompt <lint|variations|eval|optimize|scan> [file|dir|-] [--agent] [--tools] [--tool-schema <f>] [--chat <f>] [--workflow <f>]");
    }
  } else if (cmd === "humanize-score") {
    // Deterministic 0-100 AI-tell score for human-facing text — the CI-gateable measure behind
    // the LLM humanizer. Reads a file path or capped stdin (shared readText helper).
    const text = await readText(rest[0]);
    const threshold = Number(flagValue(rest, "--threshold")) || undefined;
    out(scoreHumanness(text, threshold ? { threshold } : {}));
  } else if (cmd === "prioritize") {
    const file = requireArg(rest, 0, "prioritize <file> [--model rice|ice|wsjf|weighted]: missing file", fail);
    const parsed = JSON.parse(await readFile(file, "utf8"));
    const items = Array.isArray(parsed) ? parsed : parsed.items;
    const model = flagValue(rest, "--model") || (Array.isArray(parsed) ? "rice" : (parsed.model || "rice"));
    out(prioritize(items, model));
  } else if (cmd === "pipeline") {
    if (!rest[0]) fail("pipeline <domain|id>: missing arg");
    const ps = await loadPipelines(new URL("../pipelines/", import.meta.url));
    out(pipelineForDomain(ps, rest[0]) || ps.find(p => p.id === rest[0]) || null);
  } else if (cmd === "domain") {
    const { override, outcome } = parseDomainArgs(rest);
    if (!outcome) fail("domain <outcome> [--domain x]: missing outcome");
    out(classifyDomain(outcome, await detectProject(process.cwd()), override));
  } else if (cmd === "route") {
    if (!rest[0]) fail("route <outcome>: missing outcome");
    const outcome = rest.join(" ");
    const ps = await loadPipelines(new URL("../pipelines/", import.meta.url));
    const { domain } = classifyDomain(outcome, await detectProject(process.cwd()));
    const p = routePipeline(ps, outcome, domain);
    out({ domain, pipeline: p ? p.id : null });
  } else if (cmd === "diagnose") {
    const ci = rest.includes("--ci");
    let input;
    if (ci) {
      const ciFile = flagValue(rest, "--ci");
      if (!ciFile) fail("diagnose --ci <file>: missing file");
      input = await readFile(ciFile, "utf8");
    } else input = rest.join(" ");
    if (!input || !input.trim()) fail("diagnose <symptom> | --ci <file>: missing input");
    const failure = classifyFailure(input, { ci });
    const caps = resolveCapabilities(await loadCatalog(CATALOG_DIR), await readInstalled(homedir()));
    out({ mode: failure.mode, manifest: buildDiagnoseManifest(failure, caps) });
  } else if (cmd === "audit") {
    const caps = resolveCapabilities(await loadCatalog(CATALOG_DIR), await readInstalled(homedir()));
    // Use the lightweight package.json-only check, not detectProject — audit must not
    // incur git spawns (it stays offline for CI / the MCP wrapper).
    const prompting = await hasPromptingSignal(rest[0] || process.cwd());
    out(buildAuditManifest(caps, { prompting }));
  } else if (cmd === "issue") {
    if (!rest[0]) fail("issue <ref>: missing #N | number | issue-url");
    if (parseIssueRef(rest[0]).kind !== "issue") fail("not a GitHub issue reference: " + rest[0]);
    out(await resolveIssue(rest[0]));
  } else if (cmd === "assess") {
    if (!rest[0]) fail("assess <outcome>: missing outcome");
    out(assessOutcome(rest[0]));
  } else if (cmd === "steer") {
    if (!rest[0]) fail("steer <message>: missing message");
    out(classifySteer(rest.join(" ")));
  } else if (cmd === "doctor") {
    const r = await runDoctor({ root: new URL("../", import.meta.url) });
    out(r);
    if (!r.ok) process.exit(2);
  } else if (cmd === "scratchpad") {
    if (!rest[0]) fail("scratchpad <runId> [dir]: missing runId");
    out(await initScratchpad(rest[1] || ".muster", rest[0]));
  } else if (cmd === "profile") {
    out(await readProfile());
  } else if (cmd === "install") {
    out(await runInstall({ home: rest[0] || homedir() }));
  } else if (cmd === "uninstall") {
    out(await runUninstall({ home: rest[0] || homedir() }));
  } else if (cmd === "signals") {
    const dir = rest[0] || process.cwd();
    const profile = await detectProject(dir);
    const caps = resolveCapabilities(await loadCatalog(CATALOG_DIR), await readInstalled(homedir()));
    const sig = buildSignals(profile, caps);
    await mkdir(".muster", { recursive: true });
    await writeFile(".muster/signals.json", JSON.stringify(sig, null, 2));
    out(sig);
  } else {
    fail(`unknown command: ${[cmd, ...rest].join(" ")}\nUsage: muster <detect|capabilities [--cowork]|match <task>|manifest validate <file>|wave <file>|next <manifest.json> [--done a,b]|sprint-waves <backlog.md>|tally <file>|pick <file>|fuse <candidates.json> <fusion-map.json>|advise <advice-request.json>|memory read|write ...|vendor|setup [dir]|plan-checklist <file>|domain <outcome>|pipeline <domain|id>|route <outcome>|score <file>|prompt <lint|variations|eval|optimize|scan> [file|dir]|humanize-score <file>|prioritize <file> [--model rice|ice|wsjf|weighted]|diagnose <symptom>|--ci <file>|audit|issue <ref>|assess <outcome>|steer <message>|doctor|scratchpad <runId>|profile|install [home]|uninstall [home]|signals [dir]>`);
  }
} catch (e) {
  fail(formatError(e));
}
}

// cli.js is the bin entry — run it. Pure helpers live in cli-args.js so tests
// never need to import this file (which would trigger dispatch).
await main();
