import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { connect, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
const server = new URL("../codex/skill-assets/sp-brainstorm/scripts/server.cjs", import.meta.url).pathname;
const sourceServer = new URL("../plugin/builtins/sp-brainstorm/scripts/server.cjs", import.meta.url).pathname;
const helper = new URL("../codex/skill-assets/sp-brainstorm/scripts/helper.js", import.meta.url).pathname;
const sourceHelper = new URL("../plugin/builtins/sp-brainstorm/scripts/helper.js", import.meta.url).pathname;
const launcher = new URL("../codex/skill-assets/sp-brainstorm/scripts/start-server.sh", import.meta.url).pathname;
const sourceLauncher = new URL("../plugin/builtins/sp-brainstorm/scripts/start-server.sh", import.meta.url).pathname;
const stopLauncher = new URL("../codex/skill-assets/sp-brainstorm/scripts/stop-server.sh", import.meta.url).pathname;
const sourceStopLauncher = new URL("../plugin/builtins/sp-brainstorm/scripts/stop-server.sh", import.meta.url).pathname;
const companionGuide = new URL("../codex/skill-assets/sp-brainstorm/visual-companion.md", import.meta.url).pathname;
const sourceCompanionGuide = new URL("../plugin/builtins/sp-brainstorm/visual-companion.md", import.meta.url).pathname;
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

function sealTunnelRecord(key, plaintext) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

function openTunnelRecord(key, record) {
  const decipher = createDecipheriv("aes-256-gcm", key, record.subarray(0, 12));
  decipher.setAuthTag(record.subarray(12, 28));
  return Buffer.concat([decipher.update(record.subarray(28)), decipher.final()]);
}

function encodeTunnelRecord(key, plaintext) {
  const sealed = sealTunnelRecord(key, plaintext);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(sealed.length);
  return Buffer.concat([length, sealed]);
}

function decodeTunnelRecords(key, onPlaintext, onAuthenticationFailure) {
  let buffered = Buffer.alloc(0);
  return (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32BE(0);
      if (length < 29 || length > 1024 * 1024) {
        onAuthenticationFailure(new Error("invalid authenticated tunnel record length"));
        return;
      }
      if (buffered.length < 4 + length) return;
      const sealed = buffered.subarray(4, 4 + length);
      buffered = buffered.subarray(4 + length);
      try { onPlaintext(openTunnelRecord(key, sealed)); }
      catch (error) { onAuthenticationFailure(error); return; }
    }
  };
}

async function listenOnLoopback(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function closeTcpServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function createAuthenticatedTunnel(upstreamPort) {
  const key = randomBytes(32);
  const receiverObserved = [];
  let authenticatedRecords = 0;
  const receiver = createTcpServer((encryptedSocket) => {
    const upstream = connect(upstreamPort, "127.0.0.1");
    encryptedSocket.on("data", (chunk) => receiverObserved.push(Buffer.from(chunk)));
    encryptedSocket.on("data", decodeTunnelRecords(key, (plaintext) => {
      authenticatedRecords += 1;
      upstream.write(plaintext);
    }, () => {
      upstream.destroy();
      encryptedSocket.destroy();
    }));
    upstream.on("data", (plaintext) => encryptedSocket.write(encodeTunnelRecord(key, plaintext)));
    encryptedSocket.on("end", () => upstream.end());
    upstream.on("end", () => encryptedSocket.end());
    encryptedSocket.on("error", () => upstream.destroy());
    upstream.on("error", () => encryptedSocket.destroy());
  });
  const receiverPort = await listenOnLoopback(receiver);

  const sender = createTcpServer((browserSocket) => {
    const encryptedSocket = connect(receiverPort, "127.0.0.1");
    browserSocket.on("data", (plaintext) => encryptedSocket.write(encodeTunnelRecord(key, plaintext)));
    encryptedSocket.on("data", decodeTunnelRecords(key, (plaintext) => browserSocket.write(plaintext), () => {
      browserSocket.destroy();
      encryptedSocket.destroy();
    }));
    browserSocket.on("end", () => encryptedSocket.end());
    encryptedSocket.on("end", () => browserSocket.end());
    browserSocket.on("error", () => encryptedSocket.destroy());
    encryptedSocket.on("error", () => browserSocket.destroy());
  });
  const port = await listenOnLoopback(sender);

  return {
    port,
    key,
    receiverObserved,
    get authenticatedRecords() { return authenticatedRecords; },
    async close() {
      await Promise.all([closeTcpServer(sender), closeTcpServer(receiver)]);
    },
  };
}

async function waitForEvent(eventsFile) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const contents = await readFile(eventsFile, "utf8").catch(() => "");
    const lines = contents.trim().split("\n").filter(Boolean);
    if (lines.length > 0) return JSON.parse(lines.at(-1));
    await delay(20);
  }
  throw new Error("brainstorm receiver did not persist the WebSocket click");
}

