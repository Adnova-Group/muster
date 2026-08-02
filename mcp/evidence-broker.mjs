import { createServer } from "node:net";
import { chmodSync } from "node:fs";
import {
  authenticateSprintBrokerCallback,
  issueSprintApproval,
  issueSprintReceipt,
} from "../src/sprint-evidence-broker.js";

const MAX_REQUEST_BYTES = 1_048_576;

export function startSprintEvidenceBroker({
  socketPath, state, loadState, consumeApprovalCapability,
  receiptPrivateKey, approvalPrivateKey, approvalPublicKey,
} = {}) {
  if (typeof socketPath !== "string" || !socketPath) throw new Error("evidence broker socket path is required");
  if (typeof loadState !== "function" && (!state || typeof state !== "object" || typeof state.runId !== "string")) {
    throw new Error("evidence broker trusted state is required");
  }
  const resolveState = typeof loadState === "function" ? loadState : async () => state;
  let authWindowStarted = Date.now();
  let failedAuth = 0;
  const server = createServer((connection) => {
    connection.setTimeout(5_000, () => connection.destroy());
    let buffer = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        connection.end(`${JSON.stringify({ ok: false, error: "broker request exceeds byte limit" })}\n`);
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = "";
      Promise.resolve().then(async () => {
        const envelope = JSON.parse(line);
        const loaded = await resolveState();
        const snapshot = typeof loaded?.contentHash === "string" && loaded?.state
          ? loaded
          : { state: loaded, version: loaded?.version, contentHash: undefined };
        const currentState = snapshot.state;
        if (Date.now() - authWindowStarted > 60_000) { authWindowStarted = Date.now(); failedAuth = 0; }
        if (failedAuth >= 8) throw new Error("broker callback authentication throttled");
        let principal;
        try { principal = authenticateSprintBrokerCallback(envelope.token, currentState); }
        catch (error) { failedAuth += 1; throw error; }
        const result = envelope.kind === "receipt"
          ? issueSprintReceipt(envelope.request, {
            state: currentState, principal, receiptPrivateKey, approvalPublicKey,
          })
          : envelope.kind === "approval"
            ? await (async () => {
              const issued = issueSprintApproval(envelope.request, {
                state: currentState, principal, approvalPrivateKey,
              });
              if (typeof consumeApprovalCapability !== "function") throw new Error("approval capability consumer unavailable");
              await consumeApprovalCapability(principal.tokenDigest, {
                version: snapshot.version,
                contentHash: snapshot.contentHash,
              });
              return issued;
            })()
            : (() => { throw new Error("unknown broker request kind"); })();
        connection.end(`${JSON.stringify({ ok: true, result })}\n`);
      }).catch((error) => {
        connection.end(`${JSON.stringify({ ok: false, error: error.message })}\n`);
      });
    });
  });
  server.maxConnections = 32;
  server.listen(socketPath, () => {
    if (process.platform === "win32") {
      server.close();
      throw new Error("evidence broker requires an explicitly ACL-hardened named-pipe adapter on Windows");
    }
    chmodSync(socketPath, 0o600);
  });
  return server;
}
