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
const assetManifest = new URL("../codex/skill-assets/manifest.json", import.meta.url).pathname;

test("packaged brainstorm server and manifest identify the byte-identical local overlay", async () => {
  assert.deepEqual(await readFile(server), await readFile(sourceServer));
  const manifest = JSON.parse(await readFile(assetManifest, "utf8"));
  const brainstorm = manifest.skills.find((skill) => skill.id === "sp-brainstorm");
  assert.deepEqual(brainstorm.overlay, {
    source: "plugin/builtins/sp-brainstorm",
    files: ["scripts/server.cjs"],
  });
  assert.match(brainstorm.adaptation, /intentional local supporting-asset overlay/);
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
