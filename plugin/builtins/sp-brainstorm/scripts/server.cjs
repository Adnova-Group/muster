const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const MAX_CONTENT_FILE_BYTES = 10 * 1024 * 1024;

function assertPrivateDirectory(directory, label, create) {
  if (create && !fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('unsafe ' + label + ': must be a real directory');
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      throw new Error('unsafe ' + label + ': directory is not owned by this user');
    if ((stat.mode & 0o077) !== 0)
      throw new Error('unsafe ' + label + ': directory must be private (mode 0700)');
  }
  return fs.realpathSync(directory);
}

function secureReadPrivateFile(file, label) {
  assertPrivateDirectory(path.dirname(file), label + ' parent', false);
  let handle;
  try {
    handle = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('unsafe ' + label + ': must be a singly-linked regular file');
    if (process.platform !== 'win32') {
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid())
        throw new Error('unsafe ' + label + ': file is not owned by this user');
      if ((stat.mode & 0o077) !== 0) throw new Error('unsafe ' + label + ': file must be private (mode 0600)');
    }
    return fs.readFileSync(handle, 'utf8');
  } catch (error) {
    if (['ELOOP', 'EMLINK', 'EINVAL'].includes(error.code)) throw new Error('unsafe ' + label + ': symlink rejected');
    throw error;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function atomicWritePrivateFile(file, content, label) {
  assertPrivateDirectory(path.dirname(file), label + ' parent', false);
  try {
    const existing = fs.lstatSync(file);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('unsafe ' + label + ': existing path is not a regular file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + process.pid + '.' + crypto.randomBytes(12).toString('hex') + '.tmp');
  let handle;
  try {
    handle = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW, 0o600);
    fs.writeFileSync(handle, String(content));
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function appendPrivateFile(file, content, label) {
  assertPrivateDirectory(path.dirname(file), label + ' parent', false);
  let handle;
  try {
    handle = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY | NOFOLLOW, 0o600);
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('unsafe ' + label + ': must be a singly-linked regular file');
    fs.writeFileSync(handle, String(content));
  } catch (error) {
    if (['ELOOP', 'EMLINK', 'EINVAL'].includes(error.code)) throw new Error('unsafe ' + label + ': symlink rejected');
    throw error;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function unlinkStateFile(file, label) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('unsafe ' + label + ': existing path is not a regular file');
    fs.unlinkSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

// ========== WebSocket Protocol (RFC 6455) ==========

const OPCODES = { TEXT: 0x01, CLOSE: 0x08, PING: 0x09, PONG: 0x0A };
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME_PAYLOAD_BYTES = 10 * 1024 * 1024;

function computeAcceptKey(clientKey) {
  return crypto.createHash('sha1').update(clientKey + WS_MAGIC).digest('base64');
}

function encodeFrame(opcode, payload) {
  const fin = 0x80;
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = fin | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = fin | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = fin | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload]);
}

function decodeFrame(buffer) {
  if (buffer.length < 2) return null;

  const secondByte = buffer[1];
  const opcode = buffer[0] & 0x0F;
  const masked = (secondByte & 0x80) !== 0;
  let payloadLen = secondByte & 0x7F;
  let offset = 2;

  if (!masked) throw new Error('Client frames must be masked');

  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    const extendedLen = buffer.readBigUInt64BE(2);
    if (extendedLen > BigInt(MAX_FRAME_PAYLOAD_BYTES)) {
      throw new Error('WebSocket frame payload exceeds maximum allowed size');
    }
    payloadLen = Number(extendedLen);
    offset = 10;
  }

  if (payloadLen > MAX_FRAME_PAYLOAD_BYTES) {
    throw new Error('WebSocket frame payload exceeds maximum allowed size');
  }

  const maskOffset = offset;
  const dataOffset = offset + 4;
  const totalLen = dataOffset + payloadLen;
  if (buffer.length < totalLen) return null;

  const mask = buffer.slice(maskOffset, dataOffset);
  const data = Buffer.alloc(payloadLen);
  for (let i = 0; i < payloadLen; i++) {
    data[i] = buffer[dataOffset + i] ^ mask[i % 4];
  }

  return { opcode, payload: data, bytesConsumed: totalLen };
}

// ========== Configuration ==========

const PORT_FILE = process.env.BRAINSTORM_PORT_FILE || null;
const randomPort = () => 49152 + Math.floor(Math.random() * 16383);
// Prefer an explicit port, else the port this session last bound (so a restart
// reuses it and an already-open browser tab reconnects), else a random high port.
function preferredPort() {
  if (process.env.BRAINSTORM_PORT) return Number(process.env.BRAINSTORM_PORT);
  if (PORT_FILE) {
    try {
      const p = Number(secureReadPrivateFile(PORT_FILE, 'port file').trim());
      if (Number.isInteger(p) && p > 1023 && p < 65536) return p;
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return randomPort();
}
let PORT = preferredPort();
const HOST = process.env.BRAINSTORM_HOST || '127.0.0.1';
const URL_HOST = process.env.BRAINSTORM_URL_HOST || (HOST === '127.0.0.1' ? 'localhost' : HOST);
const SESSION_DIR = process.env.BRAINSTORM_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'brainstorm-'));
const CONTENT_DIR = path.join(SESSION_DIR, 'content');
const STATE_DIR = path.join(SESSION_DIR, 'state');
const SUPERPOWERS_VERSION = readSuperpowersVersion();
const SUPERPOWERS_BRAND_IMAGE_URL = 'https://primeradiant.com/brand/superpowers-visual-brainstorming-logo.png';
const TELEMETRY_DISABLE_ENV_VARS = [
  'SUPERPOWERS_DISABLE_TELEMETRY',
  'DISABLE_TELEMETRY',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'
];
const SUPERPOWERS_TELEMETRY_DISABLED = TELEMETRY_DISABLE_ENV_VARS.some(name => isTruthyEnv(process.env[name]));
let ownerPid = process.env.BRAINSTORM_OWNER_PID ? Number(process.env.BRAINSTORM_OWNER_PID) : null;

// Per-session secret key. The companion is reachable by any local browser tab
// and, when bound to a non-loopback host, by any host that can route to it.
// The key authenticates the real client uniformly across loopback, tunnel, and
// remote binds — and defeats DNS rebinding — where a Host/Origin allowlist
// cannot. It rides only the trusted controller URL as ?key=. The controller
// keeps it in its nonce-protected closure and authenticates the WebSocket;
// generated screens receive a separate read-only capability. Never put either
// capability in a localhost cookie because cookies are not port-scoped.
// Persisted alongside the port (BRAINSTORM_TOKEN_FILE) so the same launch URL
// remains valid across a restart.
const TOKEN_FILE = process.env.BRAINSTORM_TOKEN_FILE || null;
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function initialToken() {
  if (process.env.BRAINSTORM_TOKEN) {
    if (!/^[0-9a-f]{32,}$/i.test(process.env.BRAINSTORM_TOKEN)) {
      throw new Error('BRAINSTORM_TOKEN must be at least 32 hexadecimal characters');
    }
    return { value: process.env.BRAINSTORM_TOKEN, source: 'env' };
  }
  if (TOKEN_FILE) {
    try {
      const t = secureReadPrivateFile(TOKEN_FILE, 'token file').trim();
      if (/^[0-9a-f]{32,}$/i.test(t)) {
        return { value: t, source: 'file' };
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return { value: generateToken(), source: 'generated' };
}

const tokenInfo = initialToken();
let TOKEN = tokenInfo.value;
let tokenSource = tokenInfo.source;
const VIEW_TOKEN = crypto.randomBytes(32).toString('hex');
let contentDirectoryIdentity = null;

const MIME_TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml'
};

// ========== Templates and Constants ==========

function waitingPage() {
  return renderBranding(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Brainstorm Companion</title>
<style>
body { font-family: system-ui, sans-serif; padding: 2rem; max-width: 800px; margin: 0 auto; }
h1 { color: #333; } p { color: #666; }
.brand { display: flex; align-items: center; min-width: 0; overflow: hidden; margin-bottom: 1.5rem; color: #666; font-size: 0.9rem; line-height: 1; }
.brand a { color: inherit; text-decoration: none; display: flex; align-items: center; gap: 0.5rem; min-width: 0; max-width: 100%; line-height: 1; }
.brand-copy { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1; transform: translateY(-1px); }
.brand-logo { display: block; height: 1em; width: auto; max-width: 180px; filter: invert(1); }
</style>
</head>
<body><!-- BRANDING --><h1>Brainstorm Companion</h1>
<p>Waiting for the agent to push a screen...</p></body></html>`);
}

const FORBIDDEN_PAGE = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Session key required</title>
<style>body { font-family: system-ui, sans-serif; padding: 2rem; max-width: 800px; margin: 0 auto; }
h1 { color: #333; } p { color: #666; } code { background: #f0f0f0; padding: 0.1em 0.3em; border-radius: 4px; }</style>
</head>
<body><h1>Session key required</h1>
<p>This page needs the full URL your coding agent gave you, including the
<code>?key=&hellip;</code> part. Copy the complete URL and open it again.</p></body></html>`;

const frameTemplate = fs.readFileSync(path.join(__dirname, 'frame-template.html'), 'utf-8');
const helperScript = fs.readFileSync(path.join(__dirname, 'helper.js'), 'utf-8');
const helperInjection = (nonce, channel) => '<script nonce="' + nonce + '">globalThis.__MUSTER_BRAINSTORM_CHANNEL__=' + JSON.stringify(channel) + ';\n' + helperScript + '\n</script>';

function controllerPage(nonce, channel, key) {
  const encodedKey = JSON.stringify(String(key));
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Brainstorm Companion</title>
<style>html,body{height:100%;margin:0;background:#1d1d1f}body{display:grid;grid-template-rows:auto 1fr;font-family:system-ui,sans-serif}.status{padding:.45rem .75rem;color:#d1d1d6;font-size:.75rem}iframe{width:100%;height:100%;border:0;background:#fff}</style>
</head><body><div class="status" id="status">Connecting...</div>
<iframe id="screen" title="Brainstorm choices" src="/screen?view=${VIEW_TOKEN}&channel=${channel}" sandbox="allow-scripts"></iframe>
<script nonce="${nonce}">
(() => {
  const frame = document.getElementById('screen');
  const status = document.getElementById('status');
  const key = ${encodedKey};
  let socket;
  function validEvent(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (value.type !== 'click') return false;
    for (const key of Object.keys(value)) if (!['type','text','choice','id'].includes(key)) return false;
    for (const key of ['text','choice','id']) if (value[key] !== null && typeof value[key] !== 'string') return false;
    return JSON.stringify(value).length <= 8192;
  }
  window.addEventListener('message', event => {
    if (event.source !== frame.contentWindow || event.origin !== 'null') return;
    if (!event.data || event.data.channel !== '${channel}' || !validEvent(event.data.event)) return;
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event.data.event));
  });
  function connect() {
    status.textContent = 'Connecting...';
    socket = new WebSocket('ws://' + location.host + '/?key=' + encodeURIComponent(key));
    socket.onopen = () => { status.textContent = 'Connected'; };
    socket.onmessage = message => {
      try {
        const data = JSON.parse(message.data);
        if (data.type === 'reload') frame.src = '/screen?view=${VIEW_TOKEN}&channel=${channel}&reload=' + Date.now();
      } catch (_) {}
    };
    socket.onclose = () => { status.textContent = 'Reconnecting...'; setTimeout(connect, 1000); };
    socket.onerror = () => { try { socket.close(); } catch (_) {} };
  }
  connect();
})();
</script></body></html>`;
}

// ========== Helper Functions ==========

function readSuperpowersVersion() {
  const root = path.join(__dirname, '../../..');
  const manifests = [
    path.join(root, 'package.json'),
    path.join(root, '.codex-plugin/plugin.json')
  ];

  for (const manifest of manifests) {
    try {
      const data = JSON.parse(fs.readFileSync(manifest, 'utf-8'));
      if (data.version) return String(data.version);
    } catch (e) {
      // Packaged Codex plugins omit package.json; try the next manifest.
    }
  }

  return 'unknown';
}

function isTruthyEnv(value) {
  if (!value) return false;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return false;
  return !['0', 'false', 'no', 'off'].includes(normalized);
}

function escapeHtmlText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function brandMarkup() {
  const version = escapeHtmlText(SUPERPOWERS_VERSION);
  const text = SUPERPOWERS_TELEMETRY_DISABLED
    ? 'Prime Radiant Superpowers v' + version
    : 'Superpowers v' + version;
  const logo = SUPERPOWERS_TELEMETRY_DISABLED
    ? ''
    : '<img class="brand-logo" src="' + SUPERPOWERS_BRAND_IMAGE_URL + '?v=' + encodeURIComponent(SUPERPOWERS_VERSION) + '" alt="Prime Radiant" referrerpolicy="no-referrer" decoding="async">';

  return '<div class="brand"><a href="https://github.com/obra/superpowers">' + logo + '<span class="brand-copy">' + text + '</span></a></div>';
}

function renderBranding(html) {
  return html.split('<!-- BRANDING -->').join(brandMarkup());
}

function isFullDocument(html) {
  const trimmed = html.trimStart().toLowerCase();
  return trimmed.startsWith('<!doctype') || trimmed.startsWith('<html');
}

function wrapInFrame(content) {
  return renderBranding(frameTemplate)
    .replace('<div class="status">Connecting…</div>', '')
    .replace('<!-- CONTENT -->', content);
}

function readPinnedContentFile(filePath, encoding = null) {
  const resolved = path.resolve(filePath);
  if (path.dirname(resolved) !== path.resolve(CONTENT_DIR)) return null;
  let handle;
  try {
    assertContentDirectoryStable();
    const pathStat = fs.lstatSync(resolved);
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.nlink !== 1) return null;
    handle = fs.openSync(resolved, fs.constants.O_RDONLY | NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(handle);
    assertContentDirectoryStable();
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_CONTENT_FILE_BYTES) return null;
    if (before.dev !== pathStat.dev || before.ino !== pathStat.ino) return null;
    const bytes = fs.readFileSync(handle);
    const after = fs.fstatSync(handle);
    assertContentDirectoryStable();
    if (!after.isFile() || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) return null;
    return { data: encoding ? bytes.toString(encoding) : bytes, stat: after };
  } catch (error) {
    if (['ELOOP', 'EMLINK', 'EINVAL', 'ENOENT'].includes(error.code)) return null;
    throw error;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function assertContentDirectoryStable() {
  if (!contentDirectoryIdentity) throw new Error('unsafe content directory: identity unavailable');
  const current = fs.lstatSync(CONTENT_DIR);
  if (current.isSymbolicLink() || !current.isDirectory()
      || current.dev !== contentDirectoryIdentity.dev || current.ino !== contentDirectoryIdentity.ino
      || fs.realpathSync(CONTENT_DIR) !== contentDirectoryIdentity.realpath) {
    throw new Error('unsafe content directory: identity changed');
  }
}

function getNewestScreen() {
  assertContentDirectoryStable();
  const files = fs.readdirSync(CONTENT_DIR)
    .filter(f => !f.startsWith('.') && f.endsWith('.html'))
    .map(f => {
      const fp = path.join(CONTENT_DIR, f);
      const pinned = readPinnedContentFile(fp, 'utf8');
      if (!pinned) return null;
      return { data: pinned.data, mtime: pinned.stat.mtime.getTime() };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? files[0].data : null;
}

function urlHostForHttp(host) {
  const h = String(host);
  if (h.startsWith('[') && h.endsWith(']')) return h;
  return h.includes(':') ? '[' + h + ']' : h;
}

function companionUrl() {
  return 'http://' + urlHostForHttp(URL_HOST) + ':' + PORT + '/?key=' + TOKEN;
}

function browserLauncherForPlatform(url, {
  platform = process.platform,
  osRelease = require('os').release(),
  env = process.env
} = {}) {
  const isWSL = platform === 'linux' && /microsoft/i.test(osRelease);
  if (platform === 'darwin') return { bin: 'open', args: [url] };
  if (platform === 'win32' || isWSL) {
    return { bin: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
  }
  if (env.DISPLAY || env.WAYLAND_DISPLAY) return { bin: 'xdg-open', args: [url] };
  return null;
}

// ========== Authentication ==========

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Master authorization is query-bound to this exact localhost port. Browser
// cookies are host-scoped rather than port-scoped, so they must never carry
// the bearer token: an unrelated localhost service would receive them.
function isAuthorized(req) {
  const q = req.url.indexOf('?');
  if (q >= 0) {
    const params = new URLSearchParams(req.url.slice(q + 1));
    if (params.has('key')) {
      const key = params.get('key');
      return Boolean(key && timingSafeEqualStr(key, TOKEN));
    }
  }
  return false;
}

function pathnameOf(url) {
  const q = url.indexOf('?');
  return q >= 0 ? url.slice(0, q) : url;
}

function queryKey(url) {
  const q = url.indexOf('?');
  if (q < 0) return null;
  return new URLSearchParams(url.slice(q + 1)).get('key');
}

function queryParameter(url, name) {
  const q = url.indexOf('?');
  if (q < 0) return null;
  return new URLSearchParams(url.slice(q + 1)).get(name);
}

function hasViewCapability(url) {
  const view = queryParameter(url, 'view');
  return Boolean(view && timingSafeEqualStr(view, VIEW_TOKEN));
}

function attachViewCapability(html) {
  return html.replace(/\b(src|href)=(['"])\/files\/([^'"?#\s]+)\2/gi,
    (_match, attribute, quote, file) => `${attribute}=${quote}/files/${file}?view=${VIEW_TOKEN}${quote}`);
}

function securityHeaders(headers = {}) {
  return {
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'",
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...headers
  };
}

function screenSecurityHeaders(nonce, headers = {}) {
  return securityHeaders({
    'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': `sandbox allow-scripts; default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`,
    ...headers,
  });
}

function isAllowedWebSocketOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  if (!host) return false;
  return origin === 'http://' + host;
}

// ========== HTTP Request Handler ==========

function handleRequest(req, res) {
  const pathname = pathnameOf(req.url);
  const masterAuthorized = isAuthorized(req);
  const viewAuthorized = hasViewCapability(req.url);
  if (!masterAuthorized && !((pathname === '/screen' || pathname.startsWith('/files/')) && viewAuthorized)) {
    res.writeHead(403, securityHeaders({ 'Content-Type': 'text/html; charset=utf-8' }));
    res.end(FORBIDDEN_PAGE);
    return;
  }
  touchActivity(); // only authorized requests count as activity

  const keyFromQuery = queryKey(req.url);
  if (req.method === 'GET' && pathname === '/' && keyFromQuery && timingSafeEqualStr(keyFromQuery, TOKEN)) {
    const nonce = crypto.randomBytes(18).toString('base64');
    const channel = crypto.randomBytes(16).toString('hex');
    res.writeHead(200, securityHeaders({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'self' ws:; frame-ancestors 'none'; base-uri 'none'`,
    }));
    res.end(controllerPage(nonce, channel, keyFromQuery));
  } else if (req.method === 'GET' && pathname === '/screen') {
    const channel = queryParameter(req.url, 'channel');
    if (!channel || !/^[0-9a-f]{32}$/.test(channel)) {
      res.writeHead(404, securityHeaders());
      res.end('Not found');
      return;
    }
    const screen = getNewestScreen();
    let html = screen
      ? (raw => isFullDocument(raw) ? raw : wrapInFrame(raw))(screen)
      : waitingPage();
    html = attachViewCapability(html);
    const nonce = crypto.randomBytes(18).toString('base64');
    const injection = helperInjection(nonce, channel);
    if (html.includes('</body>')) {
      html = html.replace('</body>', injection + '\n</body>');
    } else {
      html += injection;
    }
    res.writeHead(200, screenSecurityHeaders(nonce, { 'Content-Type': 'text/html; charset=utf-8' }));
    res.end(html);
  } else if (req.method === 'GET' && pathname.startsWith('/files/')) {
    const fileName = path.basename(pathname.slice(7));
    const filePath = path.join(CONTENT_DIR, fileName);
    // Reject empty/dotfile names and anything that isn't a regular file —
    // `/files/` would otherwise resolve to CONTENT_DIR and crash readFileSync (EISDIR).
    const pinned = (!fileName || fileName.startsWith('.')) ? null : readPinnedContentFile(filePath);
    if (!pinned) {
      res.writeHead(404, securityHeaders());
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, securityHeaders({ 'Content-Type': contentType }));
    res.end(pinned.data);
  } else {
    res.writeHead(404, securityHeaders());
    res.end('Not found');
  }
}

// ========== WebSocket Connection Handling ==========

const clients = new Set();

function handleUpgrade(req, socket) {
  if (!isAuthorized(req) || !isAllowedWebSocketOrigin(req)) { socket.destroy(); return; }

  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }

  const accept = computeAcceptKey(key);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );

  let buffer = Buffer.alloc(0);
  clients.add(socket);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length > 0) {
      let result;
      try {
        result = decodeFrame(buffer);
      } catch (e) {
        socket.end(encodeFrame(OPCODES.CLOSE, Buffer.alloc(0)));
        clients.delete(socket);
        return;
      }
      if (!result) break;
      buffer = buffer.slice(result.bytesConsumed);

      switch (result.opcode) {
        case OPCODES.TEXT:
          handleMessage(result.payload.toString());
          break;
        case OPCODES.CLOSE:
          socket.end(encodeFrame(OPCODES.CLOSE, Buffer.alloc(0)));
          clients.delete(socket);
          return;
        case OPCODES.PING:
          socket.write(encodeFrame(OPCODES.PONG, result.payload));
          break;
        case OPCODES.PONG:
          break;
        default: {
          const closeBuf = Buffer.alloc(2);
          closeBuf.writeUInt16BE(1003);
          socket.end(encodeFrame(OPCODES.CLOSE, closeBuf));
          clients.delete(socket);
          return;
        }
      }
    }
  });

  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
}

