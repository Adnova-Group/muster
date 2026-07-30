// test/docs-currency.test.js — 0.4.1 currency drift guard for user-facing docs.
//
// Backlog item docs-currency-041: keep the agent count, role count, and the muster-authored
// agent roster in README/docs/architecture.md/website/** anchored to their authoritative
// sources (src/roles.js, plugin/agents/) rather than hand-maintained numbers that can drift
// (see docs/anti-patterns.md #9, "Generated-artifact model-tier drift", for the same class
// of problem in a different artifact). Also pins that the two docs added alongside the
// muster-runner agent (docs/anti-patterns.md, docs/binding-interface.md) stay reachable from
// the docs/architecture.md index.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { CODEX_COUNTS, CODEX_MODEL_POLICY } from "../src/codex.js";
import { REQUIRED_CODEX_THREAD_LIMITS } from "../src/codex-thread-limits.js";
import { ROLES } from "../src/roles.js";
import { CODEX_MULTI_AGENT_VERSIONS } from "../src/wave-dispatch.js";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

async function musterAgentIds() {
  const files = await readdir(new URL("plugin/agents/", root));
  return files
    .filter((f) => f.startsWith("muster-") && f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
}

// ─── role count anchored to src/roles.js ─────────────────────────────────────

test("docs/architecture.md's stated role count matches src/roles.js", async () => {
  const text = await read("docs/architecture.md");
  const m = text.match(/There are (\d+) of them \(see `src\/roles\.js`\)/);
  assert.ok(m, "docs/architecture.md must state the role count anchored to src/roles.js");
  assert.equal(Number(m[1]), ROLES.length, `doc says ${m[1]} roles, src/roles.js has ${ROLES.length}`);
});

test("website/reference/architecture.md's stated role count matches src/roles.js", async () => {
  const text = await read("website/reference/architecture.md");
  const m = text.match(/There are (\d+) of them \(`src\/roles\.js`\)/);
  assert.ok(m, "website/reference/architecture.md must state the role count anchored to src/roles.js");
  assert.equal(Number(m[1]), ROLES.length, `doc says ${m[1]} roles, src/roles.js has ${ROLES.length}`);
});

test("website/reference/concepts.md's stated role count matches src/roles.js", async () => {
  const text = await read("website/reference/concepts.md");
  const m = text.match(/(\d+) in all\)/);
  assert.ok(m, "website/reference/concepts.md must state the role count as 'N in all'");
  assert.equal(Number(m[1]), ROLES.length, `doc says ${m[1]} roles, src/roles.js has ${ROLES.length}`);
});

// ─── muster-authored agent roster anchored to plugin/agents/ ────────────────

test("docs/architecture.md's clean-room specialists sentence lists every muster-authored agent in plugin/agents/, and no others", async () => {
  const text = await read("docs/architecture.md");
  const sentence = text.match(/Alongside the vendored material, Muster ships its own clean-room specialists in `plugin\/agents\/`:[^\n]*\./);
  assert.ok(sentence, "docs/architecture.md must carry the 'Alongside the vendored material...' clean-room specialists sentence");
  const ids = await musterAgentIds();
  for (const id of ids) {
    assert.match(sentence[0], new RegExp("`" + id + "`"), `docs/architecture.md's clean-room specialists sentence is missing \`${id}\``);
  }
  const listed = [...sentence[0].matchAll(/`(muster-[a-z]+)`/g)].map((m) => m[1]);
  for (const id of new Set(listed)) {
    assert.ok(ids.includes(id), `docs/architecture.md's clean-room specialists sentence names \`${id}\`, which has no file in plugin/agents/`);
  }
});

test("website/about/credits.md lists every muster-authored agent in plugin/agents/, and no others", async () => {
  const text = await read("website/about/credits.md");
  const ids = await musterAgentIds();
  for (const id of ids) {
    assert.match(text, new RegExp("\\*\\*" + id + "\\*\\*"), `website/about/credits.md is missing **${id}**`);
  }
  const listed = [...text.matchAll(/\*\*(muster-[a-z]+)\*\*/g)].map((m) => m[1]);
  for (const id of new Set(listed)) {
    assert.ok(ids.includes(id), `website/about/credits.md names **${id}**, which has no file in plugin/agents/`);
  }
});

// ─── new-doc reachability from the docs index ────────────────────────────────

