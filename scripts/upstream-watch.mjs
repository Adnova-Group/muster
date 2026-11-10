#!/usr/bin/env node
// Driver for .github/workflows/upstream-watch.yml. The decision logic lives in
// src/upstream-watch.js (also behind `muster vendor outdated`); this script adds the two
// workflow steps around it, each with injectable seams so test/upstream-watch.test.js runs
// them without the network:
//
//   node scripts/upstream-watch.mjs check --out watch.json
//       checks every merge-tracked source, then runs `muster vendor report <source> --to <ref>`
//       for each source with tracked-file changes (writing vendor/reports/*.md)
//   node scripts/upstream-watch.mjs issue --in watch.json [--artifact-url <url>] [--dry-run]
//       opens, updates or closes the ONE rolling issue labelled upstream-watch
//
// It never edits tracked files: merging an upstream is `muster vendor update`, run by a person.
// Environment: GITHUB_TOKEN (or GH_TOKEN), GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID.
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { checkUpstreams, githubClient, renderIssue, reportTarget } from "../src/upstream-watch.js";

const pexec = promisify(execFile);
const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const LABEL = "upstream-watch";

// `muster vendor report` for one source; returns its JSON summary plus the report text.
export async function defaultRunReport(id, ref, { root = ROOT, exec = pexec } = {}) {
  const { stdout } = await exec(process.execPath, [join(root, "src/cli.js"), "vendor", "report", id, "--to", ref], { cwd: root, maxBuffer: 16 << 20 });
  const summary = JSON.parse(stdout);
  return { ...summary, text: await readFile(join(root, summary.path), "utf8") };
}

// Reports for the changed sources, one at a time (each is a blobless clone). A failure is
// recorded for that source and never stops the others.
export async function runReports(results, { runReport = defaultRunReport } = {}) {
  const reports = {};
  for (const r of results.filter(x => x.status === "changed")) {
    const ref = reportTarget(r);
    if (!ref) { reports[r.id] = { error: "upstream ref failed validation" }; continue; }
    try {
      const { path, touched, items, text } = await runReport(r.id, ref);
      reports[r.id] = { path, touched, items, text };
    } catch (error) {
      reports[r.id] = { error: String(error.stderr || error.message).trim().split("\n").pop().slice(0, 200) };
    }
  }
  return reports;
}

// Open, update or close the single open issue carrying LABEL (the gsd-only watcher's issue
// used the same label, so it is adopted rather than duplicated).
// An incomplete run (rate limit, errors) with no changes found proves nothing: it never closes.
export async function upsertIssue({ client, repo, title, body, changed, incomplete = false }) {
  const base = `/repos/${repo}`;
  const open = await client.get(`${base}/issues?labels=${LABEL}&state=open&per_page=20`);
  const existing = (open.data || []).filter(i => !i.pull_request).sort((a, b) => a.number - b.number)[0];
  if (!changed) {
    if (!existing) return { action: "none" };
    if (incomplete) return { action: "kept", number: existing.number };
    await client.patch(`${base}/issues/${existing.number}`, { title, body, state: "closed", state_reason: "completed" });
    return { action: "closed", number: existing.number };
  }
  if (existing) {
    await client.patch(`${base}/issues/${existing.number}`, { title, body });
    return { action: "updated", number: existing.number };
  }
  try { await client.post(`${base}/labels`, { name: LABEL, color: "BFD4F2", description: "Upstream release touches vendored files" }); }
  catch { /* 422: the label exists */ }
  const created = await client.post(`${base}/issues`, { title, body, labels: [LABEL] });
  return { action: "created", number: created.data?.number };
}

const flag = (argv, name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

export async function main(argv = process.argv.slice(2), { env = process.env, fetch = globalThis.fetch, runReport, root = ROOT, log = console.log } = {}) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (argv[0] === "check") {
    const manifest = parseYaml(await readFile(join(root, "vendor/manifest.yaml"), "utf8"));
    const res = await checkUpstreams({ manifest, fetch, token });
    const reports = await runReports(res.sources, { runReport });
    const out = { ...res, reports };
    await writeFile(flag(argv, "--out") || "watch.json", `${JSON.stringify(out, null, 2)}\n`);
    for (const r of res.sources) {
      log(`${r.id.padEnd(30)} ${r.status}${r.changed.length ? ` (${r.changed.length} tracked file(s))` : ""}${r.renamedTo ? ` renamed -> ${r.renamedTo}` : ""}`);
      if (r.status === "changed") log(`::warning::${r.id}: ${r.changed.length} tracked file(s) changed upstream at ${r.upstream.ref}`);
      if (r.renamedTo || ["unreachable", "error"].includes(r.status)) log(`::warning::${r.id}: ${r.renamedTo ? `renamed to ${r.renamedTo}` : `${r.status}: ${r.note}`}`);
    }
    if (res.rateLimit) log(`::warning::GitHub API rate limit reached after ${res.requests} request(s)${res.rateLimit.resetAt ? `; resets ${res.rateLimit.resetAt}` : ""}`);
    log(`${res.requests} API request(s); ${res.sources.filter(r => r.status === "changed").length} source(s) with tracked-file changes`);
    return out;
  }
  if (argv[0] === "issue") {
    const watch = JSON.parse(await readFile(flag(argv, "--in") || "watch.json", "utf8"));
    const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL || "https://github.com"}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
    const { title, body, changed, incomplete } = renderIssue({ results: watch.sources, reports: watch.reports, artifactUrl: flag(argv, "--artifact-url") || undefined, runUrl });
    if (argv.includes("--dry-run")) { log(`${title}\n\n${body}`); return { action: "dry-run", title, body }; }
    if (!env.GITHUB_REPOSITORY) throw new Error("GITHUB_REPOSITORY is not set");
    const res = await upsertIssue({ client: githubClient({ fetch, token }), repo: env.GITHUB_REPOSITORY, title, body, changed, incomplete });
    log(`issue: ${res.action}${res.number ? ` #${res.number}` : ""}`);
    return res;
  }
  throw new Error("usage: upstream-watch.mjs check --out <file> | issue --in <file> [--artifact-url <url>] [--dry-run]");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => { console.error(`upstream-watch: ${error.message}`); process.exit(1); });
}
