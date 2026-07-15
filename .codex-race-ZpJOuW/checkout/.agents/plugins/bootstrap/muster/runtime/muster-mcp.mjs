#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { materializeSelectedRuntime, resolveCodexRelease } from "./resolve-release.mjs";

const pluginRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const selected = await resolveCodexRelease(resolve(pluginRoot, "../../../.."));
const snapshot = await materializeSelectedRuntime(selected, "muster-mcp.mjs");
const cleanup = () => { try { rmSync(snapshot.dir, { recursive: true, force: true }); } catch { /* process exit */ } };
process.once("exit", cleanup);
try { await import(pathToFileURL(snapshot.path)); }
finally { process.removeListener("exit", cleanup); await rm(snapshot.dir, { recursive: true, force: true }); }
