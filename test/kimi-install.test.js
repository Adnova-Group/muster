// runKimiInstall / runKimiUninstall / probeKimiModels: the write side of the
// Kimi harness leg. Hermetic fixtures only -- a temp repoRoot supplies a plugin/
// tree, a temp home is the kimi data root; the probe uses an injected fetch and
// a temp credentials file. No real ~/.kimi-code and no live network are touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runKimiInstall, runKimiUninstall, probeKimiModels, stampModelPreference, stampSkillName, KIMI_MANIFEST, KIMI_EXPECTED_MODEL_IDS } from "../src/kimi-install.js";
import { readInstalledKimi } from "../src/harness.js";
import { KIMI_LANES, kimiModelPreferenceForTier, kimiPreferenceForAgentId } from "../src/kimi.js";

function tmp() { return mkdtempSync(join(tmpdir(), "muster-kimi-install-")); }
function write(p, s) { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, s); }

// A minimal plugin/ tree: 2 agents + 2 skills (one with a sibling asset).
function fixtureRepo() {
  const repo = tmp();
  write(join(repo, "package.json"), JSON.stringify({ version: "9.9.9" }));
  write(join(repo, "plugin", "agents", "muster-builder.md"), "---\nname: muster-builder\nmodel: opus\n---\nbody");
  write(join(repo, "plugin", "agents", "muster-investigator.md"), "---\nname: muster-investigator\nmodel: haiku\n---\nbody");
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
    assert.deepEqual(r.agents.sort(), ["muster-builder.md", "muster-investigator.md"]);
    assert.deepEqual(r.skills.sort(), ["orchestrator", "review-gate"]);

    const root = join(home, ".kimi-code");
    assert.ok(existsSync(join(root, "agents", "muster-builder.md")));
    assert.ok(existsSync(join(root, "skills", "orchestrator", "SKILL.md")));
    assert.ok(existsSync(join(root, "skills", "review-gate", "verdict.schema.json")));
    // the non-skill dir was skipped
    assert.ok(!existsSync(join(root, "skills", "not-a-skill")));

    // the inert Claude-Code `model:` field is left alone (Kimi ignores it), and
    // the field Kimi DOES honour is stamped in from the manifest tier.
    const builder = readFileSync(join(root, "agents", "muster-builder.md"), "utf8");
    assert.match(builder, /model: opus/);
    assert.match(builder, /^model_preference: primary$/m);
    assert.match(builder, /^body$/m); // body preserved

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
    assert.deepEqual(inv.agents.sort(), ["muster-builder", "muster-investigator"]);
    assert.deepEqual(inv.skills.sort(), ["orchestrator", "review-gate"]);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: reinstall is idempotent and prunes stale owned files", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    await runKimiInstall({ home, repoRoot: repo });
    // drop an agent from the source, then reinstall
    rmSync(join(repo, "plugin", "agents", "muster-investigator.md"));
    const r = await runKimiInstall({ home, repoRoot: repo });
    assert.deepEqual(r.removedStale, ["agents/muster-investigator.md"]);
    const root = join(home, ".kimi-code");
    assert.ok(!existsSync(join(root, "agents", "muster-investigator.md")));
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

// --- model_preference: the two-lane dispatch bind ---------------------------

test("kimiModelPreferenceForTier: tiers fold onto the two configured lanes", () => {
  // K3 judgment family -> primary; K2.7 Coding execution family -> secondary.
  assert.equal(kimiModelPreferenceForTier("opus"), "primary");
  assert.equal(kimiModelPreferenceForTier("fable"), "primary");
  assert.equal(kimiModelPreferenceForTier("sonnet"), "secondary");
  assert.equal(kimiModelPreferenceForTier("haiku"), "secondary");
});

test("kimiPreferenceForAgentId: resolves real manifest agents, null for a non-agent", () => {
  assert.equal(kimiPreferenceForAgentId("muster-strategist"), "primary");   // fable
  assert.equal(kimiPreferenceForAgentId("muster-reviewer"), "primary");     // opus
  assert.equal(kimiPreferenceForAgentId("muster-surgeon"), "secondary");    // sonnet
  assert.equal(kimiPreferenceForAgentId("muster-investigator"), "secondary"); // haiku
  assert.equal(kimiPreferenceForAgentId("no-such-agent"), null);
});

test("KIMI_LANES stays consistent with the tier policy (no drift)", () => {
  // The lane map is derived from KIMI_TIERS, so every tier must land on a lane;
  // an unmapped model must fail loud rather than silently pick one.
  for (const tier of ["haiku", "sonnet", "opus", "fable"]) {
    assert.ok(Object.keys(KIMI_LANES).includes(kimiModelPreferenceForTier(tier)));
  }
});

test("stampModelPreference: appends, replaces, and preserves the rest byte-for-byte", () => {
  const src = "---\nname: a\ndescription: d\n---\nbody text\n";
  assert.match(stampModelPreference(src, "primary"), /^---\nname: a\ndescription: d\nmodel_preference: primary\n---\nbody text\n$/);
  // an existing line is REPLACED, not duplicated
  const already = "---\nname: a\nmodel_preference: secondary\n---\nb\n";
  const out = stampModelPreference(already, "primary");
  assert.equal(out.match(/model_preference:/g).length, 1);
  assert.match(out, /model_preference: primary/);
  // CRLF survives
  assert.match(stampModelPreference("---\r\nname: a\r\n---\r\nb\r\n", "primary"), /\r\nmodel_preference: primary\r\n/);
  // no frontmatter -> null (caller surfaces it rather than inventing a block)
  assert.equal(stampModelPreference("no frontmatter here\n", "primary"), null);
});

test("runKimiInstall: stamps each agent's lane and reports the required config", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    const r = await runKimiInstall({ home, repoRoot: repo });
    // muster-builder = opus -> primary; muster-investigator = haiku -> secondary
    assert.equal(r.modelPreference.primary, 1);
    assert.equal(r.modelPreference.secondary, 1);
    assert.deepEqual(r.modelPreference.unstamped, []);
    assert.equal(r.modelPreference.requiredConfig.default_model, KIMI_LANES.primary);
    assert.match(r.modelPreference.requiredConfig.toml, /\[secondary_model\]/);
    // the preferred route mutates nothing shared: per-process env vars
    assert.equal(r.modelPreference.requiredConfig.env.KIMI_SECONDARY_MODEL, KIMI_LANES.secondary);
    assert.equal(r.modelPreference.requiredConfig.env.KIMI_CODE_EXPERIMENTAL_FLAG, "1");
    assert.match(r.modelPreference.note, /experimental/i);

    const root = join(home, ".kimi-code");
    assert.match(readFileSync(join(root, "agents", "muster-investigator.md"), "utf8"), /^model_preference: secondary$/m);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: an agent with no manifest entry is copied through and SURFACED, not silently defaulted", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    write(join(repo, "plugin", "agents", "not-in-manifest.md"), "---\nname: not-in-manifest\n---\nbody");
    const r = await runKimiInstall({ home, repoRoot: repo });
    assert.deepEqual(r.modelPreference.unstamped, [{ id: "not-in-manifest", reason: "no manifest entry" }]);
    // copied through unstamped -- never given a lane muster cannot justify
    const text = readFileSync(join(home, ".kimi-code", "agents", "not-in-manifest.md"), "utf8");
    assert.ok(!text.includes("model_preference"));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
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

// --- Verbs: muster's entry points -------------------------------------------

test("stampSkillName: rewrites the frontmatter name, preserving everything else", () => {
  const src = "---\nname: go\ndescription: d\nargument-hint: x\n---\nbody\n";
  const out = stampSkillName(src, "muster-go");
  assert.match(out, /^name: muster-go$/m);
  assert.match(out, /^description: d$/m);
  assert.match(out, /^argument-hint: x$/m);
  assert.match(out, /^body$/m);
  assert.equal(out.match(/name:/g).length, 1); // replaced, not duplicated
  assert.equal(stampSkillName("no frontmatter\n", "muster-go"), null);
});

test("runKimiInstall: installs muster's VERBS as namespaced skills", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    write(join(repo, "plugin", "commands", "go.md"), "---\nname: go\ndescription: hands-off lifecycle\n---\nverb body");
    write(join(repo, "plugin", "commands", "plan.md"), "---\nname: plan\ndescription: approve-first\n---\nverb body");

    const r = await runKimiInstall({ home, repoRoot: repo });
    assert.deepEqual(r.verbs.sort(), ["muster-go", "muster-plan"]);

    const root = join(home, ".kimi-code");
    const go = readFileSync(join(root, "skills", "muster-go", "SKILL.md"), "utf8");
    // Kimi registers a skill by its FRONTMATTER name, so the namespace must be
    // written into the file -- a renamed directory alone would still collide.
    assert.match(go, /^name: muster-go$/m);
    assert.match(go, /^description: hands-off lifecycle$/m);
    // `plan` is Kimi's own Plan-mode command; the prefix is what avoids it.
    assert.match(readFileSync(join(root, "skills", "muster-plan", "SKILL.md"), "utf8"), /^name: muster-plan$/m);
    assert.ok(!existsSync(join(root, "skills", "plan")));

    // verbs are manifest-owned, so uninstall reclaims them
    const manifest = JSON.parse(readFileSync(join(root, "muster", KIMI_MANIFEST), "utf8"));
    assert.ok(manifest.verbs.includes("skills/muster-go/SKILL.md"));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiUninstall: removes the installed verbs too", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    write(join(repo, "plugin", "commands", "go.md"), "---\nname: go\ndescription: d\n---\nb");
    await runKimiInstall({ home, repoRoot: repo });
    const root = join(home, ".kimi-code");
    assert.ok(existsSync(join(root, "skills", "muster-go", "SKILL.md")));
    await runKimiUninstall({ home });
    assert.ok(!existsSync(join(root, "skills", "muster-go")));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiUninstall: a pre-verbs manifest (no verbs key) still uninstalls cleanly", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    await runKimiInstall({ home, repoRoot: repo });
    const mPath = join(home, ".kimi-code", "muster", KIMI_MANIFEST);
    const m = JSON.parse(readFileSync(mPath, "utf8"));
    delete m.verbs;                                  // simulate the older manifest
    writeFileSync(mPath, JSON.stringify(m, null, 2));
    const r = await runKimiUninstall({ home });
    assert.ok(r.removed.length > 0);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});