test("docs/architecture.md points at the anti-pattern ledger (docs/anti-patterns.md reachable from the docs index)", async () => {
  const text = await read("docs/architecture.md");
  assert.match(
    text,
    /docs\/anti-patterns\.md/,
    "docs/architecture.md must reference docs/anti-patterns.md so the ledger is reachable from the architecture index"
  );
});

// ─── research/current-state references anchored to generated Codex sources ──

const ownedCurrencyDocs = [
  "docs/research/codex-cli.md",
  "docs/research/codex-desktop.md",
  "docs/research/kimi-code-cli.md",
  "docs/fast-path-token-gap.md"
];

test("current research docs identify the shared live agent manifest", async () => {
  for (const path of [
    "docs/research/codex-cli.md",
    "docs/research/kimi-code-cli.md",
    "docs/fast-path-token-gap.md",
  ]) {
    const text = await read(path);
    assert.match(
      text,
      /catalog\/agents\.manifest\.json/,
      `${path} must identify the shared live catalog/agents.manifest.json`
    );
  }
});

test("current Codex research inventories match the generated plugin surface", async () => {
  const totalSkills = CODEX_COUNTS.publicSkills + CODEX_COUNTS.internalSkills;
  const expectedInventory = new RegExp(
    `${totalSkills} skills \\(${CODEX_COUNTS.publicSkills} public \\+ ${CODEX_COUNTS.internalSkills} internal\\).*${CODEX_COUNTS.mcpTools} MCP tools`
  );
  for (const path of ["docs/research/codex-cli.md", "docs/research/codex-desktop.md"]) {
    const text = await read(path);
    assert.match(text, expectedInventory, `${path} must state the current generated Codex surface`);
    assert.match(text, /\$muster-init/, `${path} must include Init in the current public skill inventory`);
  }
});

test("current Codex docs match live model policy, installer, marketplace, and dispatch-version behavior", async () => {
  const [architecture, cli, desktop] = await Promise.all([
    read("docs/architecture.md"),
    read("docs/research/codex-cli.md"),
    read("docs/research/codex-desktop.md"),
  ]);
  const scout = CODEX_MODEL_POLICY.tiers.scout;
  const core = CODEX_MODEL_POLICY.tiers.core;
  assert.match(architecture, new RegExp(`bounded[^.]+${core.model}[^.]+${core.effort}`, "i"));
  assert.match(architecture, new RegExp(`locator[^.]+${scout.model}[^.]+${scout.effort}`, "i"));
  assert.match(architecture, /security[^.]+gpt-5\.6-sol[^.]+xhigh/i);

  for (const [path, text] of [["docs/research/codex-cli.md", cli], ["docs/research/codex-desktop.md", desktop]]) {
    assert.match(text, /ensureCodexThreadLimits[\s\S]{0,260}restoreCodexThreadLimits/);
    assert.doesNotMatch(text, /nothing in muster currently writes[^.]+max_threads|current mainline muster writes no\s+`config\.toml`|re-opened thread-limits/i, `${path} must not present the retired thread-limit gap as current`);
  }
  assert.match(desktop, /max_threads[\s\S]{0,160}v1[\s\S]{0,80}6[\s\S]{0,120}v2[\s\S]{0,80}4/i);
  assert.match(desktop, /job_max_runtime_seconds[\s\S]{0,180}(?:removed|historical)/i);
  assert.match(desktop, /source:[\s\S]{0,80}path:[\s\S]{0,40}\.\/\.agents\/plugins\/plugin/);
  assert.doesNotMatch(desktop, /entry uses `source:[\s\S]{0,100}path:\s*\n?\s*["`]?\.\x2fplugin/i);
  assert.match(cli, /resolveCodexMultiAgentVersion[\s\S]{0,220}(?:v1[\s\S]{0,80}v2|v2[\s\S]{0,80}v1)/);
  assert.doesNotMatch(cli, /muster hardcodes the v2 packet/i);
});

