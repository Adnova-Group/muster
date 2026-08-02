import { createServer } from "node:net";
import {
  authenticateSprintBrokerCallback,
  issueSprintApproval,
  issueSprintReceipt,
} from "../src/sprint-evidence-broker.js";

const MAX_REQUEST_BYTES = 1_048_576;

export function startSprintEvidenceBroker({
  socketPath, state, receiptPrivateKey, approvalPrivateKey, approvalPublicKey,
} = {}) {
  if (typeof socketPath !== "string" || !socketPath) throw new Error("evidence broker socket path is required");
  if (!state || typeof state !== "object" || typeof state.runId !== "string") {
    throw new Error("evidence broker trusted state is required");
  }
  const server = createServer((connection) => {
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
      try {
        const envelope = JSON.parse(line);
        const principal = authenticateSprintBrokerCallback(envelope.token, state);
        const result = envelope.kind === "receipt"
          ? issueSprintReceipt(envelope.request, {
            state, principal, receiptPrivateKey, approvalPublicKey,
          })
          : envelope.kind === "approval"
            ? issueSprintApproval(envelope.request, {
              state, principal, approvalPrivateKey,
            })
            : (() => { throw new Error("unknown broker request kind"); })();
        connection.end(`${JSON.stringify({ ok: true, result })}\n`);
      } catch (error) {
        connection.end(`${JSON.stringify({ ok: false, error: error.message })}\n`);
      }
    });
  });
  server.listen(socketPath);
  return server;
}
