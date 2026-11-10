// Upstream watch (src/upstream-watch.js, scripts/upstream-watch.mjs): the decision logic behind
// .github/workflows/upstream-watch.yml and `muster vendor outdated`. Network-free: GitHub is a
// fake fetch over a fixture manifest covering changed and unchanged sources, an untagged source,
// describe pins, a renamed and a deleted repository, and both kinds of rate limit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import { checkUpstreams, githubClient, listPins, renderIssue, reportTarget, compareUrl } from "../src/upstream-watch.js";
import { main, runReports, upsertIssue } from "../scripts/upstream-watch.mjs";

const blob = c => c.repeat(40);
const PIN = { current: blob("1"), changed: blob("2"), quiet: blob("3"), untagged: blob("4"), describe: `abc1234${"0".repeat(33)}`, describe2: `def5678${"0".repeat(33)}`, renamed: blob("5"), gone: blob("6") };
const HEAD = blob("9");
const item = (from, sha, extra = {}) => ({ from, mode: "adapted", to: `plugin/builtins/${from}`, baseBlob: sha, ...extra });
const source = (id, repo, ref, tag, items) => ({ id, kind: "github", repo, ref, tag, license: "MIT", relation: "adapted", items });

const MANIFEST = {
  sources: [
    source("rel-current", "a/current", PIN.current, "v1.2.0", [item("x.md", blob("a"))]),
    source("rel-changed", "a/changed", PIN.changed, "v1.0.0", [
      item("agents/a.md", blob("a")), item("agents/a.md", blob("a"), { mode: "verbatim" }), item("refs/r.md", blob("b")), { from: "gone.md", mode: "watch", baseBlob: blob("c") }
    ]),
    source("rel-unchanged", "a/quiet", PIN.quiet, "v1.0.0", [item("x.md", blob("a"))]),
    source("untagged", "a/untagged", PIN.untagged, null, [item("skills/s/SKILL.md", blob("d")), item("skills/s/ref.md", blob("e"))]),
    source("untagged-twin", "a/untagged", PIN.untagged, null, [item("skills/s/ref.md", blob("e"))]),
    source("describe", "a/describe", PIN.describe, "v3.1.0-2-gabc1234", [item("x.md", blob("a"))]),
    source("describe-newer", "a/describe2", PIN.describe2, "v1.0.0-4-gdef5678", [item("big/x.md", blob("a")), item("big/y.md", blob("b"))]),
    source("renamed", "old/name", PIN.renamed, "v2.0.0", [item("x.md", blob("a"))]),
    source("gone", "gone/repo", PIN.gone, "v1.0.0", [item("x.md", blob("a"))]),
    // Not merge-tracked (no item has a mode): never checked.
    { id: "fetched", kind: "github", repo: "a/fetched", ref: blob("7"), license: "MIT", relation: "vendored", items: [{ id: "y", kind: "agent", from: "y.md" }] }
  ]
};

const tree = entries => ({ truncated: false, tree: Object.entries(entries).map(([path, sha]) => ({ path, type: "blob", sha })) });
const ROUTES = {
  "/repos/a/current/releases/latest": { body: { tag_name: "v1.2.0" } },
  "/repos/a/changed/releases/latest": { body: { tag_name: "v1.1.0" } },
  "/repos/a/changed/git/trees/v1.1.0?recursive=1": { body: tree({ "agents/a.md": blob("f"), "refs/r.md": blob("b"), "other.md": blob("0") }) },
  "/repos/a/quiet/releases/latest": { body: { tag_name: "v2.0.0" } },
  "/repos/a/quiet/git/trees/v2.0.0?recursive=1": { body: tree({ "x.md": blob("a") }) },
  "/repos/a/untagged/commits/HEAD": { text: HEAD },
  [`/repos/a/untagged/git/trees/${HEAD}?recursive=1`]: { body: tree({ "skills/s/SKILL.md": blob("d"), "skills/s/ref.md": blob("8") }) },
  "/repos/a/describe/releases/latest": { body: { tag_name: "v3.1.0" } },
  "/repos/a/describe2/releases/latest": { status: 404 },
  "/repos/a/describe2/tags?per_page=100": { body: [{ name: "v0.9.0" }, { name: "v1.2.0-beta.1" }, { name: "v1.1.0" }, { name: "--upload-pack=x" }] },
  "/repos/a/describe2/git/trees/v1.1.0?recursive=1": { body: { truncated: true, tree: [] } },
  [`/repos/a/describe2/compare/${PIN.describe2}...v1.1.0?per_page=1`]: { body: { files: [{ filename: "big/y.md" }, { filename: "unrelated.md" }] } },
  "/repos/old/name/releases/latest": { body: { tag_name: "v2.0.0" }, redirected: true },
  "/repos/old/name": { body: { full_name: "new/name" }, redirected: true },
  "/repos/gone/repo/releases/latest": { status: 404 },
  "/repos/gone/repo/tags?per_page=100": { status: 404 }
};