test("Codex CLI research carries the 0.146 performance decision matrix and experimental boundaries", async () => {
  const cli = await read("docs/research/codex-cli.md");
  assert.match(
    cli,
    /\*\*Version anchor:\*\*[\s\S]{0,240}Codex CLI 0\.146\.0[\s\S]{0,160}rust-v0\.146\.0/,
    "Codex research must anchor current claims to the installed 0.146.0 binary and official release"
  );
  for (const status of ["ADOPT", "AUTOMATIC", "PILOT", "REJECT"]) {
    assert.match(cli, new RegExp(`\\| \\*\\*${status}\\*\\* \\|`), `0.146 decision matrix must include ${status}`);
  }
  for (const source of [
    "https://github.com/openai/codex/releases/tag/rust-v0.146.0",
    "https://github.com/openai/codex/pull/34761",
    "https://github.com/openai/codex/pull/34825",
    "https://github.com/openai/codex/pull/34952",
    "https://github.com/openai/codex/pull/35144",
  ]) {
    assert.match(cli, new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `0.146 audit must link ${source}`);
  }
  assert.match(cli, /code_mode[\s\S]{0,100}under development[\s\S]{0,60}false/i);
  assert.match(cli, /code_mode_host[\s\S]{0,100}stable[\s\S]{0,60}true/i);
  assert.doesNotMatch(cli, /remote Code Mode[^.\n]*(?:production-ready|stable end-to-end)/i);
});

test("ChatGPT Work compatibility is explicitly unverified rather than inherited from Codex", async () => {
  for (const path of [
    "docs/research/gpt-work.md",
    "docs/research/reference-harness-design.md",
    "docs/strategy/native-delegation.md",
  ]) {
    const text = await read(path);
    assert.match(text, /Work-mode load probe|Work load probe/i, `${path} must name the missing compatibility probe`);
    assert.match(text, /unverified/i, `${path} must label compatibility unverified`);
    assert.doesNotMatch(text, /Codex lane covers (?:ChatGPT Work|it)|ChatGPT Work = Codex substrate|same AGENTS\.md\/skills\/hooks\/MCP surface/i);
  }
});

test("ChatGPT Work docs carry the current private plugin, tunnel, profile, and billing boundaries", async () => {
  const docs = await Promise.all([
    read("README.md"),
    read("website/guides/chatgpt-work.md"),
    read("docs/research/gpt-work.md"),
    read("cowork/README.md"),
  ]);
  const text = docs.join("\n");
  for (const marker of [
    "https://learn.chatgpt.com/docs/plugins",
    "https://developers.openai.com/plugins/build/plugins",
    "https://developers.openai.com/api/docs/guides/secure-mcp-tunnels",
    "https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt-beta",
    "muster install chatgpt-work --connection-id",
    "--profile pro-safe",
    "--profile full --allow-full-actions",
    "--scope project",
    "--scope user",
    ".app.json",
    "asdk_app_<normalized",
    "runtime/chatgpt-work-server.mjs",
    "CONTROL_PLANE_API_KEY",
    "MUSTER_CHATGPT_WORK_PROBE_NONCE",
    "MUSTER_CHATGPT_WORK_PROBE_ATTESTATION_PATH",
    "MUSTER_CHATGPT_WORK_CONNECTION_ID",
    "MUSTER_CHATGPT_WORK_APP_JSON_PATH",
    "MUSTER_CHATGPT_WORK_PLUGIN_VERSION",
    "MUSTER_CHATGPT_WORK_CONNECTION_LABEL",
    "0700",
    "0600",
    "server-attestation.json",
    "inherited by the `--mcp-command` child",
    "Platform API",
    "ChatGPT Pro",
    "Scan Tools",
    "readOnlyHint=true",
    "destructiveHint=false",
    "openWorldHint=false",
    "28-tool",
    "full-MCP",
    "Refresh",
    "recreate",
    "public submission",
    "outbound-only",
    "operator",
    "cryptographic provenance",
    ".agents/plugins/muster-chatgpt-work",
    "pluginPath",
    "restart or refresh ChatGPT Desktop",
    "local/repo marketplace",
    "HUMAN-HOLD",
    "evidence-graded",
    "finalize-cleanup",
  ]) assert.match(text, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `missing ChatGPT Work currency marker: ${marker}`);
  assert.match(text, /connection ID[^.]+(?:not|non-secret|identifier)/i);
  assert.match(text, /tunnel[^.]+(?:cannot|not)[^.]+public/i);
  assert.match(text, /does not inherit Codex|not inherit Codex/i);
});

