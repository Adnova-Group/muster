import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
  assert.doesNotMatch(helperSource, /sessionStorage|localStorage|WebSocket|\?key=/);
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
  assert.doesNotMatch(contract, /readFileSync\(resolved|readFileSync\(filePath/);
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
