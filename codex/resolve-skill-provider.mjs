#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { readBundledAsset, resolveBundledSkillPath } from "./internal-asset-loader.mjs";

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function resolveSkillProvider(source, id, asset) {
  if (!new Set(["builtin", "installed"]).has(source)) throw new Error(`invalid skill provider source: ${JSON.stringify(source)}`);
  if (!ID.test(id || "")) throw new Error(`invalid skill provider id: ${JSON.stringify(id)}`);
  if (source === "installed") {
    if (asset !== undefined) throw new Error("installed skill providers do not expose bundled assets");
    return Buffer.from(`Invoke the already-enabled Codex skill explicitly as $${id}.\n`);
  }
  return readBundledAsset(id, asset);
}

export async function resolveSkillProviderPath(source, id) {
  if (source !== "builtin") throw new Error("only builtin skill providers expose a verified asset path");
  if (!ID.test(id || "")) throw new Error(`invalid skill provider id: ${JSON.stringify(id)}`);
  return resolveBundledSkillPath(id);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [source, id, asset, extra] = process.argv.slice(2);
  if (asset === "--path") {
    if (extra !== undefined) throw new Error("--path takes no asset argument");
    process.stdout.write(`${await resolveSkillProviderPath(source, id)}\n`);
  } else {
    process.stdout.write(await resolveSkillProvider(source, id, asset));
  }
}
