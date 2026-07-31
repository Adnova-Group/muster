import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CODEX_SECURITY_UPSTREAM = Object.freeze({
  package: "@openai/codex-security",
  version: "0.1.5",
  tag: "npm-v0.1.5",
  commit: "66778d0d85f478d7832854b81d0a6ddb93a3ce4c",
  integrity: "sha512-P6RZCrtZjQ23TG55VVYdrz5+/o5SGt4A3xDy18C/1ZqhfbRQYFzZIVP+HzfR2j0HaJv0l1KsKzuKtR8UOeK/UQ==",
  license: "Apache-2.0",
});

const RISK_TEXT = /\b(auth(?:entication|orization)?|oauth|jwt|token|secret|credential|crypto|encrypt|permission|privilege|sandbox|injection|xss|csrf|ssrf|deserializ|upload|webhook|payment|security|vulnerab|exploit|dependency|supply.chain)\b/i;
const RISK_PATH = /(^|\/)(auth|security|crypto|payments?|middleware|routes?|api)(\/|\.|$)|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Dockerfile|.*\.ya?ml)$/i;
const MAX_SECURITY_OUTPUT_BYTES = 192 * 1024 * 1024;

export function securityAuditWarranted({ outcome = "", diffFiles = [], diffText = "" } = {}) {
  const reasons = [];
  if (RISK_TEXT.test(`${outcome}\n${diffText}`)) reasons.push("security-sensitive intent or diff content");
  const riskyPaths = (Array.isArray(diffFiles) ? diffFiles : []).filter((path) => RISK_PATH.test(path));
  if (riskyPaths.length) reasons.push(`risk-bearing paths: ${riskyPaths.join(", ")}`);
  return { warranted: reasons.length > 0, reasons };
}

export function buildSecurityInvocation(workflow, repository, options = {}) {
  const repo = resolve(repository || process.cwd());
  if (!new Set(["review", "audit"]).has(workflow)) throw new Error(`unknown security workflow "${workflow}"`);
  const args = ["scan", repo];
  if (workflow === "review") {
    if (options.base) args.push("--diff", options.base);
    else args.push("--working-tree");
  } else {
    for (const path of options.paths || []) args.push("--path", path);
    if (options.deep) args.push("--mode", "deep");
  }
  args.push("--json");
  if (options.auth) args.push("--auth", options.auth);
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  if (options.failOnSeverity) args.push("--fail-on-severity", options.failOnSeverity);
  if (options.maxCost) args.push("--max-cost", String(options.maxCost));
  if (options.outputDir) args.push("--output-dir", resolve(options.outputDir));
  return { command: resolveCodexSecurityBinary(options.env), args };
}

function validateSecurityEnvelope(value) {
  const findings = value?.findings;
  const coverage = value?.coverage;
  if (findings?.documentType !== "codex-security.findings" || findings?.schemaVersion !== "1.0" ||
      typeof findings.scanId !== "string" || !Array.isArray(findings.findings))
    throw new Error("Codex Security returned an invalid findings document envelope");
  if (coverage?.documentType !== "codex-security.coverage" || coverage?.schemaVersion !== "1.0" ||
      coverage.scanId !== findings.scanId || coverage.completeness !== "complete")
    throw new Error("Codex Security returned invalid or incomplete coverage");
  if (typeof value.reportPath !== "string" || !value.reportPath.trim() || !isAbsolute(value.reportPath))
    throw new Error("Codex Security returned an invalid report path");
  return { findings: findings.findings, coverage, reportPath: value.reportPath };
}

function findingSeverity(finding) {
  const value = finding?.severity;
  return String(typeof value === "object" && value !== null ? value.level || "" : value || "").toLowerCase();
}

function findingLocation(finding) {
  if (Array.isArray(finding?.locations) && finding.locations.length) {
    const location = finding.locations[0];
    if (location?.path) return `${location.path}${location.startLine ? `:${location.startLine}` : ""}`;
  }
  return finding?.location || finding?.file || finding?.path || null;
}

