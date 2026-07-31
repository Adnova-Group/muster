import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const server = new URL("../codex/skill-assets/sp-brainstorm/scripts/server.cjs", import.meta.url).pathname;
const sourceServer = new URL("../plugin/builtins/sp-brainstorm/scripts/server.cjs", import.meta.url).pathname;
const helper = new URL("../codex/skill-assets/sp-brainstorm/scripts/helper.js", import.meta.url).pathname;
const sourceHelper = new URL("../plugin/builtins/sp-brainstorm/scripts/helper.js", import.meta.url).pathname;
const assetManifest = new URL("../codex/skill-assets/manifest.json", import.meta.url).pathname;

async function launchServer(session, extraEnv = {}) {
  const child = spawn(process.execPath, [server], {
    env: {
      ...process.env,
      BRAINSTORM_DIR: session,
      BRAINSTORM_PORT: String(49152 + Math.floor(Math.random() * 15000)),
      BRAINSTORM_IDLE_TIMEOUT_MS: "10000",
      BRAINSTORM_LIFECYCLE_CHECK_MS: "20",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const info = await new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`server startup timed out: ${stdout}`)), 2000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (const line of stdout.split("\n")) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === "server-started") {
            clearTimeout(timer);
            resolve(parsed);
            return;
          }
        } catch { /* incomplete/non-JSON diagnostic */ }
      }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited during startup: ${code}`)); });
  });
  return { child, info };
}

test("packaged brainstorm server and manifest identify the byte-identical local overlay", async () => {
  assert.deepEqual(await readFile(server), await readFile(sourceServer));
  assert.deepEqual(await readFile(helper), await readFile(sourceHelper));
  const manifest = JSON.parse(await readFile(assetManifest, "utf8"));
  const brainstorm = manifest.skills.find((skill) => skill.id === "sp-brainstorm");
  assert.deepEqual(brainstorm.overlay, {
    source: "plugin/builtins/sp-brainstorm",
    files: ["scripts/helper.js", "scripts/server.cjs"],
  });
  assert.match(brainstorm.adaptation, /intentional local supporting-asset overlay/);
});

test("brainstorm browser boundary keeps the token out of scripts and sandboxes generated screens", async () => {
  const [serverSource, helperSource] = await Promise.all([
    readFile(server, "utf8"),
    readFile(helper, "utf8"),
  ]);
  assert.doesNotMatch(serverSource, /sessionStorage|localStorage/);
  assert.doesNotMatch(serverSource, /Set-Cookie|COOKIE_NAME|parseCookies/);
  assert.doesNotMatch(helperSource, /sessionStorage|localStorage|WebSocket|\?key=/);
  assert.match(serverSource, /const VIEW_TOKEN = crypto\.randomBytes\(32\)/);
  assert.match(serverSource, /new WebSocket\('ws:\/\/' \+ location\.host \+ '\/\?key='/);
  assert.match(serverSource, /src="\/screen\?view=\$\{VIEW_TOKEN\}/);
  assert.match(serverSource, /sandbox="allow-scripts"/);
  assert.match(serverSource, /event\.source !== frame\.contentWindow \|\| event\.origin !== 'null'/);
  assert.match(serverSource, /const channel = crypto\.randomBytes\(16\)\.toString\('hex'\)/);
  assert.match(helperSource, /__MUSTER_BRAINSTORM_CHANNEL__/);
  assert.match(serverSource, /script-src 'nonce-\$\{nonce\}'/);
  assert.match(serverSource, /sandbox allow-scripts; default-src 'none'/);
  assert.match(serverSource, /Buffer\.byteLength\(text, 'utf8'\) > 8192/);
});

test("brainstorm content reads stay on one no-follow descriptor through validation and read", async () => {
  const source = await readFile(server, "utf8");
  const start = source.indexOf("function readPinnedContentFile");
  const end = source.indexOf("function getNewestScreen", start);
  const contract = source.slice(start, end);
  assert.match(contract, /const pathStat = fs\.lstatSync\(resolved\)/);
  assert.match(contract, /openSync\(resolved, fs\.constants\.O_RDONLY \| NOFOLLOW/);
  assert.match(contract, /const before = fs\.fstatSync\(handle\)/);
  assert.match(contract, /before\.dev !== pathStat\.dev \|\| before\.ino !== pathStat\.ino/);
  assert.match(contract, /const bytes = fs\.readFileSync\(handle\)/);
  assert.match(contract, /const after = fs\.fstatSync\(handle\)/);
  assert.match(contract, /assertContentDirectoryStable\(\)/);
  assert.doesNotMatch(contract, /readFileSync\(resolved|readFileSync\(filePath/);
});

test("brainstorm pins and revalidates the content directory identity", async () => {
  const source = await readFile(server, "utf8");
  assert.match(source, /contentDirectoryIdentity = \{\s*dev: contentStat\.dev,\s*ino: contentStat\.ino,\s*realpath: fs\.realpathSync\(CONTENT_DIR\)/);
  assert.match(source, /current\.isSymbolicLink\(\) \|\| !current\.isDirectory\(\)/);
  assert.match(source, /current\.dev !== contentDirectoryIdentity\.dev \|\| current\.ino !== contentDirectoryIdentity\.ino/);
  assert.match(source, /function getNewestScreen\(\) \{\s*assertContentDirectoryStable\(\)/);
});

test("controller bootstrap sets no localhost cookie and uses a separate view capability", async (t) => {
  const session = await mkdtemp(join(tmpdir(), "muster-brainstorm-http-"));
  await chmod(session, 0o700);
  const { child, info } = await launchServer(session);
  t.after(async () => { child.kill(); await rm(session, { recursive: true, force: true }); });
  const response = await fetch(info.url);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
  const master = new URL(info.url).searchParams.get("key");
  const view = body.match(/\/screen\?view=([0-9a-f]{64})&channel=/)?.[1];
  assert.ok(view);
  assert.notEqual(view, master);
});

test("replacing the content directory cannot serve an outside screen", async (t) => {
  const session = await mkdtemp(join(tmpdir(), "muster-brainstorm-dir-swap-"));
  const outside = await mkdtemp(join(tmpdir(), "muster-brainstorm-outside-"));
  await chmod(session, 0o700);
  await chmod(outside, 0o700);
  await writeFile(join(outside, "secret.html"), "OUTSIDE_SECRET", { mode: 0o600 });
  const { child, info } = await launchServer(session);
  t.after(async () => {
    child.kill();
    await Promise.all([rm(session, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
  });
  const controller = await (await fetch(info.url)).text();
  const view = controller.match(/\/screen\?view=([0-9a-f]{64})&channel=/)?.[1];
  assert.ok(view);
  await rm(join(session, "content"), { recursive: true });
  await symlink(outside, join(session, "content"), "dir");
  let servedOutside = false;
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/screen?view=${view}&channel=${"a".repeat(32)}`);
    servedOutside = response.status === 200 && (await response.text()).includes("OUTSIDE_SECRET");
  } catch { /* fail-closed connection termination is acceptable */ }
  assert.equal(servedOutside, false);
});

