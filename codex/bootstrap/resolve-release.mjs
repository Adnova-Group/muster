#!/usr/bin/env node

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodexRelease } from "../../../../../src/codex-release.js";

const pluginRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const repoRoot = resolve(pluginRoot, "../../../..");
const selected = await resolveCodexRelease(repoRoot);
const [kind = "plugin", name = ""] = process.argv.slice(2);
const paths = {
  plugin: selected.pluginRoot,
  skill: join(selected.pluginRoot, "skills", name, "SKILL.md"),
  command: join(selected.pluginRoot, "commands", `${name}.md`),
  adapter: join(selected.pluginRoot, "runtime", "codex-skill-adapter.md"),
  sprint: join(selected.pluginRoot, "runtime", "sprint-protocol.md")
};
if (!paths[kind]) throw new Error(`unknown bootstrap resolution kind: ${kind}`);
process.stdout.write(`${paths[kind]}\n`);
