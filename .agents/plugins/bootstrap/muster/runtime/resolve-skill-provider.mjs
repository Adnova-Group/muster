#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PART = /^[A-Za-z0-9_.-]+$/;
const [source, id, asset] = process.argv.slice(2);
if (!["builtin", "installed"].includes(source)) throw new Error(`invalid skill provider source: ${JSON.stringify(source)}`);
if (!ID.test(id || "")) throw new Error(`invalid skill provider id: ${JSON.stringify(id)}`);
if (source === "installed") {
  if (asset !== undefined) throw new Error("installed skill providers do not expose bundled assets");
  process.stdout.write(`Invoke the already-enabled Codex skill explicitly as $${id}.\n`);
} else {
  const args = [join(dirname(fileURLToPath(import.meta.url)), "resolve-release.mjs"), asset === undefined ? "internal-skill" : "internal-asset", id];
  if (asset !== undefined) {
    const parts = asset.split("/");
    if (!parts.length || parts.some(part => !PART.test(part) || part === "." || part === "..")) throw new Error(`invalid internal asset path: ${JSON.stringify(asset)}`);
    args.push(asset);
  }
  const result = spawnSync(process.execPath, args, { encoding: null });
  if (result.status !== 0) { process.stderr.write(result.stderr || Buffer.alloc(0)); process.exitCode = result.status || 1; }
  else process.stdout.write(result.stdout);
}