async function rejectedStartup(env) {
  await assert.rejects(
    exec(process.execPath, [server], {
      env: { ...process.env, BRAINSTORM_PORT: "0", BRAINSTORM_LIFECYCLE_CHECK_MS: "20", ...env },
      timeout: 750
    }),
    /unsafe|private|symlink|regular/i
  );
}

test("brainstorm server rejects a symlinked state directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "muster-brainstorm-state-"));
  const outside = await mkdtemp(join(tmpdir(), "muster-brainstorm-victim-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await chmod(root, 0o700);
  await mkdir(join(root, "content"), { mode: 0o700 });
  await symlink(outside, join(root, "state"), "dir");
  await rejectedStartup({ BRAINSTORM_DIR: root });
});

test("brainstorm server rejects token files in a non-private directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "muster-brainstorm-token-"));
  const shared = join(root, "shared");
  const session = join(root, "session");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(shared, { mode: 0o755 });
  await mkdir(session, { mode: 0o700 });
  await writeFile(join(shared, "token"), "a".repeat(64), { mode: 0o600 });
  await rejectedStartup({ BRAINSTORM_DIR: session, BRAINSTORM_TOKEN_FILE: join(shared, "token") });
});

test("brainstorm server rejects a symlinked token file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "muster-brainstorm-token-link-"));
  const session = join(root, "session");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(session, { mode: 0o700 });
  await writeFile(join(root, "real-token"), "b".repeat(64), { mode: 0o600 });
  await symlink(join(root, "real-token"), join(session, "token"));
  await rejectedStartup({ BRAINSTORM_DIR: session, BRAINSTORM_TOKEN_FILE: join(session, "token") });
});

test("brainstorm server starts with private storage and persists private token/state files", async (t) => {
  const session = await mkdtemp(join(tmpdir(), "muster-brainstorm-private-"));
  t.after(() => rm(session, { recursive: true, force: true }));
  await chmod(session, 0o700);
  const { stdout } = await exec(process.execPath, [server], {
    env: {
      ...process.env,
      BRAINSTORM_DIR: session,
      BRAINSTORM_PORT_FILE: join(session, "port"),
      BRAINSTORM_TOKEN_FILE: join(session, "token"),
      BRAINSTORM_IDLE_TIMEOUT_MS: "40",
      BRAINSTORM_LIFECYCLE_CHECK_MS: "10"
    },
    timeout: 2000
  });
  assert.match(stdout, /"type":"server-started"/);
  assert.match(await readFile(join(session, "token"), "utf8"), /^[0-9a-f]{64}$/);
  assert.match(await readFile(join(session, "state", "server-stopped"), "utf8"), /idle timeout/);
});
