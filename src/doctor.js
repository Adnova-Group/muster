import { loadCatalog } from "./catalog.js";
import { loadPipelines } from "./pipeline.js";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { exists } from "./fs-util.js";

export async function runDoctor({ root } = {}) {
  const base = root instanceof URL ? fileURLToPath(root) : (root || process.cwd());
  const checks = [];
  try { const c = await loadCatalog(join(base, "catalog")); checks.push({ name: "catalog", ok: true, detail: `${c.length} entries` }); }
  catch (e) { checks.push({ name: "catalog", ok: false, detail: e.message }); }
  try { const p = await loadPipelines(join(base, "pipelines")); checks.push({ name: "pipelines", ok: true, detail: `${p.length} pipelines` }); }
  catch (e) { checks.push({ name: "pipelines", ok: false, detail: e.message }); }
  const bdir = join(base, "plugin/builtins");
  const bn = (await exists(bdir)) ? (await readdir(bdir)).length : 0;
  checks.push({ name: "builtins", ok: bn > 0, detail: `${bn} built-ins` });
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "node>=20", ok: major >= 20, detail: process.versions.node });
  return { ok: checks.every(c => c.ok), checks };
}
