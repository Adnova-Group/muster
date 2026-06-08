#!/usr/bin/env node
import { detectProject } from "./detect.js";
import { loadCatalog } from "./catalog.js";
import { readInstalled } from "./harness.js";
import { resolveCapabilities } from "./capabilities.js";
import { validateManifest } from "./manifest.js";
import { writeMemory, readMemory } from "./memory.js";
import { computeWaves } from "./wave.js";
import { tallyReview } from "./review.js";
import { pickWinner } from "./tournament.js";
import { homedir } from "node:os";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { runDoctor } from "./doctor.js";
import { initScratchpad } from "./scratchpad.js";
import { readProfile } from "./profile.js";
import { buildSignals } from "./signals.js";
import { validateManifest as validateVendorManifest, runVendor } from "./vendor.js";
import { parse as parseYaml } from "yaml";
import { scaffoldProject } from "./setup.js";
import { renderPlanChecklist } from "./checklist.js";
import { classifyDomain } from "./domain.js";
import { loadPipelines, pipelineForDomain, routePipeline } from "./pipeline.js";
import { scoreArtifact } from "./score.js";
import { classifyFailure, buildDiagnoseManifest } from "./diagnose.js";
import { runInstall } from "./install.js";
import { assessOutcome } from "./interview.js";
import { parseDomainArgs, formatError } from "./cli-args.js";
import { matchProviders } from "./match.js";
import { prioritize } from "./prioritize.js";
import { parseIssueRef, resolveIssue } from "./issue.js";

const CATALOG_DIR = new URL("../catalog/", import.meta.url);

function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + "\n"); }
function fail(msg) { process.stderr.write(`muster: ${msg}\n`); process.exit(1); }

