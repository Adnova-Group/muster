import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const CONNECTION_ID = /^asdk_app_[A-Za-z0-9][A-Za-z0-9_-]*$/;
const PROFILES = new Set(["pro-safe", "full"]);

export function normalizeChatgptWorkConnectionId(value) {
  if (typeof value !== "string") throw new Error("ChatGPT Work connection id is required");
  const normalized = value.startsWith("plugin_") ? value.slice("plugin_".length) : value;
  if (!CONNECTION_ID.test(normalized)) {
    throw new Error("ChatGPT Work connection id must match asdk_app_<id> (an initial plugin_ prefix is accepted)");
  }
  return normalized;
}

async function projectGitDir(cwd) {
  const marker = join(resolve(cwd), ".git");
  let info;
  try { info = await stat(marker); } catch (cause) {
    if (cause.code !== "ENOENT") throw cause;
    const error = new Error("project scope requires a Git worktree", { cause });
    error.code = "MUSTER_NO_GIT_WORKTREE";
    throw error;
  }
  if (info.isDirectory()) return marker;
  if (!info.isFile()) throw new Error("project scope requires an ordinary .git directory or gitdir file");
  const text = await readFile(marker, "utf8");
  const match = text.trim().match(/^gitdir:\s*(.+)$/);
  if (!match) throw new Error("project scope .git file has an invalid gitdir pointer");
  return isAbsolute(match[1]) ? resolve(match[1]) : resolve(dirname(marker), match[1]);
}

export async function chatgptWorkConfigPath({
  scope = "project", cwd = process.cwd(), home = homedir(),
} = {}) {
  if (scope === "project") return join(await projectGitDir(cwd), "muster", "chatgpt-work.json");
  if (scope === "user") return join(process.env.CODEX_HOME || join(home, ".codex"), "muster", "chatgpt-work.json");
  throw new Error("ChatGPT Work install scope must be project or user");
}

function validateConfig(config) {
  if (config?.format !== 1 || config?.owner !== "muster" || !PROFILES.has(config.profile)
    || typeof config.allowFullActions !== "boolean") {
    throw new Error("ChatGPT Work installer receipt is invalid");
  }
  const connectionId = normalizeChatgptWorkConnectionId(config.connectionId);
  if (connectionId !== config.connectionId) throw new Error("ChatGPT Work installer receipt connection id is not canonical");
  if (config.profile === "full" && !config.allowFullActions) {
    throw new Error("ChatGPT Work full profile receipt is missing allow-full-actions");
  }
  return { format: 1, owner: "muster", connectionId, profile: config.profile, allowFullActions: config.allowFullActions };
}

export async function readChatgptWorkConfig(options = {}) {
  const path = await chatgptWorkConfigPath(options);
  try { return validateConfig(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error(`ChatGPT Work installer receipt is not valid JSON: ${path}`);
    throw error;
  }
}

// Ordinary Codex installation has no ChatGPT Work prerequisite. Absence of a
// project Git worktree therefore means "no optional project receipt"; every
// other error, including malformed Git metadata or a corrupt receipt, remains
// fatal and visible.
export async function readOptionalChatgptWorkConfig(options = {}) {
  try { return await readChatgptWorkConfig(options); }
  catch (error) {
    if (error.code === "MUSTER_NO_GIT_WORKTREE") return null;
    throw error;
  }
}

export async function runChatgptWorkInstall({
  connectionId, profile, scope = "project", allowFullActions = false,
  dryRun = false, cwd = process.cwd(), home = homedir(),
} = {}) {
  const canonicalId = normalizeChatgptWorkConnectionId(connectionId);
  if (!PROFILES.has(profile)) throw new Error("ChatGPT Work profile must be pro-safe or full");
  if (profile === "full" && !allowFullActions) {
    throw new Error("ChatGPT Work full profile requires --allow-full-actions");
  }
  if (profile !== "full" && allowFullActions) {
    throw new Error("--allow-full-actions is valid only with --profile full");
  }
  const configPath = await chatgptWorkConfigPath({ scope, cwd, home });
  const config = {
    format: 1, owner: "muster", connectionId: canonicalId,
    profile, allowFullActions: profile === "full",
  };
  if (!dryRun) {
    await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
    const temporary = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, configPath);
    await chmod(configPath, 0o600);
  }
  return {
    ok: true, scope, dryRun, configPath, connectionId: canonicalId,
    profile, allowFullActions: config.allowFullActions,
  };
}
