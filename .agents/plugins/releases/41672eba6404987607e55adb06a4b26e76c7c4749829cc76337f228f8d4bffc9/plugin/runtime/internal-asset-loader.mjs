#!/usr/bin/env node

// Self-contained verified reader for bundled internal workflows. The build
// replaces the digest placeholder with the hash of runtime/internal-assets.json.
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const METADATA_DIGEST = "96551f5708851a7df526d1d43f9c489609c41fc6246c0c521fc423680173e947";
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PART = /^[A-Za-z0-9_.-]+$/;
const sha256 = value => createHash("sha256").update(value).digest("hex");
const runtimeRoot = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(runtimeRoot);

async function openDirectory(path, label, handles) {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isDirectory()) throw new Error(`${label} must be an ordinary directory: ${path}`);
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0) | (fsConstants.O_NOFOLLOW || 0));
  const after = await handle.stat();
  if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) {
    await handle.close();
    throw new Error(`${label} changed during validation: ${path}`);
  }
  handles.push(handle);
}

async function readRegular(path, label, maxBytes) {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`${label} must be an ordinary regular file: ${path}`);
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const after = await handle.stat();
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || after.size > maxBytes) {
      throw new Error(`${label} changed or exceeds its size bound: ${path}`);
    }
    return await handle.readFile();
  } finally { await handle.close(); }
}

function validatedAsset(id, relativeAsset = "SKILL.md") {
  if (!ID.test(id || "")) throw new Error(`invalid skill provider id: ${JSON.stringify(id)}`);
  const parts = String(relativeAsset).split("/");
  if (!parts.length || parts.some(part => !PART.test(part) || part === "." || part === "..")) {
    throw new Error(`invalid internal asset path: ${JSON.stringify(relativeAsset)}`);
  }
  return { id, parts, relative: `${id}/${parts.join("/")}` };
}

export async function readBundledAsset(id, relativeAsset = "SKILL.md") {
  const asset = validatedAsset(id, relativeAsset);
  const handles = [];
  try {
    await openDirectory(pluginRoot, "plugin root", handles);
    await openDirectory(runtimeRoot, "plugin runtime", handles);
    const metadataPath = join(runtimeRoot, "internal-assets.json");
    const metadataBytes = await readRegular(metadataPath, "internal asset metadata", 4 * 1024 * 1024);
    if (sha256(metadataBytes) !== METADATA_DIGEST) throw new Error("internal asset metadata hash mismatch");
    const metadata = JSON.parse(metadataBytes.toString("utf8"));
    if (metadata?.format !== 1 || !Array.isArray(metadata.files)) throw new Error("internal asset metadata contract mismatch");
    const expected = metadata.files.find(file => file.path === asset.relative);
    if (!expected || !Number.isSafeInteger(expected.size) || !/^[a-f0-9]{64}$/.test(expected.sha256 || "")) {
      throw new Error(`internal asset is absent from trusted metadata: ${asset.relative}`);
    }
    const internalRoot = join(pluginRoot, "internal-skills");
    await openDirectory(internalRoot, "internal skill root", handles);
    let parent = join(internalRoot, asset.id);
    await openDirectory(parent, "internal skill directory", handles);
    for (const part of asset.parts.slice(0, -1)) {
      parent = join(parent, part);
      await openDirectory(parent, "internal asset ancestry", handles);
    }
    const bytes = await readRegular(join(parent, asset.parts.at(-1)), "internal asset", Math.min(expected.size, 32 * 1024 * 1024));
    if (bytes.length !== expected.size || sha256(bytes) !== expected.sha256) {
      throw new Error(`internal asset changed after packaging: ${asset.relative}`);
    }
    return bytes;
  } finally {
    await Promise.all(handles.map(handle => handle.close().catch(() => {})));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [id, asset] = process.argv.slice(2);
  process.stdout.write(await readBundledAsset(id, asset));
}
