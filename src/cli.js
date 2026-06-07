#!/usr/bin/env node
import { detectProject } from "./detect.js";
import { loadCatalog } from "./catalog.js";
import { readInstalled } from "./harness.js";
import { resolveCapabilities } from "./capabilities.js";
import { validateManifest } from "./manifest.js";
import { writeMemory, readMemory } from "./memory.js";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";

const CATALOG_DIR = new URL("../catalog/", import.meta.url);

function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + "\n"); }
function fail(msg) { process.stderr.write(`muster: ${msg}\n`); process.exit(1); }

const [cmd, ...rest] = process.argv.slice(2);

try {
  if (cmd === "detect") {
    out(await detectProject(rest[0] || process.cwd()));
  } else if (cmd === "capabilities") {
    const catalog = await loadCatalog(CATALOG_DIR);
    out(resolveCapabilities(catalog, await readInstalled(rest[0] || homedir())));
  } else if (cmd === "manifest" && rest[0] === "validate") {
    if (!rest[1]) fail("manifest validate <file>: missing file path");
    const obj = JSON.parse(await readFile(rest[1], "utf8"));
    const r = validateManifest(obj);
    out(r);
    if (!r.ok) process.exit(2);
  } else if (cmd === "memory" && rest[0] === "write") {
    if (!rest[1] || !rest[2]) fail("memory write <dir> <entry.json>: missing args");
    const dir = rest[1]; const entry = JSON.parse(await readFile(rest[2], "utf8"));
    await writeMemory(dir, entry); out({ ok: true });
  } else if (cmd === "memory" && rest[0] === "read") {
    if (!rest[1]) fail("memory read <dir> [query]: missing dir");
    out(await readMemory(rest[1], rest[2] || ""));
  } else {
    fail(`unknown command: ${[cmd, ...rest].join(" ")}\nUsage: muster <detect|capabilities|manifest validate <file>|memory read|write ...>`);
  }
} catch (e) {
  fail(e.message);
}