async function exerciseAuthenticatedWebSocketTunnel(t) {
  const session = await mkdtemp(join(tmpdir(), "muster-brainstorm-tunnel-e2e-"));
  await chmod(session, 0o700);
  const { child, info } = await launchServer(session);
  const tunnel = await createAuthenticatedTunnel(info.port);
  t.after(async () => {
    child.kill();
    await tunnel.close();
    await rm(session, { recursive: true, force: true });
  });

  const launchUrl = new URL(info.url);
  launchUrl.hostname = "127.0.0.1";
  launchUrl.port = String(tunnel.port);
  const controller = await (await fetch(launchUrl)).text();
  const capability = controller.match(/const key = "([0-9a-f]{64})"/)?.[1];
  assert.ok(capability, "controller must exchange the bootstrap key for a WebSocket capability");

  const click = {
    type: "click",
    choice: "remote-private-choice",
    text: "remote-private-event",
    id: "remote-choice",
  };
  const socket = new WebSocket(`ws://127.0.0.1:${tunnel.port}/?key=${capability}`);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.send(JSON.stringify(click));
  const received = await waitForEvent(join(session, "state", "events"));
  socket.close();

  return {
    received,
    capability,
    click,
    receiverCapture: Buffer.concat(tunnel.receiverObserved),
    authenticatedRecords: tunnel.authenticatedRecords,
    tunnelKey: tunnel.key,
  };
}

test("packaged brainstorm server and manifest identify the byte-identical local overlay", async () => {
  assert.deepEqual(await readFile(server), await readFile(sourceServer));
  assert.deepEqual(await readFile(helper), await readFile(sourceHelper));
  assert.deepEqual(await readFile(launcher), await readFile(sourceLauncher));
  assert.deepEqual(await readFile(stopLauncher), await readFile(sourceStopLauncher));
  assert.deepEqual(await readFile(companionGuide), await readFile(sourceCompanionGuide));
  const manifest = JSON.parse(await readFile(assetManifest, "utf8"));
  const brainstorm = manifest.skills.find((skill) => skill.id === "sp-brainstorm");
  assert.deepEqual(brainstorm.overlay, {
    source: "plugin/builtins/sp-brainstorm",
    files: ["scripts/helper.js", "scripts/server.cjs", "scripts/start-server.sh", "scripts/stop-server.sh", "visual-companion.md"],
  });
  assert.match(brainstorm.adaptation, /intentional local supporting-asset overlay/);
  if (process.platform !== "win32") {
    for (const file of [launcher, sourceLauncher, stopLauncher, sourceStopLauncher]) {
      assert.notEqual((await stat(file)).mode & 0o111, 0, `${file} must remain executable in the package`);
    }
  }
});

