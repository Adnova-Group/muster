// test/doctor-desktop.test.js -- `muster doctor --desktop`: a read-only report on
// Claude Desktop's view of muster (config dirs incl. the MSIX copy, the muster MCP
// entry's checkout, the account plugin list, WSL Code-tab sessions, the log dir).
// Fixtures stand in for /mnt/c/Users and /mnt; git is an injected stub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runDesktopDoctor, windowsToWslPath, isWsl } from "../src/doctor.js";
import { trackedMkdtempSync as mkdtempSync } from "../test-support/helpers.js";

const repoRoot = new URL("../", import.meta.url);
const cliVersion = JSON.parse(readFileSync(new URL("package.json", repoRoot), "utf8")).version;

function write(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

// A WSL-shaped world: <mnt>/c/Users/<user>/AppData/... and a checkout under the same mount.
function world({ checkoutVersion = cliVersion, plugins, wsl = false, msix = true } = {}) {
  const mnt = mkdtempSync(path.join(tmpdir(), "muster-desktop-"));
  const users = path.join(mnt, "c/Users");
  const profile = path.join(users, "me");
  const appdata = path.join(profile, "AppData/Roaming/Claude");
  if (msix) mkdirSync(path.join(profile, "AppData/Local/Packages/Claude_abc123"), { recursive: true });
  mkdirSync(path.join(users, "Public"), { recursive: true });
  write(path.join(appdata, "claude_desktop_config.json"), {
    mcpServers: {
      muster: { command: "node", args: ["C:\\Users\\me\\dev\\muster\\cowork\\mcp-server.mjs"] },
      other: { command: "npx", args: ["-y", "something-else"] },
    },
  });
  write(path.join(profile, "dev/muster/cowork/mcp-server.mjs"), "// stub");
  write(path.join(profile, "dev/muster/package.json"), { name: "@adnova-group/muster", version: checkoutVersion });
  if (plugins) write(path.join(appdata, "plugin-list/org/acct/plugins.json"), { plugins });
  if (wsl) {
    write(path.join(appdata, "ccd-session-presets.json"), { byAccount: { a: { presets: [{ name: "w", target: { kind: "local", cwd: "/home/me/x", wslDistro: "Ubuntu" } }] } } });
    write(path.join(appdata, "claude-code-sessions/org/acct/local_1.json"), { wslConfig: { distro: "Ubuntu" }, isArchived: false });
    write(path.join(appdata, "claude-code-sessions/org/acct/local_2.json"), { wslConfig: { distro: "Ubuntu" }, isArchived: true });
  }
  write(path.join(profile, "AppData/Local/Claude/Logs/mcp-server-muster.log"), "");
  return { mnt, users };
}

const gitStub = ({ head = "a".repeat(40), dirty = "", behind = "0" } = {}) => async (cmd, args) => {
  assert.equal(cmd, "git");
  const sub = args.slice(2).join(" ");
  if (sub === "rev-parse HEAD") return { stdout: `${head}\n` };
  if (sub === "log -1 --format=%s") return { stdout: "Release x\n" };
  if (sub === "status --porcelain") return { stdout: dirty };
  if (sub.startsWith("rev-list --count")) return { stdout: `${behind}\n` };
  throw new Error(`unexpected git ${sub}`);
};

const run = (w, exec, extra = {}) => runDesktopDoctor({
  root: repoRoot, platform: "linux", wsl: true, usersRoot: w.users, mountRoot: w.mnt, exec, ...extra,
});
const byName = (r, name) => r.checks.filter((c) => c.name === name);

test("windowsToWslPath and isWsl", () => {
  assert.equal(windowsToWslPath("C:\\Users\\me\\x.mjs"), "/mnt/c/Users/me/x.mjs");
  assert.equal(windowsToWslPath("/already/posix"), null);
  assert.equal(isWsl({ WSL_DISTRO_NAME: "Ubuntu" }, "linux"), true);
  assert.equal(isWsl({}, "linux", "Linux version 6.6 microsoft-standard-WSL2"), true);
  assert.equal(isWsl({ WSL_DISTRO_NAME: "Ubuntu" }, "darwin"), false);
});

test("reports the muster MCP checkout, the MSIX note, the plugin list and the log dir", async () => {
  const w = world({ plugins: [{ id: "muster@muster", name: "muster", enabled: true }] });
  try {
    const r = await run(w, gitStub());
    assert.equal(r.ok, true);
    const [checkout] = byName(r, "desktop-mcp-checkout");
    assert.match(checkout.detail, new RegExp(`v${cliVersion.replace(/\./g, "\\.")} at aaaaaaa "Release x"`));
    assert.equal(byName(r, "desktop-mcp-checkout-dirty").length, 0);
    assert.match(byName(r, "desktop-account-plugin")[0].detail, /muster@muster is enabled/);
    assert.match(byName(r, "desktop-config")[0].detail, /MSIX package present without a LocalCache copy/);
    assert.match(byName(r, "desktop-logs")[0].detail, /mcp-server-muster\.log present/);
    assert.deepEqual(r.desktop.configs[0].mcpServers, ["muster", "other"]);
    assert.equal(r.desktop.configs[0].musterServers.length, 1, "only the muster entry is inspected");
  } finally { rmSync(w.mnt, { recursive: true, force: true }); }
});

test("flags a stale checkout (fails), and warns on dirty, behind, plugin absent and WSL sessions", async () => {
  const w = world({ checkoutVersion: "0.0.1", plugins: [{ id: "design@kw", name: "design", enabled: true }], wsl: true });
  try {
    const r = await run(w, gitStub({ dirty: " M a\n?? b\n", behind: "12" }));
    assert.equal(r.ok, false, "a checkout older than this CLI fails the doctor");
    assert.match(byName(r, "desktop-mcp-checkout")[0].detail, /stale: older than this CLI/);
    assert.match(byName(r, "desktop-mcp-checkout-dirty")[0].detail, /2 uncommitted change/);
    assert.match(byName(r, "desktop-mcp-checkout-behind")[0].detail, /12 commit\(s\) behind/);
    assert.match(byName(r, "desktop-account-plugin")[0].detail, /not in the account plugin list/);
    const [wslCheck] = byName(r, "desktop-wsl-sessions");
    assert.equal(wslCheck.warn, true);
    assert.match(wslCheck.detail, /1 open Code-tab session\(s\) and 1 saved environment\(s\) run in WSL \(Ubuntu\)/);
    assert.match(wslCheck.detail, /load no plugins/);
  } finally { rmSync(w.mnt, { recursive: true, force: true }); }
});

test("a missing checkout fails; no Desktop at all is informational", async () => {
  const w = world();
  rmSync(path.join(w.users, "me/dev/muster"), { recursive: true, force: true });
  try {
    const r = await run(w, gitStub());
    assert.equal(r.ok, false);
    assert.match(byName(r, "desktop-mcp-checkout")[0].detail, /does not exist/);
    assert.match(byName(r, "desktop-account-plugin")[0].detail, /not readable here/);
  } finally { rmSync(w.mnt, { recursive: true, force: true }); }
  const empty = mkdtempSync(path.join(tmpdir(), "muster-desktop-none-"));
  try {
    const r = await runDesktopDoctor({ root: repoRoot, platform: "linux", wsl: true, usersRoot: empty, exec: gitStub() });
    assert.equal(r.ok, true);
    assert.match(byName(r, "desktop-config")[0].detail, /no Claude Desktop config dir found/);
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

test("never writes to the Desktop config dir", async () => {
  const w = world({ plugins: [] , wsl: true });
  const cfg = path.join(w.users, "me/AppData/Roaming/Claude/claude_desktop_config.json");
  const before = readFileSync(cfg, "utf8");
  try {
    await run(w, gitStub());
    assert.equal(readFileSync(cfg, "utf8"), before);
  } finally { rmSync(w.mnt, { recursive: true, force: true }); }
});

test("cli: doctor --desktop prints the desktop report", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)(process.execPath, [new URL("src/cli.js", repoRoot).pathname, "doctor", "--desktop"], { cwd: tmpdir() })
    .catch((e) => e); // exit 2 is a valid report on a machine with a stale checkout
  const r = JSON.parse(stdout);
  assert.ok(Array.isArray(r.checks) && r.desktop, "report shape");
  assert.ok(r.checks.some((c) => c.name === "desktop-logs"));
});
