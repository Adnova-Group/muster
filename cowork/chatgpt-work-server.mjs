#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
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
  const privatePosixDirectory = process.platform === "win32"
    || (
      (typeof process.getuid !== "function" || parent?.uid === process.getuid())
      && (parent?.mode & 0o077) === 0
    );
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
}

const cleanEnv = {};
for (const key of ["PATH", "Path", "SystemRoot", "ComSpec", "PATHEXT"]) {
  if (process.env[key] !== undefined) cleanEnv[key] = process.env[key];
}
cleanEnv.MUSTER_MCP_TOOL_PROFILE = probeRequested ? "chatgpt-work-probe" : `chatgpt-work-${profile}`;
if (probeRequested) {
  cleanEnv.MUSTER_CHATGPT_WORK_PROBE_NONCE = probeNonce;
  cleanEnv.MUSTER_CHATGPT_WORK_PROBE_ATTESTATION_PATH = probeAttestationPath;
}
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, cleanEnv);
await import("./mcp-server.mjs");