export function normalizeSecurityReceipt(result) {
  const envelope = validateSecurityEnvelope(result);
  const findings = envelope.findings.map((finding, index) => {
    const severity = findingSeverity(finding);
    if (!severity) throw new Error(`Codex Security finding ${index + 1} is missing severity`);
    const location = findingLocation(finding);
    const codeProof = Array.isArray(finding.codeEvidence)
      ? finding.codeEvidence.map(entry => entry?.explanation).filter(value => typeof value === "string" && value.trim()).join("; ")
      : "";
    const proof = [finding.evidence, codeProof, finding.reproduction, finding.summary, finding.description]
      .find(value => typeof value === "string" && value.trim());
    if (!proof) throw new Error(`Codex Security finding ${index + 1} is missing evidence`);
    return {
      severity,
      title: finding.title || finding.name || `finding-${index + 1}`,
      evidence: location ? `${location} — ${proof}` : String(proof),
      ...(finding.findingId || finding.id ? { id: finding.findingId || finding.id } : {}),
    };
  });
  return {
    format: "muster.security-receipt",
    upstream: CODEX_SECURITY_UPSTREAM,
    findings,
    coverage: envelope.coverage,
    reportPath: envelope.reportPath,
  };
}

function resolveCodexSecurityBinary(env = process.env) {
  if (env?.MUSTER_CODEX_SECURITY_BIN) return env.MUSTER_CODEX_SECURITY_BIN;
  const root = dirname(fileURLToPath(import.meta.url));
  const suffix = process.platform === "win32" ? ".cmd" : "";
  const local = join(root, "..", "node_modules", ".bin", `codex-security${suffix}`);
  const project = join(process.cwd(), "node_modules", ".bin", `codex-security${suffix}`);
  for (const binary of [local, project]) if (existsSync(binary)) return binary;
  // Codex plugin caches do not install nested npm dependencies. The exact-version
  // check below makes a PATH-resolved project/global CLI safe instead of trusting drift.
  return `codex-security${suffix}`;
}

function cleanVersion(stdout) {
  const match = String(stdout || "").match(/\d+\.\d+\.\d+/);
  return match?.[0] || String(stdout || "").trim();
}

export function runSecurityWorkflow(workflow, repository, options = {}) {
  try {
    const invocation = buildSecurityInvocation(workflow, repository, options);
    const runOpts = { cwd: resolve(repository || process.cwd()), env: options.env || process.env, encoding: "utf8", maxBuffer: MAX_SECURITY_OUTPUT_BYTES };
    const version = spawnSync(invocation.command, ["--version"], runOpts);
    if (version.error) throw new Error(`Codex Security dependency failed to start: ${version.error.message}`);
    if (version.status !== 0) throw new Error(`Codex Security version check failed (${version.status}): ${version.stderr || version.stdout}`.trim());
    const actual = cleanVersion(version.stdout);
    if (actual !== CODEX_SECURITY_UPSTREAM.version) throw new Error(`Codex Security version drift: expected ${CODEX_SECURITY_UPSTREAM.version}, got ${actual || "unknown"}`);

    const run = spawnSync(invocation.command, invocation.args, runOpts);
    if (run.error) throw new Error(`Codex Security execution failed: ${run.error.message}`);
    if (run.status === 2) throw new Error(`Codex Security incomplete coverage or runtime failure (exit 2): ${String(run.stderr || run.stdout).trim()}`);
    if (run.status !== 0 && run.status !== 1) throw new Error(`Codex Security failed with unexpected exit ${run.status}: ${run.stderr || run.stdout}`.trim());
    let parsed;
    try { parsed = JSON.parse(run.stdout); }
    catch (error) { throw new Error(`Codex Security returned invalid JSON: ${error.message}`); }
    return {
      ...normalizeSecurityReceipt(parsed),
      workflow,
      classification: run.status === 1 ? "finding-policy" : "complete",
      exitCode: run.status,
    };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.exitCode = 2;
    throw failure;
  }
}