test("MCP docs and adapters name the neutral core, explicit hosts, and compatibility shims", async () => {
  const [core, codex, work, coworkShim, coworkWorkShim, build, install, readme, coworkReadme, coworkGuide, architecture, coworkResearch, codexResearch, commands, configuration] = await Promise.all([
    read("mcp/server.mjs"),
    read("mcp/codex-server.mjs"),
    read("mcp/chatgpt-work-server.mjs"),
    read("cowork/mcp-server.mjs"),
    read("cowork/chatgpt-work-server.mjs"),
    read("scripts/build-codex.mjs"),
    read("src/chatgpt-work-install.js"),
    read("README.md"),
    read("cowork/README.md"),
    read("website/guides/cowork.md"),
    read("website/reference/architecture.md"),
    read("docs/research/claude-cowork.md"),
    read("docs/research/codex-cli.md"),
    read("website/reference/commands.md"),
    read("website/reference/configuration.md"),
  ]);
  assert.match(core, /startMusterMcpServer/);
  assert.doesNotMatch(core, /MUSTER_MCP_HOST/);
  assert.match(codex, /runtimeIdentity:\s*"codex"/);
  assert.match(work, /runtimeIdentity:\s*"work"/);
  assert.match(coworkShim, /runtimeIdentity:\s*"cowork"/);
  assert.match(coworkShim, /\.\.\/mcp\/server\.mjs/);
  assert.match(coworkWorkShim, /compatibility entrypoint/i);
  assert.match(coworkWorkShim, /\.\.\/mcp\/chatgpt-work-server\.mjs/);
  assert.match(build, /join\(root, "mcp", "codex-server\.mjs"\)/);
  assert.match(build, /join\(root, "mcp", "chatgpt-work-server\.mjs"\)/);
  assert.doesNotMatch(build, /readFileSync\(join\(root, "cowork", "mcp-server\.mjs"\)/);
  assert.doesNotMatch(install, /readFile\(join\(root, "cowork", "mcp-server\.mjs"\)/);
  for (const [path, text] of [
    ["README.md", readme],
    ["cowork/README.md", coworkReadme],
    ["website/guides/cowork.md", coworkGuide],
    ["website/reference/architecture.md", architecture],
    ["docs/research/claude-cowork.md", coworkResearch],
    ["docs/research/codex-cli.md", codexResearch],
    ["website/reference/commands.md", commands],
    ["website/reference/configuration.md", configuration],
  ]) {
    assert.match(text, /mcp\/server\.mjs/, `${path} must name the neutral MCP core`);
    assert.match(text, /Cowork adapter|compatibility (?:entrypoint|shim)/i, `${path} must name the Cowork adapter or compatibility path`);
  }
  assert.match(readme, /runtime\/chatgpt-work-server\.mjs/);
  assert.match(coworkResearch, /no longer\s+string-rewrites\s+`?cowork\/mcp-server\.mjs`?/i);
  assert.match(codexResearch, /mcp\/codex-server\.mjs[\s\S]{0,180}neutral `?mcp\/server\.mjs`?/i);
});

test("native Work proof schema stays paired with its probe", async () => {
  const [probe, schema] = await Promise.all([
    read("scripts/chatgpt-work-native-probe.mjs"),
    read("docs/research/evidence/chatgpt-work-native-probe.schema.json"),
  ]);
  const parsed = JSON.parse(schema);
  assert.equal(parsed.additionalProperties, false);
  assert.deepEqual(parsed.required, ["receiptType", "nonce", "timestamp", "identity", "operatorEvidence", "serverEvidence", "inventory", "artifacts"]);
  for (const marker of ["invocationCount", "connectionIdSha256", "pluginAppSha256", "serverInstanceId", "pending-after-evidence-grade", "operator-observed-ui", "muster-work-native-server-attestation", "muster-work-native-retained-grade", "gradeDigest", "ownedPaths", "muster-work-native-cleanup-finalization"]) {
    assert.match(probe, new RegExp(marker), `probe is missing ${marker}`);
    assert.match(schema, new RegExp(marker), `schema is missing ${marker}`);
  }
  assert.match(probe, /grade-snapshot/);
  assert.match(probe, /lstat/);
  assert.match(probe, /Windows native proof is always HUMAN-HOLD/);
  assert.equal(parsed.$defs.attestation.properties.serverInstanceId.pattern, "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
  assert.doesNotMatch(schema, /verified-absent/);
});

test("current Cowork research uses the live MCP tool count and phase-3-gated dispatch contract", async () => {
  const manifest = JSON.parse(await read("cowork/manifest.json"));
  for (const path of [
    "docs/research/claude-cowork.md",
    "docs/research/reference-harness-design.md",
    "docs/strategy/native-delegation.md",
  ]) {
    const text = await read(path);
    assert.match(text, new RegExp(`${manifest.tools.length}-tool MCP server`), `${path} must state the live Cowork tool count`);
    assert.doesNotMatch(text, /\b21-tool MCP server\b|all twenty-one tools/i, `${path} must not present the retired count as current`);
    assert.doesNotMatch(
      text,
      /(?:dispatch|parallel fan-out|per-call model override)[\s\S]{0,100}(?:confirmed working|confirmed|CODE-VERIFIED-but-fragile)|CODE-VERIFIED-but-fragile[\s\S]{0,100}(?:dispatch|parallel fan-out|per-call model override)/i,
      `${path} must not claim dispatch without a retained phase-3 receipt`,
    );
    assert.match(text, /sequential\s+`?muster_next`?[\s\S]{0,180}(?:default|verified)/i, `${path} must name the verified sequential default`);
    assert.match(text, /fresh\s+successful\s+phase-3\s+receipt|phase-3\s+receipt[\s\S]{0,100}(?:required|require)/i, `${path} must require active-build phase-3 evidence`);
    assert.match(text, /phase-3/i, `${path} must identify the dispatch evidence gate`);
  }
});

test("cross-harness research preserves current Codex hook, dispatch, thread, and canonical-scope contracts", async () => {
  const reference = await read("docs/research/reference-harness-design.md");
  const strategy = await read("docs/strategy/native-delegation.md");
  const desktop = await read("docs/research/codex-desktop.md");

  for (const [path, text] of [
    ["docs/research/reference-harness-design.md", reference],
    ["docs/strategy/native-delegation.md", strategy],
  ]) {
    const v1 = CODEX_MULTI_AGENT_VERSIONS.V1;
    const v2 = CODEX_MULTI_AGENT_VERSIONS.V2;
    assert.match(text, new RegExp(`multi_agent_${v1}[\\s\\S]{0,220}(?:collaboration|multi_agent_${v2})|(?:collaboration|multi_agent_${v2})[\\s\\S]{0,220}multi_agent_${v1}`, "i"), `${path} must document both Codex dispatch packet versions`);
    assert.match(text, /resolveCodexMultiAgentVersion[\s\S]{0,220}(?:unknown|unrecognized)[\s\S]{0,80}(?:fail loud|reject)/i, `${path} must document fail-closed unknown-version handling`);
    assert.match(text, /plugin-bundled hooks[\s\S]{0,180}(?:execute|fire)[\s\S]{0,120}0\.144\.5/i, `${path} must retain verified plugin-hook execution`);
    assert.match(text, /Codex plugin[\s\S]{0,140}hooks-free[\s\S]{0,140}(?:double firing|double-inject)/i, `${path} must explain Muster's hooks-free plugin`);
    assert.doesNotMatch(text, /Codex 0\.144(?:\.0)? does not execute plugin-bundled hooks|plugin-bundled hooks not executed on 0\.144/i, `${path} must not repeat the falsified hook claim`);
    assert.match(text, /ensureCodexThreadLimits[\s\S]{0,220}restoreCodexThreadLimits/i, `${path} must document landed thread-limit ownership`);
    assert.match(text, new RegExp(`max_threads[\\s\\S]{0,100}(?:>=|≥)\\s*${REQUIRED_CODEX_THREAD_LIMITS.max_threads}[\\s\\S]{0,140}max_depth[\\s\\S]{0,100}(?:>=|≥)\\s*${REQUIRED_CODEX_THREAD_LIMITS.max_depth}`, "i"), `${path} must state the managed floors`);
    assert.doesNotMatch(text, /thread-limits invalidated and re-opened|invalidated and re-opened[\s\S]{0,80}thread/i, `${path} must not present the landed thread-limit item as open`);
  }

  assert.match(desktop, /user\s+scope\s+is\s+canonical[\s\S]{0,260}(?:project\s+hooks[\s\S]{0,80}(?:skip|collapse)|(?:skip|collapse)[\s\S]{0,80}project)/i, "Codex Desktop must describe canonical-scope collapse");
  assert.doesNotMatch(desktop, /installs[\s\S]{0,100}at both project and user scope/i, "Codex Desktop must not promise duplicate live hook scopes");
});
