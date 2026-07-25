// runKimiInstall / runKimiUninstall / probeKimiModels: the write side of the
// Kimi harness leg. Hermetic fixtures only -- a temp repoRoot supplies a plugin/
// tree, a temp home is the kimi data root; the probe uses an injected fetch and
// a temp credentials file. No real ~/.kimi-code and no live network are touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runKimiInstall, runKimiUninstall, probeKimiModels, KIMI_MANIFEST, KIMI_EXPECTED_MODEL_IDS } from "../src/kimi-install.js";
import { readInstalledKimi } from "../src/harness.js";

function tmp() { return mkdtempSync(join(tmpdir(), "muster-kimi-install-")); }
function write(p, s) { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, s); }

// A minimal plugin/ tree: 2 agents + 2 skills (one with a sibling asset).
function fixtureRepo() {
  const repo = tmp();
  write(join(repo, "package.json"), JSON.stringify({ version: "9.9.9" }));
  write(join(repo, "plugin", "agents", "muster-builder.md"), "---\nname: muster-builder\nmodel: opus\n---\nbody");
  write(join(repo, "plugin", "agents", "wsh-debugger.md"), "---\nname: wsh-debugger\nmodel: haiku\n---\nbody");
  write(join(repo, "plugin", "skills", "orchestrator", "SKILL.md"), "---\nname: orchestrator\n---\nbody");
  write(join(repo, "plugin", "skills", "review-gate", "SKILL.md"), "---\nname: review-gate\n---\nbody");
  write(join(repo, "plugin", "skills", "review-gate", "verdict.schema.json"), "{}");
  // a non-skill dir (no SKILL.md) must be ignored
  write(join(repo, "plugin", "skills", "not-a-skill", "README.md"), "x");
  return repo;
}

