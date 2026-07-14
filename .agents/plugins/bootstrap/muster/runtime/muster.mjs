#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolveCodexRelease } from "./resolve-release.mjs";

const pluginRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const selected = await resolveCodexRelease(resolve(pluginRoot, "../../../.."));
await import(pathToFileURL(resolve(selected.pluginRoot, "runtime", "muster.mjs")));