test("brainstorm browser boundary keeps the token out of scripts and sandboxes generated screens", async () => {
  const [serverSource, helperSource] = await Promise.all([
    readFile(server, "utf8"),
    readFile(helper, "utf8"),
  ]);
  assert.doesNotMatch(serverSource, /sessionStorage|localStorage/);
  assert.doesNotMatch(serverSource, /Set-Cookie|COOKIE_NAME|parseCookies/);
  assert.doesNotMatch(helperSource, /sessionStorage|localStorage|WebSocket|\?key=/);
  assert.match(serverSource, /createControllerCapabilities\(\)/);
  assert.match(serverSource, /location\.protocol === 'https:' \? 'wss:' : 'ws:'/);
  assert.match(serverSource, /src="\/screen\?view=\$\{capabilities\.view\}/);
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
  assert.equal(info.host, "127.0.0.1");
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
  const master = new URL(info.url).searchParams.get("key");
  const view = body.match(/\/screen\?view=([0-9a-f]{64})&channel=/)?.[1];
  assert.ok(view);
  assert.notEqual(view, master);
});

test("screen CSP permits authenticated same-origin image and stylesheet assets", async (t) => {
  const session = await mkdtemp(join(tmpdir(), "muster-brainstorm-assets-"));
  await chmod(session, 0o700);
  const { child, info } = await launchServer(session);
  t.after(async () => { child.kill(); await rm(session, { recursive: true, force: true }); });
  await writeFile(join(session, "content", "screen.html"), '<img src="/files/pixel.png"><link rel="stylesheet" href="/files/theme.css">', { mode: 0o600 });
  await writeFile(join(session, "content", "pixel.png"), Buffer.from([137, 80, 78, 71]), { mode: 0o600 });
  await writeFile(join(session, "content", "theme.css"), "body{color:#123}", { mode: 0o600 });
  const controller = await (await fetch(info.url)).text();
  const view = controller.match(/\/screen\?view=([0-9a-f]{64})&channel=/)?.[1];
  const channel = controller.match(/&channel=([0-9a-f]{32})/)?.[1];
  assert.ok(view && channel);
  const screenResponse = await fetch(`http://127.0.0.1:${info.port}/screen?view=${view}&channel=${channel}`);
  const screen = await screenResponse.text();
  const csp = screenResponse.headers.get("content-security-policy");
  const assetOriginPattern = new URL(info.url).origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(csp, new RegExp(`style-src ${assetOriginPattern} 'unsafe-inline'`));
  assert.match(csp, new RegExp(`img-src ${assetOriginPattern} data:`));
  assert.doesNotMatch(csp, /(?:style-src|img-src)[^;]*'self'/);
  assert.match(screen, new RegExp(`/files/pixel\\.png\\?view=${view}`));
  assert.match(screen, new RegExp(`/files/theme\\.css\\?view=${view}`));
  const imageResponse = await fetch(`http://127.0.0.1:${info.port}/files/pixel.png?view=${view}`);
  const styleResponse = await fetch(`http://127.0.0.1:${info.port}/files/theme.css?view=${view}`);
  assert.equal(imageResponse.status, 200);
  assert.equal(styleResponse.status, 200);
  for (const response of [imageResponse, styleResponse]) {
    assert.equal(response.headers.get("cross-origin-resource-policy"), "cross-origin");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  }
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

test("bare non-loopback binds fail closed before listening", async (t) => {
  const session = await mkdtemp(join(tmpdir(), "muster-brainstorm-remote-bind-"));
  t.after(() => rm(session, { recursive: true, force: true }));
  await chmod(session, 0o700);
  await assert.rejects(
    exec(launcher, ["--host", "0.0.0.0", "--foreground"], { timeout: 1000 }),
    (error) => {
      assert.match(error.stdout, /non-loopback bind rejected/i);
      return true;
    },
  );
  await assert.rejects(
    exec(process.execPath, [server], {
      env: {
        ...process.env,
        BRAINSTORM_DIR: session,
        BRAINSTORM_HOST: "0.0.0.0",
        BRAINSTORM_URL_HOST: "localhost",
        BRAINSTORM_PORT: "0",
      },
      timeout: 1000,
    }),
    /non-loopback.*encrypted authenticated tunnel/i,
  );
  await assert.rejects(
    exec(process.execPath, [server], {
      env: {
        ...process.env,
        BRAINSTORM_DIR: session,
        BRAINSTORM_HOST: "127.0.0.1",
        BRAINSTORM_URL_HOST: "remote.example",
        BRAINSTORM_PORT: "0",
      },
      timeout: 1000,
    }),
    /non-loopback.*URL host/i,
  );
  for (const invalidHost of ["127.999.999.999", "[::1", "::2"]) {
    await assert.rejects(
      exec(process.execPath, [server], {
        env: {
          ...process.env,
          BRAINSTORM_DIR: session,
          BRAINSTORM_HOST: invalidHost,
          BRAINSTORM_URL_HOST: "localhost",
          BRAINSTORM_PORT: "0",
        },
        timeout: 1000,
      }),
      /unsafe non-loopback bind/i,
    );
  }
  assert.equal(await readFile(join(session, "state", "server-info"), "utf8").catch(() => null), null);
});

async function websocketOutcome(url) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => { socket.close(); resolve("timeout"); }, 1000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve("open"); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); resolve("rejected"); }, { once: true });
  });
}