function fakeGitHub(routes = ROUTES, { before } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const path = url.replace("https://api.github.com", "");
    calls.push({ path, method: init.method, headers: init.headers, body: init.body && JSON.parse(init.body) });
    const hit = before?.(path, calls.length) ?? routes[path];
    if (!hit) throw new Error(`unrouted ${init.method} ${path}`);
    const headers = new Map(Object.entries(hit.headers || {}));
    return {
      status: hit.status ?? 200, redirected: Boolean(hit.redirected), headers: { get: k => headers.get(k) ?? null },
      text: async () => (hit.text !== undefined ? hit.text : hit.body === undefined ? "" : JSON.stringify(hit.body))
    };
  };
  return { fetch, calls };
}

const byId = res => Object.fromEntries(res.sources.map(r => [r.id, r]));

test("checkUpstreams classifies every merge-tracked source and compares tracked blobs with baseBlob", async () => {
  const gh = fakeGitHub();
  const res = await checkUpstreams({ manifest: MANIFEST, fetch: gh.fetch, token: "t0k" });
  const r = byId(res);
  assert.deepEqual(Object.keys(r), ["rel-current", "rel-changed", "rel-unchanged", "untagged", "untagged-twin", "describe", "describe-newer", "renamed", "gone"], "only merge-tracked sources, in manifest order");
  assert.equal(res.rateLimit, null);

  assert.deepEqual([r["rel-current"].status, r["rel-current"].upstream], ["current", { kind: "release", ref: "v1.2.0" }]);
  assert.equal(r["rel-changed"].status, "changed");
  assert.equal(r["rel-changed"].tracked, 3, "items sharing a from path count once");
  assert.deepEqual(r["rel-changed"].changed, [
    { from: "agents/a.md", mode: "adapted", to: "plugin/builtins/agents/a.md", change: "modified" },
    { from: "gone.md", mode: "watch", to: null, change: "removed" }
  ]);
  assert.deepEqual([r["rel-unchanged"].status, r["rel-unchanged"].changed], ["unchanged", []]);

  assert.deepEqual([r.untagged.status, r.untagged.pin.kind, r.untagged.upstream], ["changed", "untagged", { kind: "head", ref: HEAD }]);
  assert.deepEqual(r.untagged.changed.map(c => c.from), ["skills/s/ref.md"]);
  assert.deepEqual(r["untagged-twin"].changed.map(c => c.from), ["skills/s/ref.md"]);

  assert.deepEqual([r.describe.status, r.describe.pin.kind], ["current", "describe"], "a describe pin past its release is current");
  assert.deepEqual([r["describe-newer"].status, r["describe-newer"].upstream.ref], ["changed", "v1.1.0"], "tags fallback skips prereleases and non-release names");
  assert.deepEqual(r["describe-newer"].changed.map(c => [c.from, c.change]), [["big/y.md", "modified"]], "a truncated tree falls back to compare");

  assert.deepEqual([r.renamed.status, r.renamed.renamedTo], ["current", "new/name"]);
  assert.match(r.gone.status, /^unreachable$/);
  assert.match(r.gone.note, /404/);

  // Cost: one call for a current release pin, two for a changed one, the shared repository once.
  const count = prefix => gh.calls.filter(c => c.path.startsWith(prefix)).length;
  assert.equal(count("/repos/a/current/"), 1);
  assert.equal(count("/repos/a/changed/"), 2);
  assert.equal(count("/repos/a/untagged/"), 2, "two sources on one repository share its calls");
  assert.equal(res.requests, gh.calls.length);
  assert.ok(gh.calls.every(c => c.method === "GET" && c.headers.authorization === "Bearer t0k"));
  assert.equal(gh.calls.find(c => c.path.endsWith("/commits/HEAD")).headers.accept, "application/vnd.github.sha");
});

