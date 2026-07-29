#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const profile = process.env.MUSTER_CHATGPT_WORK_PROFILE;
if (!["pro-safe", "full"].includes(profile)) {
  process.stderr.write("chatgpt-work-server: MUSTER_CHATGPT_WORK_PROFILE must be pro-safe or full\n");
  process.exit(1);
}
if (profile === "full" && (
  process.env.MUSTER_CHATGPT_WORK_INSTALL_ALLOW_FULL_ACTIONS !== "1"
  || process.env.MUSTER_CHATGPT_WORK_SERVER_ALLOW_FULL_ACTIONS !== "1"
)) {
  process.stderr.write("chatgpt-work-server: full requires installer and server allow-full-actions opt-ins\n");
  process.exit(1);
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
      if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) throw new Error("instance state is not private ordinary file");
      serverInstanceId = JSON.parse(readFileSync(instancePath, "utf8")).serverInstanceId;
      if (!/^[0-9a-f-]{36}$/.test(serverInstanceId ?? "")) throw new Error("invalid instance id");
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
  process.env.MUSTER_CHATGPT_WORK_PROBE_IDENTITY = JSON.stringify({
    connectionIdSha256: createHash("sha256").update(connectionId).digest("hex"),
    pluginAppSha256: createHash("sha256").update(appBytes).digest("hex"),
    pluginName: "muster",
    pluginVersion,
    connectionLabel,
  });
  process.env.MUSTER_CHATGPT_WORK_PROBE_SERVER_INSTANCE_ID = serverInstanceId;
  process.env.MUSTER_CHATGPT_WORK_PROBE_PARENT_ID = `${parent.dev}:${parent.ino}`;
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
cleanEnv.MUSTER_MCP_TOOL_PROFILE = probeRequested ? "chatgpt-work-probe" : `chatgpt-work-${profile}`;
if (probeRequested) {
  cleanEnv.MUSTER_MCP_PROBE_NONCE = probeNonce;
  cleanEnv.MUSTER_MCP_PROBE_ATTESTATION_PATH = probeAttestationPath;
  cleanEnv.MUSTER_MCP_PROBE_IDENTITY = process.env.MUSTER_CHATGPT_WORK_PROBE_IDENTITY;
  cleanEnv.MUSTER_MCP_PROBE_SERVER_INSTANCE_ID = process.env.MUSTER_CHATGPT_WORK_PROBE_SERVER_INSTANCE_ID;
  cleanEnv.MUSTER_MCP_PROBE_PARENT_ID = process.env.MUSTER_CHATGPT_WORK_PROBE_PARENT_ID;
}
cleanEnv.MUSTER_MCP_HOST = "work";
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, cleanEnv);
await import("./server.mjs");