test("expired and disconnected controller capabilities cannot be replayed", async (t) => {
  const session = await mkdtemp(join(tmpdir(), "muster-brainstorm-capability-"));
  await chmod(session, 0o700);
  const { child, info } = await launchServer(session, { BRAINSTORM_CAPABILITY_TTL_MS: "80" });
  t.after(async () => { child.kill(); await rm(session, { recursive: true, force: true }); });

  const firstController = await (await fetch(info.url)).text();
  const firstKey = firstController.match(/const key = "([0-9a-f]{64})"/)?.[1];
  const firstView = firstController.match(/\/screen\?view=([0-9a-f]{64})/)?.[1];
  assert.ok(firstKey && firstView);
  const firstSocket = new WebSocket(`ws://127.0.0.1:${info.port}/?key=${firstKey}`);
  await new Promise((resolve, reject) => {
    firstSocket.addEventListener("open", resolve, { once: true });
    firstSocket.addEventListener("error", reject, { once: true });
  });
  firstSocket.close();
  await new Promise((resolve) => firstSocket.addEventListener("close", resolve, { once: true }));
  assert.equal(await websocketOutcome(`ws://127.0.0.1:${info.port}/?key=${firstKey}`), "rejected");
  assert.equal((await fetch(`http://127.0.0.1:${info.port}/screen?view=${firstView}&channel=${"a".repeat(32)}`)).status, 403);

  const expiringController = await (await fetch(info.url)).text();
  const expiringKey = expiringController.match(/const key = "([0-9a-f]{64})"/)?.[1];
  const expiringView = expiringController.match(/\/screen\?view=([0-9a-f]{64})/)?.[1];
  assert.ok(expiringKey && expiringView);
  await delay(120);
  assert.equal(await websocketOutcome(`ws://127.0.0.1:${info.port}/?key=${expiringKey}`), "rejected");
  assert.equal((await fetch(`http://127.0.0.1:${info.port}/screen?view=${expiringView}&channel=${"b".repeat(32)}`)).status, 403);
});

test("documented authenticated tunnel carries a WebSocket click while receiver-observed bytes hide secrets", async (t) => {
  const guides = await Promise.all([companionGuide, sourceCompanionGuide].map((file) => readFile(file, "utf8")));
  for (const guide of guides) {
    assert.equal(guide.split("\n").some((line) => /^\s*--host\s+(?:0\.0\.0\.0|::|\*)/.test(line)), false);
    assert.match(guide, /ssh\s+-L\s+\[local-port\]:127\.0\.0\.1:\[server-port\]/);
    assert.match(guide, /authenticated, encrypted SSH tunnel/i);
    assert.match(guide, /packet capture[\s\S]*cannot expose[\s\S]*capabilit[\s\S]*event/i);
  }

  const receipt = await exerciseAuthenticatedWebSocketTunnel(t);
  assert.deepEqual(receipt.received, receipt.click);
  assert.ok(receipt.authenticatedRecords > 0, "receiver must authenticate encrypted records before forwarding");
  assert.ok(receipt.receiverCapture.length > 0, "capture must contain bytes observed at the tunnel receiver");
  assert.equal(receipt.receiverCapture.includes(Buffer.from(receipt.capability)), false);
  assert.equal(receipt.receiverCapture.includes(Buffer.from(JSON.stringify(receipt.click))), false);
  const authenticated = encodeTunnelRecord(receipt.tunnelKey, Buffer.from("authenticated"));
  authenticated[authenticated.length - 1] ^= 1;
  assert.throws(() => openTunnelRecord(receipt.tunnelKey, authenticated.subarray(4)));
});