async function main() {
const [cmd, ...rest] = process.argv.slice(2);

try {
  if (cmd === "detect") {
    out(await detectProject(rest[0] || process.cwd()));
  } else if (cmd === "capabilities") {
    const catalog = await loadCatalog(CATALOG_DIR);
    out(resolveCapabilities(catalog, await readInstalled(rest[0] || homedir())));
  } else if (cmd === "match") {
    if (!rest[0]) fail("match <task>: missing task");
    const catalog = await loadCatalog(CATALOG_DIR);
    out(matchProviders(rest[0], catalog, await readInstalled(homedir())));
  } else if (cmd === "manifest" && rest[0] === "validate") {
    if (!rest[1]) fail("manifest validate <file>: missing file path");
    const obj = JSON.parse(await readFile(rest[1], "utf8"));
    const r = validateManifest(obj);
    out(r);
    if (!r.ok) process.exit(2);
  } else if (cmd === "memory" && rest[0] === "write") {
    if (!rest[1] || !rest[2]) fail("memory write <dir> <entry.json>: missing args");
    const dir = rest[1]; const entry = JSON.parse(await readFile(rest[2], "utf8"));
    await writeMemory(dir, entry); out({ ok: true });
  } else if (cmd === "memory" && rest[0] === "read") {
    if (!rest[1]) fail("memory read <dir> [query]: missing dir");
    out(await readMemory(rest[1], rest[2] || ""));
  } else if (cmd === "wave") {
    if (!rest[0]) fail("wave <manifest.json>: missing file path");
    const m = JSON.parse(await readFile(rest[0], "utf8"));
    if (!Array.isArray(m.plan)) fail("wave: manifest has no 'plan' array");
    out(computeWaves(m.plan));
  } else if (cmd === "tally") {
    if (!rest[0]) fail("tally <verdicts.json>: missing file path");
    out(tallyReview(JSON.parse(await readFile(rest[0], "utf8"))));
  } else if (cmd === "pick") {
    if (!rest[0]) fail("pick <candidates.json>: missing file path");
    out(pickWinner(JSON.parse(await readFile(rest[0], "utf8"))));
  } else if (cmd === "vendor") {
    const manifestUrl = new URL("../vendor/manifest.yaml", import.meta.url);
    const manifest = parseYaml(await readFile(manifestUrl, "utf8"));
    const v = validateVendorManifest(manifest);
    if (!v.ok) { v.errors.forEach(e => process.stderr.write(`manifest: ${e}\n`)); process.exit(2); }
    const repoRoot = new URL("../", import.meta.url).pathname;
    const res = await runVendor({ repoRoot, manifest });
    res.warnings.forEach(w => process.stderr.write(`warn: ${w}\n`));
    out({ vendored: res.count, warnings: res.warnings.length });
  } else if (cmd === "setup") {
    out(await scaffoldProject(rest[0] || process.cwd()));
  } else if (cmd === "plan-checklist") {
    if (!rest[0]) fail("plan-checklist <manifest.json> [--done a,b]: missing file path");
    const m = JSON.parse(await readFile(rest[0], "utf8"));
    const di = rest.indexOf("--done");
    const done = di >= 0 && rest[di + 1] ? rest[di + 1].split(",") : [];
    process.stdout.write(renderPlanChecklist(m.plan || [], done) + "\n");
  } else if (cmd === "score") {
    if (!rest[0]) fail("score <file.json>: missing file path ({scores, gate})");
    const { scores, gate } = JSON.parse(await readFile(rest[0], "utf8"));
    out(scoreArtifact(scores, gate));
  } else if (cmd === "prioritize") {
    if (!rest[0]) fail("prioritize <file> [--model rice]: missing file");
    const parsed = JSON.parse(await readFile(rest[0], "utf8"));
    const items = Array.isArray(parsed) ? parsed : parsed.items;
    const mi = rest.indexOf("--model");
    const model = (mi >= 0 && rest[mi + 1]) ? rest[mi + 1] : (Array.isArray(parsed) ? "rice" : (parsed.model || "rice"));
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
    const ciIdx = rest.indexOf("--ci");
    let input, ci = false;
    if (ciIdx >= 0) { ci = true; if (!rest[ciIdx + 1]) fail("diagnose --ci <file>: missing file"); input = await readFile(rest[ciIdx + 1], "utf8"); }
    else input = rest.join(" ");
    if (!input || !input.trim()) fail("diagnose <symptom> | --ci <file>: missing input");
    const failure = classifyFailure(input, { ci });
    const caps = resolveCapabilities(await loadCatalog(CATALOG_DIR), await readInstalled(homedir()));
    out({ mode: failure.mode, manifest: buildDiagnoseManifest(failure, caps) });
  } else if (cmd === "issue") {
    if (!rest[0]) fail("issue <ref>: missing #N | number | issue-url");
    if (parseIssueRef(rest[0]).kind !== "issue") fail("not a GitHub issue reference: " + rest[0]);
    out(await resolveIssue(rest[0]));
  } else if (cmd === "assess") {
    if (!rest[0]) fail("assess <outcome>: missing outcome");
    out(assessOutcome(rest[0]));
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
  } else if (cmd === "signals") {
    const dir = rest[0] || process.cwd();
    const profile = await detectProject(dir);
    const caps = resolveCapabilities(await loadCatalog(CATALOG_DIR), await readInstalled(homedir()));
    const sig = buildSignals(profile, caps);
    await mkdir(".muster", { recursive: true });
    await writeFile(".muster/signals.json", JSON.stringify(sig, null, 2));
    out(sig);
  } else {
    fail(`unknown command: ${[cmd, ...rest].join(" ")}\nUsage: muster <detect|capabilities|match <task>|manifest validate <file>|wave <file>|tally <file>|pick <file>|memory read|write ...|vendor|setup [dir]|plan-checklist <file>|domain <outcome>|pipeline <domain|id>|route <outcome>|score <file>|prioritize <file> [--model rice]|diagnose <symptom>|--ci <file>|issue <ref>|assess <outcome>|doctor|scratchpad <runId>|profile|install [home]|signals [dir]>`);
  }
} catch (e) {
  fail(formatError(e));
}
}

// cli.js is the bin entry — run it. Pure helpers live in cli-args.js so tests
// never need to import this file (which would trigger dispatch).
await main();
