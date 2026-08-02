#!/usr/bin/env node

import { execFile as execFileCb, spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CODEX_COUNTS } from "../src/codex-inventory.js";
import { resolveCodexPlugin } from "../src/codex-release.js";

const execFile = promisify(execFileCb);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDir, "..");
const MCP_TIMEOUT_MS = 15_000;
const MCP_OUTPUT_CAP = 256 * 1024;
const MCP_PROTOCOL_VERSION = "2025-06-18";
const REQUIRED_DETECT_FIELDS = Object.freeze(["greenfield", "languages", "vcs"]);
export const CODEX_0146_PUBLIC_SKILLS = Object.freeze([
  "autopilot",
  "muster",
  "muster-audit",
  "muster-capture",
  "muster-design",
  "muster-diagnose",
  "muster-go",
  "muster-go-backlog",
  "muster-init",
  "muster-plan",
  "muster-plan-backlog",
  "muster-runner",
  "run",
  "sprint",
]);

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function locatorMatches(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string" || !actual || !expected) return false;
  const normalizedActual = actual.replaceAll("\\", "/").split(sep).join("/");
  const normalizedExpected = expected.replaceAll("\\", "/").split(sep).join("/");
  const skillRelative = normalizedExpected.replace(/^\/skills\//, "/");
  return normalizedActual === normalizedExpected
    || normalizedActual.endsWith(normalizedExpected)
    || normalizedActual.endsWith(skillRelative);
}

function nameMatches(actual, expected) {
  return actual === expected || (typeof actual === "string" && actual.endsWith(`:${expected}`));
}

export function evaluateSkillCatalogEvidence({ expectedSkills = [], evidence } = {}) {
  if (!evidence) {
    return {
      status: "UNKNOWN",
      reason: "host-skill-catalog-evidence-not-provided",
      expectedCount: expectedSkills.length,
    };
  }
  if (evidence.descriptionTruncationObserved !== true) {
    return {
      status: "UNKNOWN",
      reason: "host-description-truncation-not-observed",
      expectedCount: expectedSkills.length,
      observedCount: Array.isArray(evidence.entries) ? evidence.entries.length : 0,
    };
  }
  if (!Array.isArray(evidence.entries)) {
    return {
      status: "FAIL",
      reason: "host-skill-catalog-evidence-invalid",
      expectedCount: expectedSkills.length,
      observedCount: 0,
    };
  }

  const missing = expectedSkills.filter(expected => !evidence.entries.some(
    entry => nameMatches(entry?.name, expected.name) && locatorMatches(entry.locator, expected.locator)
  ));
  if (missing.length) {
    return {
      status: "FAIL",
      reason: "expected-skill-name-or-locator-missing",
      expectedCount: expectedSkills.length,
      observedCount: evidence.entries.length,
      missing,
    };
  }
  return {
    status: "PASS",
    reason: "all-expected-names-and-locators-retained-under-observed-description-truncation",
    expectedCount: expectedSkills.length,
    observedCount: evidence.entries.length,
  };
}

export function compareMcpContracts(before, after) {
  const failures = [];
  if (!before || !after) failures.push("missing-runtime-snapshot");
  if (before?.protocolVersion !== after?.protocolVersion) failures.push("initialize-protocol-changed");
  if (before?.protocolVersion !== MCP_PROTOCOL_VERSION || after?.protocolVersion !== MCP_PROTOCOL_VERSION) {
    failures.push("unsupported-initialize-protocol");
  }
  if (JSON.stringify(sortedUnique(before?.toolNames || [])) !== JSON.stringify(sortedUnique(after?.toolNames || []))) {
    failures.push("tools-list-changed");
  }
  if (
    sortedUnique(before?.toolNames || []).length !== CODEX_COUNTS.mcpTools
    || sortedUnique(after?.toolNames || []).length !== CODEX_COUNTS.mcpTools
  ) {
    failures.push("unexpected-tool-count");
  }
  if (!before?.toolNames?.includes("muster_detect") || !after?.toolNames?.includes("muster_detect")) {
    failures.push("muster-detect-tool-missing");
  }
  if (before?.representativeCall?.name !== after?.representativeCall?.name) failures.push("representative-tool-changed");
  if (before?.representativeCall?.ok !== true || after?.representativeCall?.ok !== true) failures.push("representative-call-failed");
  if (
    JSON.stringify(sortedUnique(before?.representativeCall?.resultShape || []))
    !== JSON.stringify(sortedUnique(after?.representativeCall?.resultShape || []))
  ) {
    failures.push("representative-result-shape-changed");
  }
  if ([before, after].some(snapshot => REQUIRED_DETECT_FIELDS.some(
    field => !snapshot?.representativeCall?.resultShape?.includes(field)
  ))) {
    failures.push("representative-result-shape-invalid");
  }
  if (failures.length) {
    return { status: "FAIL", reason: "mcp-contract-changed-across-rebuild", failures };
  }
  return {
    status: "PASS",
    reason: "mcp-contract-stable-across-rebuild",
    protocolVersion: after.protocolVersion,
    toolCount: sortedUnique(after.toolNames).length,
    representativeTool: after.representativeCall.name,
  };
}

export function evaluateConnectionReuse() {
  return {
    status: "UNKNOWN",
    reason: "host-internal-mcp-connection-identity-unobservable",
    observed: false,
  };
}

async function generatedSkillNames(pluginRoot) {
  const skillsRoot = join(pluginRoot, "skills");
  const dirs = (await readdir(skillsRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  return Promise.all(dirs.map(async dir => {
    const text = await readFile(join(skillsRoot, dir, "SKILL.md"), "utf8");
    const name = text.match(/^name:\s*(.+?)\s*$/m)?.[1];
    if (!name) throw new Error(`generated skill ${dir} has no frontmatter name`);
    return name;
  }));
}

export function validateGeneratedSkillInventory(observedNames = []) {
  const observed = sortedUnique(observedNames);
  const expected = sortedUnique(CODEX_0146_PUBLIC_SKILLS);
  const missing = expected.filter(name => !observed.includes(name));
  const unexpected = observed.filter(name => !expected.includes(name));
  if (
    expected.length !== CODEX_COUNTS.publicSkills
    || observed.length !== CODEX_COUNTS.publicSkills
    || missing.length
    || unexpected.length
  ) {
    return {
      status: "FAIL",
      reason: "generated-public-skill-inventory-mismatch",
      expectedCount: CODEX_COUNTS.publicSkills,
      observedCount: observed.length,
      missing,
      unexpected,
    };
  }
  return {
    status: "PASS",
    reason: "generated-public-skill-inventory-matches-canonical-contract",
    expectedCount: CODEX_COUNTS.publicSkills,
    observedCount: observed.length,
  };
}

async function mcpSnapshot(entrypoint, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entrypoint], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const responses = new Map();
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolvePromise(value);
    };
    const timer = setTimeout(
      () => finish(new Error(`MCP compatibility probe timed out: ${stderr.slice(0, 500)}`)),
      MCP_TIMEOUT_MS
    );
    child.on("error", error => finish(error));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => {
      stderr = (stderr + chunk).slice(-MCP_OUTPUT_CAP);
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
      if (stdout.length > MCP_OUTPUT_CAP) {
        finish(new Error(`MCP compatibility probe exceeded ${MCP_OUTPUT_CAP} stdout characters`));
        return;
      }
      const lines = stdout.split("\n");
      stdout = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish(new Error("MCP compatibility probe received invalid JSON-RPC output"));
          return;
        }
        if (message.id !== undefined) responses.set(message.id, message);
      }
      if (![1, 2, 3].every(id => responses.has(id))) return;
      const initialize = responses.get(1);
      const tools = responses.get(2);
      const call = responses.get(3);
      if (initialize.error || tools.error || call.error) {
        finish(new Error(`MCP compatibility probe received JSON-RPC error: ${JSON.stringify({ initialize: initialize.error, tools: tools.error, call: call.error })}`));
        return;
      }
      const text = call.result?.content?.find(item => item.type === "text")?.text;
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        finish(new Error("muster_detect returned no JSON object"));
        return;
      }
      finish(null, {
        protocolVersion: initialize.result?.protocolVersion,
        toolNames: (tools.result?.tools || []).map(tool => tool.name).sort(),
        representativeCall: {
          name: "muster_detect",
          ok: call.result?.isError !== true && parsed && typeof parsed === "object",
          resultShape: Object.keys(parsed || {}).sort(),
        },
      });
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "muster-codex-0146-probe", version: "1" } },
    })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "muster_detect", arguments: { dir: cwd } } })}\n`);
  });
}

async function buildAndSnapshot(root, force) {
  await execFile(process.execPath, ["scripts/build-codex.mjs"], {
    cwd: root,
    env: { ...process.env, ...(force ? { MUSTER_BUILD_FORCE: "1" } : {}) },
    timeout: 90_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const { pluginRoot } = await resolveCodexPlugin(root);
  return {
    pluginRoot,
    snapshot: await mcpSnapshot(join(pluginRoot, "runtime", "muster-mcp.mjs"), root),
  };
}

export async function runCompatibilityProbe({ root = defaultRoot, catalogEvidencePath } = {}) {
  const absoluteRoot = resolve(root);
  const before = await buildAndSnapshot(absoluteRoot, false);
  const after = await buildAndSnapshot(absoluteRoot, true);
  const evidence = catalogEvidencePath
    ? JSON.parse(await readFile(resolve(catalogEvidencePath), "utf8"))
    : undefined;
  const observedSkills = await generatedSkillNames(after.pluginRoot);
  const canonicalExpectedSkills = CODEX_0146_PUBLIC_SKILLS.map(name => ({
    name,
    locator: `/skills/${name}/SKILL.md`,
  }));
  const results = {
    generatedSkillInventory: validateGeneratedSkillInventory(observedSkills),
    skillCatalog: evaluateSkillCatalogEvidence({
      expectedSkills: canonicalExpectedSkills,
      evidence,
    }),
    mcpContract: compareMcpContracts(before.snapshot, after.snapshot),
    connectionReuse: evaluateConnectionReuse(),
  };
  const statuses = Object.values(results).map(result => result.status);
  const status = statuses.includes("FAIL") ? "FAIL" : statuses.includes("UNKNOWN") ? "UNKNOWN" : "PASS";
  return {
    probe: "codex-0.146-skill-mcp-compatibility",
    status,
    boundaries: {
      mcpContract: "repository-observable generated runtime behavior",
      connectionReuse: "host-internal connection identity is not exposed",
    },
    results,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--muster-root") options.root = argv[++index];
    else if (arg === "--catalog-evidence") options.catalogEvidencePath = argv[++index];
    else if (arg === "--json") continue;
    else throw new Error(`unknown argument: ${arg}`);
    if ((arg === "--muster-root" || arg === "--catalog-evidence") && !argv[index]) {
      throw new Error(`${arg} requires a value`);
    }
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await runCompatibilityProbe(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status === "FAIL") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}
