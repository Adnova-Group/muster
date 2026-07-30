#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";
import { resolveMusterCli, startMusterMcpServer } from "./server.mjs";

const profile = process.env.MUSTER_CHATGPT_WORK_PROFILE;
let probeState = null;
if (!["pro-safe", "full"].includes(profile)) {
  process.stderr.write("chatgpt-work-server: MUSTER_CHATGPT_WORK_PROFILE must be pro-safe or full\n");
  process.exit(1);
}
if (process.env.MUSTER_CHATGPT_WORK_PLUGIN_PATH || process.env.MUSTER_CHATGPT_WORK_RECEIPT_PATH) {
  try {
    const pluginPath = process.env.MUSTER_CHATGPT_WORK_PLUGIN_PATH;
    if (!pluginPath || !path.isAbsolute(pluginPath)) throw new Error("installed plugin path is required");
    let current = path.parse(pluginPath).root;
    for (const part of path.relative(current, pluginPath).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const info = lstatSync(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${current} is not an ordinary directory`);
    }
    for (const candidate of [path.dirname(path.dirname(pluginPath)), path.dirname(pluginPath), pluginPath]) {
      const info = lstatSync(candidate);
      if (process.platform !== "win32" && typeof process.getuid === "function"
        && (info.uid !== process.getuid() || (info.mode & 0o022) !== 0)) {
        throw new Error(`${candidate} must be current-user-owned and not group/world-writable`);
      }
    }
  } catch (error) {
    process.stderr.write(`chatgpt-work-server: installed plugin publication path rejected (${error.code || error.message})\n`);
    process.exit(1);
  }
}
if (profile === "full" && (
  process.env.MUSTER_CHATGPT_WORK_INSTALL_ALLOW_FULL_ACTIONS !== "1"
  || process.env.MUSTER_CHATGPT_WORK_SERVER_ALLOW_FULL_ACTIONS !== "1"
)) {
  process.stderr.write("chatgpt-work-server: full requires installer and server allow-full-actions opt-ins\n");
  process.exit(1);
}
const activationReceiptPath = process.env.MUSTER_CHATGPT_WORK_RECEIPT_PATH;
const installedRuntime = existsSync(new URL("./muster.mjs", import.meta.url));
if (profile === "full" || activationReceiptPath || installedRuntime) {
  try {
    const receiptPath = activationReceiptPath;
    const pluginPath = process.env.MUSTER_CHATGPT_WORK_PLUGIN_PATH;
    const connectionId = process.env.MUSTER_CHATGPT_WORK_CONNECTION_ID;
    const appPath = process.env.MUSTER_CHATGPT_WORK_APP_JSON_PATH;
    const pluginVersion = process.env.MUSTER_CHATGPT_WORK_PLUGIN_VERSION;
    if (!receiptPath || !pluginPath || !connectionId || !appPath || !pluginVersion
      || !path.isAbsolute(receiptPath) || !path.isAbsolute(pluginPath)
      || path.resolve(appPath) !== path.resolve(pluginPath, ".app.json")) {
      throw new Error("activation paths and identity are required");
    }
    const receiptInfo = lstatSync(receiptPath);
    if (receiptInfo.isSymbolicLink() || !receiptInfo.isFile()
      || (process.platform !== "win32" && ((receiptInfo.mode & 0o077) !== 0
        || (typeof process.getuid === "function" && receiptInfo.uid !== process.getuid())))) {
      throw new Error("receipt must be a private current-user ordinary file");
    }
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (receipt.format !== 3 || receipt.owner !== "muster" || receipt.artifactFlavor !== "chatgpt-work"
      || receipt.profile !== profile || receipt.allowFullActions !== (profile === "full")
      || receipt.connectionId !== connectionId || receipt.appId !== connectionId
      || path.resolve(receipt.pluginPath ?? "") !== path.resolve(pluginPath)) {
      throw new Error("receipt identity/profile mismatch");
    }
    // Must stay identical to ARTIFACT_PATHS in src/chatgpt-work-install.js --
    // the receipt artifact set is pinned by
    // test/chatgpt-work-artifact-parity.test.js, and any drift hard-fails
    // server startup here on "receipt artifact set mismatch".
    const artifactPaths = [
      ".app.json", ".codex-plugin/plugin.json", ".mcp.json",
      "runtime/chatgpt-work-server.mjs", "runtime/muster.mjs", "runtime/sprint-protocol.md",
      "package.json",
      ...[
        "agents.generated.yaml", "agents.manifest.json", "agents.muster.yaml",
        "builtins.generated.yaml", "builtins.muster.yaml", "software.yaml",
      ].map(relative => `catalog/${relative}`),
      ...[
        "ai-implementation-spec.yaml", "ai-test-plan.yaml", "blog-post.yaml", "book.yaml",
        "business-case.yaml", "case-study.yaml", "competitive-battlecard.yaml", "epic.yaml",
        "executive-summary.yaml", "launch-plan.yaml", "lead-magnet.yaml", "newsletter.yaml",
        "okrs.yaml", "prd.yaml", "release-notes.yaml", "roadmap.yaml", "runbook.yaml",
        "social-post.yaml", "user-story.yaml", "video-content.yaml",
      ].map(relative => `pipelines/${relative}`),
    ];
    if (Object.keys(receipt.artifacts ?? {}).sort().join("\0") !== artifactPaths.slice().sort().join("\0")) {
      throw new Error("receipt artifact set mismatch");
    }
    for (const relative of artifactPaths) {
      const artifactPath = path.join(pluginPath, ...relative.split("/"));
      const info = lstatSync(artifactPath);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${relative} is not an ordinary file`);
      const digest = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
      if (digest !== receipt.artifacts[relative]) throw new Error(`${relative} digest mismatch`);
    }
    const app = JSON.parse(readFileSync(appPath, "utf8"));
    const manifest = JSON.parse(readFileSync(path.join(pluginPath, ".codex-plugin", "plugin.json"), "utf8"));
    if (JSON.stringify(app) !== JSON.stringify({ apps: { muster: { id: connectionId } } })
      || manifest.name !== "muster-chatgpt-work" || manifest.version !== pluginVersion) {
      throw new Error("installed app/plugin identity mismatch");
    }
  } catch (error) {
    process.stderr.write(`chatgpt-work-server: installed activation receipt rejected (${error.code || error.message})\n`);
    process.exit(1);
  }
}
const probeNonce = process.env.MUSTER_CHATGPT_WORK_PROBE_NONCE;
const probeAttestationPath = process.env.MUSTER_CHATGPT_WORK_PROBE_ATTESTATION_PATH;
const probeRequested = probeNonce !== undefined || probeAttestationPath !== undefined;
if (probeRequested) {
  if (process.platform === "win32") {
    process.stderr.write("chatgpt-work-server: HUMAN-HOLD probe privacy/ownership cannot be established on Windows\n");
    process.exit(1);
  }
  if (profile !== "pro-safe") {
    process.stderr.write("chatgpt-work-server: probe startup requires profile pro-safe\n");
    process.exit(1);
  }
  if (!/^[a-f0-9]{32}$/.test(probeNonce ?? "")) {
    process.stderr.write("chatgpt-work-server: probe nonce must be 32 lowercase hexadecimal characters\n");
    process.exit(1);
  }
  let parent = null;
  try {
    parent = probeAttestationPath && path.isAbsolute(probeAttestationPath)
      ? statSync(path.dirname(probeAttestationPath))
      : null;
  } catch {
    parent = null;
  }
  const privatePosixDirectory = (typeof process.getuid !== "function" || parent?.uid === process.getuid())
    && (parent?.mode & 0o077) === 0;
  if (
    !probeAttestationPath
    || !path.isAbsolute(probeAttestationPath)
    || path.basename(probeAttestationPath) !== "server-attestation.json"
    || !parent?.isDirectory()
    || !privatePosixDirectory
    || existsSync(probeAttestationPath)
  ) {
    process.stderr.write("chatgpt-work-server: probe attestation must be a new absolute server-attestation.json in an existing private probe-owned directory\n");
    process.exit(1);
  }
  let current = path.parse(path.dirname(probeAttestationPath)).root;
  for (const part of path.relative(current, path.dirname(probeAttestationPath)).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (lstatSync(current).isSymbolicLink()) {
      process.stderr.write("chatgpt-work-server: probe path ancestry must not contain symlinks\n");
      process.exit(1);
    }
  }
  const rawConnectionId = process.env.MUSTER_CHATGPT_WORK_CONNECTION_ID;
  const connectionId = rawConnectionId?.startsWith("plugin_") ? rawConnectionId.slice(7) : rawConnectionId;
  const appPath = process.env.MUSTER_CHATGPT_WORK_APP_JSON_PATH;
  const pluginVersion = process.env.MUSTER_CHATGPT_WORK_PLUGIN_VERSION;
  const connectionLabel = process.env.MUSTER_CHATGPT_WORK_CONNECTION_LABEL;
  if (
    !/^asdk_app_[A-Za-z0-9][A-Za-z0-9_-]*$/.test(connectionId ?? "")
    || !appPath || !path.isAbsolute(appPath) || path.basename(appPath) !== ".app.json"
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(pluginVersion ?? "")
    || typeof connectionLabel !== "string" || !connectionLabel.trim() || connectionLabel.length > 200
  ) {
    process.stderr.write("chatgpt-work-server: probe requires canonical connection/app/plugin-version/connection-label identity\n");
    process.exit(1);
  }
  let appBytes;
  try {
    let appAncestor = path.parse(path.dirname(appPath)).root;
    for (const part of path.relative(appAncestor, path.dirname(appPath)).split(path.sep).filter(Boolean)) {
      appAncestor = path.join(appAncestor, part);
      if (lstatSync(appAncestor).isSymbolicLink()) throw new Error("app ancestry contains symlink");
    }
    const appInfo = lstatSync(appPath);
    if (appInfo.isSymbolicLink() || !appInfo.isFile()) throw new Error("not ordinary");
    appBytes = readFileSync(appPath, "utf8");
    const app = JSON.parse(appBytes);
    if (
      JSON.stringify(app) !== JSON.stringify({ apps: { muster: { id: connectionId } } })
    ) throw new Error("shape/id mismatch");
  } catch (error) {
    process.stderr.write(`chatgpt-work-server: installed .app.json identity validation failed (${error.message})\n`);
    process.exit(1);
  }
  const probeDir = path.dirname(probeAttestationPath);
  const instancePath = path.join(probeDir, "server-instance.json");
  let serverInstanceId;
  try {
    if (existsSync(instancePath)) {
      const info = lstatSync(instancePath);
      if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0
        || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
        throw new Error("instance state is not a private current-user ordinary file");
      }
      serverInstanceId = JSON.parse(readFileSync(instancePath, "utf8")).serverInstanceId;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(serverInstanceId ?? "")) {
        throw new Error("invalid instance id");
      }
    } else {
      serverInstanceId = randomUUID();
      const fd = openSync(instancePath, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ serverInstanceId }) + "\n");
      closeSync(fd);
    }
    const noncePath = path.join(probeDir, `.nonce-${probeNonce}`);
    const nonceFd = openSync(noncePath, "wx", 0o600);
    writeFileSync(nonceFd, JSON.stringify({ nonce: probeNonce, serverInstanceId }) + "\n");
    closeSync(nonceFd);
  } catch (error) {
    process.stderr.write(`chatgpt-work-server: probe nonce/instance state rejected (${error.code || error.message})\n`);
    process.exit(1);
  }
  const identity = {
    connectionIdSha256: createHash("sha256").update(connectionId).digest("hex"),
    pluginAppSha256: createHash("sha256").update(appBytes).digest("hex"),
    pluginName: "muster",
    pluginVersion,
    connectionLabel,
  };
  const request = {
    items: [{
      name: `WORK_WEB_PROBE_${probeNonce}`,
      reach: 2, impact: 3, confidence: 1, effort: 2,
    }],
    model: "rice",
  };
  probeState = {
    nonce: probeNonce,
    attestationPath: probeAttestationPath,
    parentId: `${parent.dev}:${parent.ino}`,
    request,
    result: [{ ...request.items[0], score: 3, rank: 1 }],
    identity,
    serverInstanceId,
    invoked: false,
  };
}