test("a primary rate limit stops every further request and marks the rest rate-limited", async () => {
  const reset = 1_900_000_000;
  const gh = fakeGitHub(ROUTES, {
    before: (path, n) => (n === 2 ? { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } } : undefined)
  });
  const res = await checkUpstreams({ manifest: MANIFEST, fetch: gh.fetch, concurrency: 1 });
  const r = byId(res);
  assert.equal(r["rel-current"].status, "current");
  assert.deepEqual(res.rateLimit, { resetAt: new Date(reset * 1000).toISOString() });
  for (const id of ["rel-changed", "rel-unchanged", "untagged", "describe", "gone"]) assert.equal(r[id].status, "rate-limited", id);
  assert.equal(gh.calls.length, 2, "no request after the limit");
  assert.equal(res.requests, 2);
});

test("a short secondary rate limit is waited out once; a long one stops the run", async () => {
  const slept = [];
  let tripped = false;
  const gh = fakeGitHub(ROUTES, {
    before: path => (path === "/repos/a/current/releases/latest" && !tripped ? ((tripped = true), { status: 429, headers: { "retry-after": "2" } }) : undefined)
  });
  const res = await checkUpstreams({ manifest: { sources: [MANIFEST.sources[0]] }, fetch: gh.fetch, sleep: async ms => { slept.push(ms); } });
  assert.deepEqual([res.sources[0].status, slept, res.rateLimit], ["current", [2000], null]);

  const long = fakeGitHub(ROUTES, { before: () => ({ status: 403, headers: { "retry-after": "3600" } }) });
  const stopped = await checkUpstreams({ manifest: MANIFEST, fetch: long.fetch, concurrency: 1, sleep: async () => assert.fail("never waits an hour") });
  assert.ok(stopped.sources.every(s => s.status === "rate-limited"));
  assert.equal(long.calls.length, 1);
});

test("an unexpected HEAD or HTTP error is a per-source error, never a crash", async () => {
  const gh = fakeGitHub({ ...ROUTES, "/repos/a/untagged/commits/HEAD": { text: "$(reboot)" }, "/repos/a/quiet/releases/latest": { status: 500 } });
  const r = byId(await checkUpstreams({ manifest: MANIFEST, fetch: gh.fetch }));
  assert.deepEqual([r.untagged.status, r["rel-unchanged"].status, r["rel-changed"].status], ["error", "error", "changed"]);
  assert.match(r["rel-unchanged"].note, /HTTP 500/);
});

test("reportTarget only passes release tags and 40-hex commits on to the CLI", () => {
  assert.equal(reportTarget({ upstream: { ref: "v1.1.0" } }), "v1.1.0");
  assert.equal(reportTarget({ upstream: { ref: HEAD } }), HEAD);
  for (const ref of ["--upload-pack=x", "main", "v1.0.0;rm", undefined]) assert.equal(reportTarget({ upstream: { ref } }), null, String(ref));
  assert.equal(compareUrl({ repo: "a/b", pin: { ref: PIN.changed }, upstream: { ref: "v1.1.0" } }), `https://github.com/a/b/compare/${PIN.changed}...v1.1.0`);
  assert.equal(listPins(MANIFEST).length, 9);
  assert.deepEqual(listPins(MANIFEST).find(p => p.id === "describe").pin, { kind: "describe", tag: "v3.1.0-2-gabc1234", ref: PIN.describe });
});

