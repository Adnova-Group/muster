// Upstream watch: for every merge-tracked source in vendor/manifest.yaml (src/vendor-sync.js),
// find upstream's newest release tag, or the default-branch HEAD for an untagged source, and
// decide from the GitHub REST API whether any file muster tracks (the items' `from` paths)
// changed since the pin. Used by `muster vendor outdated` and by the weekly upstream-watch
// workflow (scripts/upstream-watch.mjs), which then runs `muster vendor report` on the
// sources that changed.
//
// Cost per repository, deduplicated across sources that share one, with bounded concurrency:
//   1 call   newest release (`releases/latest`, falling back to `tags`) or HEAD (`commits/HEAD`)
//   0 more   when that is still the pin
//   1 call   the recursive tree of the newer ref; each tracked path's blob SHA is compared with
//            the item's recorded baseBlob, so no file content is downloaded. A truncated tree
//            falls back to one `compare` call.
// A repository rename (the API answers with a redirect) costs one more call to learn the new name.
//
// Rate limits: a primary limit (x-ratelimit-remaining: 0) stops every further request and marks
// the sources not yet checked `rate-limited`; a short secondary limit (retry-after) is waited out
// once. `fetch` and `sleep` are injectable, so the logic is tested without the network.
import { DESCRIBE_RE, TAG_RE, isDescribePin, isSyncSource, syncItemsOf, tagNewer } from "./vendor-sync.js";

const API = "https://api.github.com";
const SHA40_RE = /^[0-9a-f]{40}$/;
const MAX_RETRY_AFTER_S = 60;
// A compare response lists at most 300 files for the whole comparison.
const COMPARE_FILE_CAP = 300;

export class RateLimitError extends Error {
  constructor(resetAt) {
    super(`GitHub API rate limit reached${resetAt ? ` (resets ${resetAt})` : ""}`);
    this.resetAt = resetAt;
  }
}