const cleanEnv = {};
for (const key of ["PATH", "Path", "SystemRoot", "ComSpec", "PATHEXT"]) {
  if (process.env[key] !== undefined) cleanEnv[key] = process.env[key];
}
for (const key of ["TMPDIR", "TMP", "TEMP"]) {
  const value = process.env[key];
  try {
    if (value && path.isAbsolute(value) && statSync(value).isDirectory() && !lstatSync(value).isSymbolicLink()) cleanEnv[key] = value;
  } catch { /* invalid temp override is intentionally stripped */ }
}
let sprintProtocol;
for (const relative of ["./sprint-protocol.md", "../cowork/sprint-protocol.md"]) {
  try { sprintProtocol = readFileSync(new URL(relative, import.meta.url), "utf8").trim(); break; } catch { /* try source layout */ }
}
const safeDescriptor = (tool) => ({
  ...tool,
  title: "Prioritize backlog items",
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
});

const authorizeTools = (catalog) => {
  if (probeState) {
    const item = probeState.request.items[0];
    return {
      profileName: "chatgpt-work-probe",
      instructions: "Call muster_prioritize exactly once with the exact nonce-bearing request.",
      tools: {
        muster_prioritize: {
          ...safeDescriptor(catalog.muster_prioritize),
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              items: {
                type: "array", minItems: 1, maxItems: 1,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    name: { type: "string", const: item.name },
                    reach: { type: "number", const: 2 },
                    impact: { type: "number", const: 3 },
                    confidence: { type: "number", const: 1 },
                    effort: { type: "number", const: 2 },
                  },
                  required: ["name", "reach", "impact", "confidence", "effort"],
                },
              },
              model: { type: "string", const: "rice" },
            },
            required: ["items", "model"],
          },
        },
      },
      invoke: async ({ name, args, signal, callTool }) => {
        if (name !== "muster_prioritize" || !isDeepStrictEqual(args, probeState.request)) {
          return { ok: false, text: "ChatGPT Work probe arguments do not exactly match the nonce-bound request" };
        }
        if (probeState.invoked) return { ok: false, text: "ChatGPT Work probe permits exactly one invocation" };
        probeState.invoked = true;
        const cliResult = await callTool(name, args, signal);
        if (!cliResult.ok) return cliResult;
        let parsed;
        try { parsed = JSON.parse(cliResult.text); }
        catch { return { ok: false, text: "ChatGPT Work probe CLI result was not valid JSON" }; }
        if (!isDeepStrictEqual(parsed, probeState.result)) {
          return { ok: false, text: "ChatGPT Work probe CLI result did not exactly match the deterministic result" };
        }
        const attestation = {
          attestationType: "muster-work-native-server-attestation",
          source: "server",
          nonce: probeState.nonce,
          tool: "muster_prioritize",
          request: probeState.request,
          result: probeState.result,
          identity: probeState.identity,
          serverInstanceId: probeState.serverInstanceId,
          invocationCount: 1,
          timestamp: new Date().toISOString(),
        };
        let file;
        try {
          const parent = lstatSync(path.dirname(probeState.attestationPath));
          if (parent.isSymbolicLink() || `${parent.dev}:${parent.ino}` !== probeState.parentId) {
            throw new Error("probe attestation parent changed after startup");
          }
          file = await open(probeState.attestationPath, "wx", 0o600);
          await file.writeFile(JSON.stringify(attestation, null, 2) + "\n", "utf8");
          await file.sync();
        } catch (error) {
          return { ok: false, text: `ChatGPT Work probe attestation creation failed: ${error.code || error.message}` };
        } finally {
          await file?.close();
        }
        return cliResult;
      },
    };
  }
  if (profile === "pro-safe") {
    return {
      profileName: "chatgpt-work-pro-safe",
      instructions: "Use muster_prioritize to rank backlog items.",
      tools: { muster_prioritize: safeDescriptor(catalog.muster_prioritize) },
    };
  }
  return {
    profileName: "chatgpt-work-full",
    instructions: "Muster deterministic tool-only surface for ChatGPT Work. Tool metadata is authoritative; no host workflow or configuration is implied.",
    tools: catalog,
  };
};

const mapWorkArgv = (name, argv) => {
  switch (name) {
    case "muster_capabilities":
      return ["capabilities", "--work"];
    case "muster_capabilities_roles":
      return ["capabilities", "--roles-only", "--work"];
    case "muster_match":
      return ["match", "--work"];
    case "muster_match_skills":
      return ["match", "--work", "--skills"];
    case "muster_manifest_validate":
      return ["manifest", "validate", "--work"];
    case "muster_diagnose":
      return ["diagnose", "--work"];
    case "muster_audit":
      return ["audit", "--work"];
    default:
      return argv;
  }
};

startMusterMcpServer({
  protocol: "Running Muster in ChatGPT Work. Treat the selected tool profile as the complete capability boundary.",
  runtimeIdentity: "work",
  cliPath: resolveMusterCli(process.env.NODE_ENV === "test" ? process.env.MUSTER_COWORK_TEST_CLI : undefined),
  environment: cleanEnv,
  cwd: process.cwd(),
  io: process,
  maxInflight: 4,
  maxQueue: 16,
  staticTools: { muster_sprint_protocol: sprintProtocol || { error: "muster_sprint_protocol: bundled playbook unavailable" } },
  mapArgv: mapWorkArgv,
  authorizeTools: authorizeTools,
});