function handleMessage(text) {
  if (Buffer.byteLength(text, 'utf8') > 8192) return;
  let event;
  try {
    event = JSON.parse(text);
  } catch (e) {
    console.error('Failed to parse WebSocket message:', e.message);
    return;
  }
  if (!event || typeof event !== 'object' || Array.isArray(event) || event.type !== 'click') return;
  if (Object.keys(event).some(key => !['type', 'text', 'choice', 'id'].includes(key))) return;
  if (['text', 'choice', 'id'].some(key => event[key] !== null && typeof event[key] !== 'string')) return;
  touchActivity();
  console.log(JSON.stringify({ source: 'user-event', ...event }));
  if (event && event.choice) {
    const eventsFile = path.join(STATE_DIR, 'events');
    appendPrivateFile(eventsFile, JSON.stringify(event) + '\n', 'events file');
  }
}

function broadcast(msg) {
  const frame = encodeFrame(OPCODES.TEXT, Buffer.from(JSON.stringify(msg)));
  for (const socket of clients) {
    try { socket.write(frame); } catch (e) { clients.delete(socket); }
  }
}

// Best-effort: open the user's browser the first time a screen is actually ready
// to show. Skips when disabled, on a non-loopback (remote) bind, or when a
// browser is already connected. Override the launcher with BRAINSTORM_OPEN_CMD.
let browserOpened = false;
function maybeOpenBrowser() {
  if (browserOpened) return;
  browserOpened = true;
  if (!process.env.BRAINSTORM_OPEN) return; // opt-in: only after the user approves the companion
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') return;
  if (clients.size > 0) return; // the user already opened it
  const url = companionUrl(); // must carry the key or the gate 403s it
  const cp = require('child_process');
  // Operator-provided launcher: run as given (this env var is trusted operator input).
  if (process.env.BRAINSTORM_OPEN_CMD) {
    try { cp.exec(process.env.BRAINSTORM_OPEN_CMD + ' ' + JSON.stringify(url), () => {}); } catch (e) { /* best effort */ }
    return;
  }
  // Platform launchers: pass the URL as an argv element via execFile (no shell),
  // so a url-host containing shell metacharacters can't inject a command.
  const launcher = browserLauncherForPlatform(url);
  if (!launcher) return; // headless: nothing to open
  try { cp.execFile(launcher.bin, launcher.args, () => {}); } catch (e) { /* best effort */ }
}