test("runKimiInstall: writes agents + skills into the kimi root with an ownership manifest", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    const r = await runKimiInstall({ home, repoRoot: repo });
    assert.equal(r.dest, join(home, ".kimi-code"));
    assert.equal(r.packageVersion, "9.9.9");
    assert.deepEqual(r.agents.sort(), ["muster-builder.md", "wsh-debugger.md"]);
    assert.deepEqual(r.skills.sort(), ["orchestrator", "review-gate"]);

    const root = join(home, ".kimi-code");
    assert.ok(existsSync(join(root, "agents", "muster-builder.md")));
    assert.ok(existsSync(join(root, "skills", "orchestrator", "SKILL.md")));
    assert.ok(existsSync(join(root, "skills", "review-gate", "verdict.schema.json")));
    // the non-skill dir was skipped
    assert.ok(!existsSync(join(root, "skills", "not-a-skill")));

    // agent file copied VERBATIM (model: field left inert, not rewritten)
    assert.match(readFileSync(join(root, "agents", "muster-builder.md"), "utf8"), /model: opus/);

    const manifest = JSON.parse(readFileSync(join(root, "muster", KIMI_MANIFEST), "utf8"));
    assert.equal(manifest.owner, "muster");
    assert.equal(manifest.format, 1);
    assert.ok(manifest.agents.includes("agents/muster-builder.md"));
    assert.ok(manifest.skills.includes("skills/review-gate/verdict.schema.json"));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: the installed root reads back through readInstalledKimi", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    await runKimiInstall({ home, repoRoot: repo });
    const inv = await readInstalledKimi(home, { dir: join(home, ".kimi-code") });
    assert.deepEqual(inv.agents.sort(), ["muster-builder", "wsh-debugger"]);
    assert.deepEqual(inv.skills.sort(), ["orchestrator", "review-gate"]);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: reinstall is idempotent and prunes stale owned files", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    await runKimiInstall({ home, repoRoot: repo });
    // drop an agent from the source, then reinstall
    rmSync(join(repo, "plugin", "agents", "wsh-debugger.md"));
    const r = await runKimiInstall({ home, repoRoot: repo });
    assert.deepEqual(r.removedStale, ["agents/wsh-debugger.md"]);
    const root = join(home, ".kimi-code");
    assert.ok(!existsSync(join(root, "agents", "wsh-debugger.md")));
    assert.ok(existsSync(join(root, "agents", "muster-builder.md")));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiUninstall: removes exactly the owned files and leaves a user's own file", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    await runKimiInstall({ home, repoRoot: repo });
    const root = join(home, ".kimi-code");
    // a user's own agent + skill living alongside muster's
    write(join(root, "agents", "my-own.md"), "mine");
    write(join(root, "skills", "my-skill", "SKILL.md"), "mine");

    const r = await runKimiUninstall({ home });
    assert.ok(r.removed.includes("agents/muster-builder.md"));
    assert.ok(!existsSync(join(root, "agents", "muster-builder.md")));
    assert.ok(!existsSync(join(root, "skills", "orchestrator")));
    // user files survive, and so does the agents/ dir (still non-empty)
    assert.ok(existsSync(join(root, "agents", "my-own.md")));
    assert.ok(existsSync(join(root, "skills", "my-skill", "SKILL.md")));
    // manifest gone
    assert.ok(!existsSync(join(root, "muster", KIMI_MANIFEST)));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiUninstall: a clean home reports nothing to remove", async () => {
  const home = tmp();
  try {
    const r = await runKimiUninstall({ home });
    assert.deepEqual(r.removed, []);
    assert.match(r.note, /no muster install/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall --dry-run: reports the plan without writing", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    const r = await runKimiInstall({ home, repoRoot: repo, dryRun: true });
    assert.equal(r.dryRun, true);
    assert.equal(r.fileCount, 5); // 2 agents + 3 skill files
    assert.ok(!existsSync(join(home, ".kimi-code")));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: refuses to write through a symlinked agents dir", async () => {
  const repo = fixtureRepo(), home = tmp(), elsewhere = tmp();
  try {
    mkdirSync(join(home, ".kimi-code"), { recursive: true });
    symlinkSync(elsewhere, join(home, ".kimi-code", "agents"));
    await assert.rejects(runKimiInstall({ home, repoRoot: repo }), /non-ordinary Kimi directory/);
  } finally { [repo, home, elsewhere].forEach(d => rmSync(d, { recursive: true, force: true })); }
});

test("probeKimiModels: managed plan (no cheaper model) confirms the policy, no remap", async () => {
  const home = tmp();
  try {
    write(join(home, ".kimi-code", "credentials", "kimi-code.json"), JSON.stringify({ access_token: "tok" }));
    const fetchImpl = async (url, opts) => {
      assert.match(url, /\/models$/);
      assert.equal(opts.headers.Authorization, "Bearer tok");
      return { ok: true, status: 200, json: async () => ({ data: KIMI_EXPECTED_MODEL_IDS.map(id => ({ id })) }) };
    };
    const r = await probeKimiModels({ home, fetchImpl });
    assert.equal(r.ok, true);
    assert.equal(r.matchesPolicy, true);
    assert.equal(r.remapHaiku, false);
    assert.deepEqual(r.cheaperCandidates, []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("probeKimiModels: a served general model (k2.6) flags a haiku remap", async () => {
  const home = tmp();
  try {
    write(join(home, ".kimi-code", "credentials", "kimi-code.json"), JSON.stringify({ access_token: "tok" }));
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: "k3" }, { id: "kimi-for-coding" }, { id: "kimi-k2.6" }] }) });
    const r = await probeKimiModels({ home, fetchImpl });
    assert.equal(r.remapHaiku, true);
    assert.deepEqual(r.cheaperCandidates, ["kimi-k2.6"]);
    assert.equal(r.matchesPolicy, false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("probeKimiModels: no token is a clean not-ok, never a throw", async () => {
  const home = tmp();
  try {
    const r = await probeKimiModels({ home, fetchImpl: async () => { throw new Error("must not be called"); } });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "no-token");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("probeKimiModels: an HTTP error is reported, not thrown", async () => {
  const home = tmp();
  try {
    write(join(home, ".kimi-code", "credentials", "kimi-code.json"), JSON.stringify({ access_token: "tok" }));
    const r = await probeKimiModels({ home, fetchImpl: async () => ({ ok: false, status: 401 }) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "http-401");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