// A minimal GitHub REST client. Once the primary rate limit is hit it makes no further
// requests. Returns { status, data, redirected } for 2xx and 404; throws otherwise.
export function githubClient({ fetch = globalThis.fetch, token, sleep = ms => new Promise(r => setTimeout(r, ms)), api = API } = {}) {
  const state = { requests: 0, limited: null };
  async function request(method, path, { body, accept = "application/vnd.github+json" } = {}) {
    for (let attempt = 0; ; attempt++) {
      if (state.limited) throw new RateLimitError(state.limited.resetAt);
      state.requests++;
      const headers = { accept, "x-github-api-version": "2022-11-28", "user-agent": "muster-upstream-watch" };
      if (token) headers.authorization = `Bearer ${token}`;
      if (body !== undefined) headers["content-type"] = "application/json";
      const res = await fetch(`${api}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const header = name => res.headers?.get?.(name) ?? null;
      if (res.status === 403 || res.status === 429) {
        const retryAfter = Number(header("retry-after"));
        if (header("x-ratelimit-remaining") === "0") {
          const reset = Number(header("x-ratelimit-reset"));
          state.limited = { resetAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null };
          throw new RateLimitError(state.limited.resetAt);
        }
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
          if (attempt === 0 && retryAfter <= MAX_RETRY_AFTER_S) { await sleep(retryAfter * 1000); continue; }
          state.limited = { resetAt: null };
          throw new RateLimitError(null);
        }
      }
      if (res.status === 404) return { status: 404, data: null, redirected: Boolean(res.redirected) };
      if (res.status < 200 || res.status >= 300) throw new Error(`${method} ${path}: HTTP ${res.status}`);
      const text = await res.text();
      const data = accept.includes("json") ? (text ? JSON.parse(text) : null) : text.trim();
      return { status: res.status, data, redirected: Boolean(res.redirected) };
    }
  }
  return {
    state,
    get: (path, opts) => request("GET", path, opts),
    post: (path, body) => request("POST", path, { body }),
    patch: (path, body) => request("PATCH", path, { body })
  };
}

const repoPath = repo => `/repos/${String(repo).split("/").map(encodeURIComponent).join("/")}`;
const isStableTag = tag => TAG_RE.test(tag) && !/-/.test(tag.replace(/^v/, ""));

export function pinKind(source) {
  if (source.tag === null) return "untagged";
  return isDescribePin(source) ? "describe" : "release";
}

// The release a pin is compared against: the tag itself, or a describe pin's base release.
const pinRelease = source => (isDescribePin(source) ? String(source.tag).match(DESCRIBE_RE)[1] : source.tag);

// Upstream's newest ref for this kind of pin: { kind: "head"|"release"|"none", ref, redirected }
// or { missing: true } when the repository is gone (404).
async function newestRef(client, repo, untagged) {
  if (untagged) {
    const res = await client.get(`${repoPath(repo)}/commits/HEAD`, { accept: "application/vnd.github.sha" });
    if (res.status === 404) return { missing: true };
    if (!SHA40_RE.test(res.data)) throw new Error(`unexpected HEAD from ${repo}: ${String(res.data).slice(0, 60)}`);
    return { kind: "head", ref: res.data, redirected: res.redirected };
  }
  const latest = await client.get(`${repoPath(repo)}/releases/latest`);
  if (latest.status !== 404 && isStableTag(String(latest.data?.tag_name)))
    return { kind: "release", ref: latest.data.tag_name, redirected: latest.redirected };
  // No (usable) GitHub release: fall back to the highest stable tag.
  const tags = await client.get(`${repoPath(repo)}/tags?per_page=100`);
  if (tags.status === 404) return { missing: true };
  const names = (tags.data || []).map(t => t?.name).filter(n => typeof n === "string" && isStableTag(n));
  const best = names.reduce((a, b) => (a === null || tagNewer(b, a) ? b : a), null);
  return best ? { kind: "release", ref: best, redirected: latest.redirected || tags.redirected } : { kind: "none", ref: null, redirected: tags.redirected };
}

// Map of path -> blob SHA at `ref`, or null when the tree is truncated.
async function treeBlobs(client, repo, ref) {
  const res = await client.get(`${repoPath(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  if (res.status === 404) throw new Error(`tree ${ref} not found in ${repo}`);
  if (res.data?.truncated) return null;
  return new Map((res.data?.tree || []).filter(e => e.type === "blob").map(e => [e.path, e.sha]));
}

// Files changed between the pin and `ref` per `compare`: a Set, or null when the list is capped.
async function comparedFiles(client, repo, from, ref) {
  const res = await client.get(`${repoPath(repo)}/compare/${from}...${encodeURIComponent(ref)}?per_page=1`);
  if (res.status === 404) throw new Error(`compare ${from}...${ref} not found in ${repo}`);
  const files = res.data?.files || [];
  if (files.length >= COMPARE_FILE_CAP) return null;
  return new Set(files.flatMap(f => [f.filename, f.previous_filename].filter(Boolean)));
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// Check every merge-tracked source (or only the ids in `only`). Never throws for one source:
// each result carries a status.
//   current      the pin is upstream's newest release / HEAD (or newer)
//   unchanged    upstream moved, but every tracked file still has its pinned blob
//   changed      at least one tracked file was modified or removed (`changed`)
//   no-release   a tagged pin, but upstream publishes no release tag
//   unreachable  the repository is gone or private (404)
//   rate-limited not checked: the API rate limit was reached
//   error        anything else (`note`)
// `renamedTo` is set when the API redirected to a renamed repository.
export async function checkUpstreams({ manifest, fetch, token, sleep, concurrency = 4, only, client } = {}) {
  client ||= githubClient({ fetch, token, sleep });
  const sources = (manifest?.sources || []).filter(isSyncSource).filter(s => !only?.length || only.includes(s.id));
  const memo = new Map();
  const once = (key, fn) => { if (!memo.has(key)) memo.set(key, fn()); return memo.get(key); };
  const results = await pool(sources, concurrency, async source => {
    const items = syncItemsOf(source);
    const tracked = items.filter((i, n) => items.findIndex(j => j.from === i.from) === n);
    const base = { id: source.id, repo: source.repo, pin: { kind: pinKind(source), tag: source.tag, ref: source.ref }, tracked: tracked.length, upstream: null, changed: [] };
    try {
      const untagged = source.tag === null;
      const newest = await once(`newest\0${source.repo}\0${untagged}`, () => newestRef(client, source.repo, untagged));
      if (newest.missing) return { ...base, status: "unreachable", note: `${source.repo} answered 404 (deleted, renamed away or private)` };
      if (newest.redirected) {
        const info = await once(`repo\0${source.repo}`, () => client.get(repoPath(source.repo)));
        const name = info.data?.full_name;
        if (name && name.toLowerCase() !== String(source.repo).toLowerCase()) base.renamedTo = name;
      }
      if (newest.kind === "none") return { ...base, status: "no-release", note: `${source.repo} publishes no release tag` };
      base.upstream = { kind: newest.kind, ref: newest.ref };
      const moved = untagged ? newest.ref !== source.ref : tagNewer(newest.ref, pinRelease(source));
      if (!moved) return { ...base, status: "current" };
      const blobs = await once(`tree\0${source.repo}\0${newest.ref}`, () => treeBlobs(client, source.repo, newest.ref));
      if (blobs) {
        base.changed = tracked.filter(i => blobs.get(i.from) !== i.baseBlob)
          .map(i => ({ from: i.from, mode: i.mode, to: i.to ?? null, change: blobs.has(i.from) ? "modified" : "removed" }));
      } else {
        const files = await once(`compare\0${source.repo}\0${source.ref}\0${newest.ref}`, () => comparedFiles(client, source.repo, source.ref, newest.ref));
        base.changed = tracked.filter(i => files === null || files.has(i.from))
          .map(i => ({ from: i.from, mode: i.mode, to: i.to ?? null, change: files === null ? "unknown" : "modified" }));
        if (files === null) base.note = "tree truncated and compare capped at 300 files: every tracked file is listed; the report is authoritative";
      }
      return { ...base, status: base.changed.length ? "changed" : "unchanged" };
    } catch (error) {
      if (error instanceof RateLimitError) return { ...base, status: "rate-limited", note: error.message };
      return { ...base, status: "error", note: error.message };
    }
  });
  return { sources: results, requests: client.state.requests, rateLimit: client.state.limited };
}

// Offline listing for `muster vendor outdated --offline`: the pins alone.
export function listPins(manifest) {
  return (manifest?.sources || []).filter(isSyncSource).map(source => ({
    id: source.id, repo: source.repo,
    pin: { kind: pinKind(source), tag: source.tag, ref: source.ref },
    tracked: new Set(syncItemsOf(source).map(i => i.from)).size
  }));
}

// The `--to` argument for `muster vendor report`: a release tag or a 40-hex commit, checked
// again here because the value came from the network.
export function reportTarget(result) {
  const ref = result.upstream?.ref;
  return typeof ref === "string" && (TAG_RE.test(ref) || SHA40_RE.test(ref)) ? ref : null;
}

export function compareUrl(result) {
  const target = reportTarget(result);
  return target ? `https://github.com/${result.renamedTo || result.repo}/compare/${result.pin.ref}...${target}` : null;
}

const short = ref => (SHA40_RE.test(String(ref)) ? String(ref).slice(0, 12) : String(ref));
const pinText = r => (r.pin.tag === null ? `\`${short(r.pin.ref)}\` (untagged)` : `\`${r.pin.tag}\``);
const ISSUE_BODY_LIMIT = 60_000;

// The rolling issue. `reports` maps a source id to { path, touched, items, text } (or { error }),
// `artifactUrl` links the uploaded report files, `runUrl` the workflow run.
export function renderIssue({ results, reports = {}, artifactUrl, runUrl }) {
  const changed = results.filter(r => r.status === "changed");
  const ATTENTION = ["unreachable", "rate-limited", "error", "no-release"];
  const attention = results.filter(r => r.renamedTo || ATTENTION.includes(r.status));
  const quiet = results.filter(r => ["current", "unchanged"].includes(r.status) && !r.renamedTo);
  const title = changed.length
    ? `Upstream watch: ${changed.length} source${changed.length === 1 ? "" : "s"} changed tracked files`
    : "Upstream watch: no tracked-file changes";
  const head = [
    "Weekly upstream watch over every merge-tracked source in `vendor/manifest.yaml`. Tracked files are",
    "compared by blob SHA with each item's recorded `baseBlob`. For each changed source, read its report,",
    "then run `muster vendor update <source> --to <ref> --dry-run` and the real update from a source checkout.",
    ""
  ];
  if (runUrl) head.push(`Run: ${runUrl}${artifactUrl ? ` · reports: ${artifactUrl}` : ""}`, "");
  const table = changed.length
    ? ["| Source | Pin | Upstream | Changed tracked files | Report |", "| --- | --- | --- | --- | --- |",
      ...changed.map(r => {
        const rep = reports[r.id];
        const link = rep?.path ? (artifactUrl ? `[${rep.path}](${artifactUrl})` : `\`${rep.path}\``) : rep?.error ? `failed: ${rep.error}` : "-";
        const cmp = compareUrl(r);
        return `| [${r.id}](#${r.id}) | ${pinText(r)} | ${cmp ? `[\`${short(r.upstream.ref)}\`](${cmp})` : `\`${short(r.upstream?.ref)}\``} | ${r.changed.length} of ${r.tracked} | ${link} |`;
      }), ""]
    : [attention.some(r => ["rate-limited", "error"].includes(r.status))
      ? "No checked source changed a tracked file since its pin; the sources below were not fully checked."
      : "No merge-tracked source changed a tracked file since its pin.", ""];
  // Rate-limited sources share one cause: one line, not one per source.
  const limited = attention.filter(r => r.status === "rate-limited" && !r.renamedTo);
  const lines = attention.filter(r => !limited.includes(r)).map(r => `- **${r.id}** (${r.repo}): ${r.renamedTo ? `renamed to \`${r.renamedTo}\`; update \`repo:\` in vendor/manifest.yaml. ` : ""}${ATTENTION.includes(r.status) ? `${r.status}${r.note ? `: ${r.note}` : ""}` : ""}`.trim());
  if (limited.length) lines.push(`- **${limited.length} source(s) not checked**, ${limited[0].note}: ${limited.map(r => r.id).join(", ")}`);
  const needs = lines.length ? ["### Needs attention", "", ...lines, ""] : [];
  const tail = [`<sub>${quiet.length} source(s) current or without tracked changes: ${quiet.map(r => r.id).join(", ") || "none"}.</sub>`];
  let body = [...head, ...table, ...needs].join("\n");
  const sections = changed.map(r => {
    const files = r.changed.map(c => `- \`${c.from}\` ${c.change}${c.to ? ` -> \`${c.to}\`` : ""} (${c.mode})`).join("\n");
    const cmd = `muster vendor update ${r.id} --to ${reportTarget(r) ?? "<ref>"} --dry-run`;
    return { r, text: `<a id="${r.id}"></a>\n### ${r.id}\n\n${r.note ? `${r.note}\n\n` : ""}${files}\n\nNext: \`${cmd}\`\n` };
  });
  const budget = ISSUE_BODY_LIMIT - body.length - tail.join("\n").length - 200;
  let used = 0;
  const per = [];
  for (const { r, text } of sections) {
    let block = text;
    const rep = reports[r.id];
    if (rep?.text) {
      const details = `\n<details><summary>Report: ${rep.touched ?? "?"} of ${rep.items ?? "?"} item(s) touched</summary>\n\n${rep.text}\n\n</details>\n`;
      if (used + block.length + details.length <= budget) block += details;
      else block += "\n_Report omitted for length: see the reports artifact._\n";
    }
    if (used + block.length > budget) { per.push(`\n_${sections.length - per.length} more source section(s) omitted for length._\n`); break; }
    used += block.length;
    per.push(block);
  }
  body = [body, ...per, "", ...tail].join("\n");
  return { title, body, changed: changed.length, incomplete: results.some(r => ["rate-limited", "error"].includes(r.status)) };
}