// ========== Activity Tracking ==========

// Idle timeout: shut down after this long with no activity. Default 4 hours;
// override with BRAINSTORM_IDLE_TIMEOUT_MS (start-server.sh: --idle-timeout-minutes).
const IDLE_TIMEOUT_MS = (() => {
  const ms = Number(process.env.BRAINSTORM_IDLE_TIMEOUT_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : 4 * 60 * 60 * 1000;
})();
// How often the watchdog checks for owner-death / idleness. Configurable mainly
// so tests can run fast; production default is 60s.
const LIFECYCLE_CHECK_MS = (() => {
  const ms = Number(process.env.BRAINSTORM_LIFECYCLE_CHECK_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : 60 * 1000;
})();
let lastActivity = Date.now();

function touchActivity() {
  lastActivity = Date.now();
}

// ========== File Watching ==========

const debounceTimers = new Map();

// ========== Server Startup ==========

function startServer() {
  assertPrivateDirectory(SESSION_DIR, 'session directory', true);
  assertPrivateDirectory(CONTENT_DIR, 'content directory', true);
  assertPrivateDirectory(STATE_DIR, 'state directory', true);
  const contentStat = fs.lstatSync(CONTENT_DIR);
  contentDirectoryIdentity = {
    dev: contentStat.dev,
    ino: contentStat.ino,
    realpath: fs.realpathSync(CONTENT_DIR),
  };

  // Track known files to distinguish new screens from updates.
  // macOS fs.watch reports 'rename' for both new files and overwrites,
  // so we can't rely on eventType alone.
  const knownFiles = new Set(
    fs.readdirSync(CONTENT_DIR).filter(f => !f.startsWith('.') && f.endsWith('.html'))
  );

  const server = http.createServer(handleRequest);
  server.on('upgrade', handleUpgrade);

  const watcher = fs.watch(CONTENT_DIR, (eventType, filename) => {
    if (!filename || filename.startsWith('.') || !filename.endsWith('.html')) return;

    if (debounceTimers.has(filename)) clearTimeout(debounceTimers.get(filename));
    debounceTimers.set(filename, setTimeout(() => {
      debounceTimers.delete(filename);
      const filePath = path.join(CONTENT_DIR, filename);

      if (!fs.existsSync(filePath)) return; // file was deleted
      touchActivity();

      if (!knownFiles.has(filename)) {
        knownFiles.add(filename);
        const eventsFile = path.join(STATE_DIR, 'events');
        unlinkStateFile(eventsFile, 'events file');
        console.log(JSON.stringify({ type: 'screen-added', file: filePath }));
        maybeOpenBrowser();
      } else {
        console.log(JSON.stringify({ type: 'screen-updated', file: filePath }));
      }

      broadcast({ type: 'reload' });
    }, 100));
  });
  watcher.on('error', (err) => console.error('fs.watch error:', err.message));

  function shutdown(reason) {
    console.log(JSON.stringify({ type: 'server-stopped', reason }));
    const infoFile = path.join(STATE_DIR, 'server-info');
    unlinkStateFile(infoFile, 'server info file');
    atomicWritePrivateFile(
      path.join(STATE_DIR, 'server-stopped'),
      JSON.stringify({ reason, timestamp: Date.now() }) + '\n',
      'server stopped file'
    );
    watcher.close();
    clearInterval(lifecycleCheck);
    // Close any upgraded WebSocket sockets so server.close() can complete and
    // the process actually exits instead of lingering on an open connection.
    for (const socket of clients) {
      try { socket.destroy(); } catch (e) { /* already gone */ }
    }
    server.close(() => process.exit(0));
  }

  function ownerAlive() {
    if (!ownerPid) return true;
    try { process.kill(ownerPid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  }

  // Periodically exit if the owner process died or we've been idle too long.
  const lifecycleCheck = setInterval(() => {
    if (!ownerAlive()) shutdown('owner process exited');
    else if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) shutdown('idle timeout');
  }, LIFECYCLE_CHECK_MS);
  lifecycleCheck.unref();

  // Validate owner PID at startup. If it's already dead, the PID resolution
  // was wrong (common on WSL, Tailscale SSH, and cross-user scenarios).
  // Disable monitoring and rely on the idle timeout instead.
  if (ownerPid) {
    try { process.kill(ownerPid, 0); }
    catch (e) {
      if (e.code !== 'EPERM') {
        console.log(JSON.stringify({ type: 'owner-pid-invalid', pid: ownerPid, reason: 'dead at startup' }));
        ownerPid = null;
      }
    }
  }

  // If the preferred port is already taken (e.g. a previous server is still
  // alive), fall back to a random port once instead of failing.
  let triedFallback = false;

  function onListen() {
    // Record the bound port AND token so the next restart of this session reuses
    // them — but ONLY when we got our preferred port. On a fallback we bound a
    // *different* port because someone else holds the preferred one; persisting
    // would overwrite the shared files and strand that other session's open tab.
    if (PORT_FILE && !triedFallback) {
      try { atomicWritePrivateFile(PORT_FILE, String(PORT), 'port file'); } catch (e) { console.error(e.message); }
      if (TOKEN_FILE) {
        try { atomicWritePrivateFile(TOKEN_FILE, TOKEN, 'token file'); } catch (e) { console.error(e.message); }
      }
    }
    const info = JSON.stringify({
      type: 'server-started', port: Number(PORT), host: HOST,
      url_host: URL_HOST, url: companionUrl(),
      screen_dir: CONTENT_DIR, state_dir: STATE_DIR, idle_timeout_ms: IDLE_TIMEOUT_MS
    });
    console.log(info);
    // server-info embeds the key — keep it owner-only.
    atomicWritePrivateFile(path.join(STATE_DIR, 'server-info'), info + '\n', 'server info file');
  }

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && !triedFallback) {
      if (tokenSource === 'env') {
        console.error('Server failed to bind: preferred port is in use and BRAINSTORM_TOKEN is set; refusing fallback with explicit token');
        process.exit(1);
      }
      triedFallback = true;
      PORT = randomPort();
      if (tokenSource === 'file') {
        TOKEN = generateToken();
        tokenSource = 'generated-fallback';
      }
      server.listen(PORT, HOST, onListen);
    } else {
      console.error('Server failed to bind:', err.message);
      process.exit(1);
    }
  });
  server.listen(PORT, HOST, onListen);
}

if (require.main === module) {
  startServer();
}

module.exports = {
  computeAcceptKey,
  encodeFrame,
  decodeFrame,
  browserLauncherForPlatform,
  OPCODES,
  MAX_FRAME_PAYLOAD_BYTES
};