test("renderIssue: one table row per changed source, per-source sections with reports, attention list", async () => {
  const res = await checkUpstreams({ manifest: MANIFEST, fetch: fakeGitHub().fetch });
  const reports = {
    "rel-changed": { path: "vendor/reports/rel-changed-v1.1.0.md", touched: 2, items: 4, text: "# rel-changed upstream report: v1.0.0 -> v1.1.0" },
    untagged: { error: "fetch failed" }
  };
  const { title, body, changed } = renderIssue({ results: res.sources, reports, artifactUrl: "https://x/artifacts/1", runUrl: "https://x/runs/1" });
  assert.equal(title, "Upstream watch: 4 sources changed tracked files");
  assert.equal(changed, 4);
  assert.match(body, /\| \[rel-changed\]\(#rel-changed\) \| `v1\.0\.0` \| \[`v1\.1\.0`\]\(https:\/\/github\.com\/a\/changed\/compare\/2{40}\.\.\.v1\.1\.0\) \| 2 of 3 \| \[vendor\/reports\/rel-changed-v1\.1\.0\.md\]\(https:\/\/x\/artifacts\/1\) \|/);
  assert.match(body, /\| \[untagged\]\(#untagged\) \| `444444444444` \(untagged\) \| \[`999999999999`\]/);
  assert.match(body, /\| failed: fetch failed \|/);
  assert.match(body, /<a id="rel-changed"><\/a>\n### rel-changed\n\n- `agents\/a\.md` modified -> `plugin\/builtins\/agents\/a\.md` \(adapted\)\n- `gone\.md` removed \(watch\)/);
  assert.match(body, /Next: `muster vendor update untagged --to 9{40} --dry-run`/);
  assert.match(body, /<details><summary>Report: 2 of 4 item\(s\) touched<\/summary>\n\n# rel-changed upstream report/);
  assert.match(body, /- \*\*renamed\*\* \(old\/name\): renamed to `new\/name`; update `repo:` in vendor\/manifest\.yaml\./);
  assert.match(body, /- \*\*gone\*\* \(gone\/repo\): unreachable: gone\/repo answered 404/);
  assert.match(body, /3 source\(s\) current or without tracked changes: rel-current, rel-unchanged, describe\./);

  const huge = renderIssue({ results: res.sources, reports: { "rel-changed": { ...reports["rel-changed"], text: "x".repeat(70_000) } } });
  assert.ok(huge.body.length < 65_536, "the body stays under GitHub's limit");
  assert.match(huge.body, /Report omitted for length/);

  const quiet = renderIssue({ results: res.sources.filter(s => s.status === "current") });
  assert.deepEqual([quiet.title, quiet.changed], ["Upstream watch: no tracked-file changes", 0]);
});

test("runReports runs one report per changed source and records a failure without stopping", async () => {
  const res = await checkUpstreams({ manifest: MANIFEST, fetch: fakeGitHub().fetch });
  const ran = [];
  const reports = await runReports(res.sources, {
    runReport: async (id, ref) => {
      ran.push([id, ref]);
      if (id === "untagged") throw Object.assign(new Error("Command failed"), { stderr: "muster: pin resolves elsewhere\n" });
      return { path: `vendor/reports/${id}.md`, touched: 1, items: 1, text: "r" };
    }
  });
  assert.deepEqual(ran, [["rel-changed", "v1.1.0"], ["untagged", HEAD], ["untagged-twin", HEAD], ["describe-newer", "v1.1.0"]]);
  assert.deepEqual(reports.untagged, { error: "muster: pin resolves elsewhere" });
  assert.equal(reports["rel-changed"].path, "vendor/reports/rel-changed.md");
});

test("upsertIssue creates, updates or closes the one rolling issue", async () => {
  const client = (open) => {
    const calls = [];
    const reply = data => ({ status: 200, data });
    return {
      calls,
      get: async path => { calls.push(["GET", path]); return reply(open); },
      post: async (path, body) => { calls.push(["POST", path, body]); return reply({ number: 77 }); },
      patch: async (path, body) => { calls.push(["PATCH", path, body]); return reply({}); }
    };
  };
  const none = client([{ number: 3, pull_request: {} }]);
  assert.deepEqual(await upsertIssue({ client: none, repo: "o/r", title: "T", body: "B", changed: 2 }), { action: "created", number: 77 });
  assert.deepEqual(none.calls.map(c => c.slice(0, 2)), [["GET", "/repos/o/r/issues?labels=upstream-watch&state=open&per_page=20"], ["POST", "/repos/o/r/labels"], ["POST", "/repos/o/r/issues"]]);
  assert.deepEqual(none.calls[2][2], { title: "T", body: "B", labels: ["upstream-watch"] });

  const one = client([{ number: 12 }, { number: 9 }]);
  assert.deepEqual(await upsertIssue({ client: one, repo: "o/r", title: "T", body: "B", changed: 1 }), { action: "updated", number: 9 });
  assert.deepEqual(one.calls[1], ["PATCH", "/repos/o/r/issues/9", { title: "T", body: "B" }]);

  const clear = client([{ number: 9 }]);
  assert.deepEqual(await upsertIssue({ client: clear, repo: "o/r", title: "T", body: "B", changed: 0 }), { action: "closed", number: 9 });
  assert.equal(clear.calls[1][2].state, "closed");
  assert.deepEqual(await upsertIssue({ client: client([]), repo: "o/r", title: "T", body: "B", changed: 0 }), { action: "none" });

  const partial = client([{ number: 9 }]);
  assert.deepEqual(await upsertIssue({ client: partial, repo: "o/r", title: "T", body: "B", changed: 0, incomplete: true }), { action: "kept", number: 9 });
  assert.equal(partial.calls.length, 1, "a rate-limited run with no changes never closes the issue");
});

test("renderIssue folds rate-limited sources into one attention line and flags the run incomplete", async () => {
  const gh = fakeGitHub(ROUTES, { before: (path, n) => (n === 3 ? { status: 403, headers: { "x-ratelimit-remaining": "0" } } : undefined) });
  const res = await checkUpstreams({ manifest: MANIFEST, fetch: gh.fetch, concurrency: 1 });
  const { body, incomplete } = renderIssue({ results: res.sources });
  assert.equal(incomplete, true);
  assert.match(body, /No checked source changed a tracked file since its pin; the sources below were not fully checked\./);
  assert.match(body, /- \*\*8 source\(s\) not checked\*\*, GitHub API rate limit reached: rel-changed, rel-unchanged, untagged, untagged-twin, describe, describe-newer, renamed, gone/);
});

test("main: check writes watch.json with reports; issue --dry-run renders it; issue posts with the token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-watch-"));
  try {
    await mkdir(join(dir, "vendor"), { recursive: true });
    await writeFile(join(dir, "vendor/manifest.yaml"), stringify(MANIFEST));
    const out = join(dir, "watch.json");
    const logs = [];
    const gh = fakeGitHub();
    await main(["check", "--out", out], { env: { GITHUB_TOKEN: "t0k" }, fetch: gh.fetch, root: dir, log: l => logs.push(l), runReport: async id => ({ path: `vendor/reports/${id}.md`, touched: 1, items: 1, text: `report ${id}` }) });
    const watch = JSON.parse(await readFile(out, "utf8"));
    assert.equal(watch.sources.length, 9);
    assert.deepEqual(Object.keys(watch.reports), ["rel-changed", "untagged", "untagged-twin", "describe-newer"]);
    assert.ok(logs.includes("::warning::rel-changed: 2 tracked file(s) changed upstream at v1.1.0"));
    assert.ok(logs.includes("::warning::renamed: renamed to new/name"));
    assert.ok(logs.includes("::warning::gone: unreachable: gone/repo answered 404 (deleted, renamed away or private)"));

    const dry = await main(["issue", "--in", out, "--dry-run"], { env: {}, log: () => {} });
    assert.equal(dry.title, "Upstream watch: 4 sources changed tracked files");

    const posts = fakeGitHub({
      "/repos/o/r/issues?labels=upstream-watch&state=open&per_page=20": { body: [{ number: 5 }] },
      "/repos/o/r/issues/5": { body: {} }
    });
    const env = { GITHUB_TOKEN: "t0k", GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "42", GITHUB_SERVER_URL: "https://github.com" };
    assert.deepEqual(await main(["issue", "--in", out, "--artifact-url", "https://a/1"], { env, fetch: posts.fetch, log: () => {} }), { action: "updated", number: 5 });
    const patch = posts.calls.find(c => c.method === "PATCH");
    assert.match(patch.body.body, /Run: https:\/\/github\.com\/o\/r\/actions\/runs\/42 · reports: https:\/\/a\/1/);
    await assert.rejects(main(["nope"], { env: {} }), /usage:/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("githubClient sends JSON bodies and throws on a non-2xx, non-404 answer", async () => {
  const gh = fakeGitHub({ "/x": { status: 201, body: { ok: 1 } }, "/bad": { status: 422 } });
  const client = githubClient({ fetch: gh.fetch });
  assert.deepEqual((await client.post("/x", { a: 1 })).data, { ok: 1 });
  assert.equal(gh.calls[0].headers["content-type"], "application/json");
  assert.equal(gh.calls[0].headers.authorization, undefined, "no token, no header");
  await assert.rejects(client.patch("/bad", {}), /PATCH \/bad: HTTP 422/);
});
