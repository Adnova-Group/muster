#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { connect } from "node:net";

const [kind, requestPath] = process.argv.slice(2);
if (!['receipt', 'approval'].includes(kind) || !requestPath) {
  process.stderr.write("usage: sprint-evidence-callback.mjs <receipt|approval> <request.json>\n");
  process.exit(2);
}
const socketPath = process.env.MUSTER_EVIDENCE_BROKER_SOCKET;
const token = process.env.MUSTER_EVIDENCE_CALLBACK_TOKEN;
if (!socketPath || !token) {
  process.stderr.write("privileged broker socket and callback token are required\n");
  process.exit(2);
}
const request = JSON.parse(await readFile(requestPath, "utf8"));
const response = await new Promise((resolve, reject) => {
  const socket = connect(socketPath);
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("connect", () => socket.end(`${JSON.stringify({ token, kind, request })}\n`));
  socket.on("data", (chunk) => { buffer += chunk; });
  socket.on("end", () => resolve(JSON.parse(buffer.trim())));
  socket.on("error", reject);
});
if (!response.ok) {
  process.stderr.write(`${response.error}\n`);
  process.exit(2);
}
process.stdout.write(`${JSON.stringify(response.result)}\n`);
