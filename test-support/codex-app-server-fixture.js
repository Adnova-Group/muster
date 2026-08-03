import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

function platformTriple() {
  if (process.platform === "win32") return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  if (process.platform === "darwin") return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  return process.arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl";
}

export async function configureManagedCodexAppServer(project, { plugins = [], skills = [] } = {}) {
  const home = join(project, "home");
  const bin = join(project, "bin");
  const packageRoot = join(project, "trusted-codex");
  const pluginRoot = join(project, "plugin-fixtures");
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await mkdir(pluginRoot, { recursive: true });
  await mkdir(bin, { recursive: true });

  const normalizedPlugins = plugins.map(plugin => ({
    name: plugin.name,
    installed: plugin.installed === true,
    enabled: plugin.enabled === true,
    availability: "AVAILABLE",
    source: { type: "local", path: join(pluginRoot, plugin.name) },
    version: plugin.version || "0.0.0-test",
  }));
  for (const plugin of normalizedPlugins) await mkdir(plugin.source.path, { recursive: true });
  const normalizedSkills = skills.map(skill => typeof skill === "string"
    ? { name: skill, description: "", enabled: true }
    : { name: skill.name, description: skill.description || "", enabled: skill.enabled !== false });
  const fixture = `
const readline = require("node:readline");
const plugins = ${JSON.stringify(normalizedPlugins)};
const skills = ${JSON.stringify(normalizedSkills)};
if (process.argv[2] !== "app-server") {
  console.log(process.argv[2] === "--version" ? "codex-cli 0.0.0-test" : "[]");
  process.exit(0);
}
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result;
  if (message.method === "initialize") result = {};
  else if (message.method === "skills/list") result = {
    data: (message.params.cwds || []).map(cwd => ({ cwd, skills, errors: [] }))
  };
  else if (message.method === "plugin/list") result = {
    marketplaces: [{ name: "fixture", plugins }], marketplaceLoadErrors: []
  };
  else result = {};
  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
});
`;
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.0.0-test" }));
  await writeFile(join(packageRoot, "bin", "codex.js"), fixture);
  const native = join(packageRoot, "vendor", platformTriple(), "bin", process.platform === "win32" ? "codex.exe" : "codex");
  await mkdir(dirname(native), { recursive: true });
  await writeFile(native, "native fixture\n");
  const shadow = join(bin, process.platform === "win32" ? "codex.cmd" : "codex");
  await writeFile(shadow, process.platform === "win32" ? "@echo off\r\nexit /b 99\r\n" : "#!/bin/sh\nexit 99\n");
  await chmod(shadow, 0o755);
  return { home, bin, packageRoot };
}
