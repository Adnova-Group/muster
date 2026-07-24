import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants as fsConstants, cpSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync
} from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { withCodexFileLock } from "./codex-lock.js";
import { CODEX_MODEL_POLICY, codexProfileForConfig } from "./codex.js";

// Wave 2 teardown: the Codex plugin used to be published as a committed,
// content-addressed generation (release.json + releases/<sha256>/, an
// append-only selection log, per-reader leases, and an immutable "bootstrap"
// fallback tree) because the payload was committed to git and read
// concurrently by other checkouts/sessions mid-`git pull`. Nothing under
// .agents/ is committed anymore — generation now happens at build/install
// time into a gitignored staging directory or the user's CODEX_HOME, and is
// consumed by the same process that produced it. That removes the
// multi-reader-of-a-shared-git-tree hazard the old machinery defended
// against, so the generation-hash addressing, selection log, lease
// bookkeeping, and bootstrap indirection are deleted rather than ported.
//
// Deliberately synchronous fs throughout this module (see scripts/build-codex.mjs's
// top comment for why: a confirmed WSL2 drvfs rename pathology on hot-written
// trees, worked around by staging on native tmpfs and never renaming a
// generated tree across that mount). This is a build/install-time-only code
// path (never a request-serving hot path), so the brief event-loop block per
// sync call is an acceptable trade for correctness.

function ordinary(path, expected, label) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { throw new Error(`${label} is missing: ${path}`, { cause: error }); }
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${path}`);
  if (expected === "directory" ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(`${label} must be a regular ${expected}: ${path}`);
  }
  return stat;
}

function ensureOrdinaryDirectory(path, label) {
  try { ordinary(path, "directory", label); return; }
  catch (error) { if (error.cause?.code !== "ENOENT") throw error; }
  mkdirSync(path, { recursive: true });
  ordinary(path, "directory", label);
}

// `ensureOrdinaryDirectory` (and the terminal `ordinary` checks) only vet the
// LAST path component. A symlinked ANCESTOR of that component would still
// redirect any mutation built by join()ing onto the path (a copy, a rename, a
// cleanup rmSync, a pointer write) out of the intended tree and into the link's
// target. Mirror the ancestry-walk discipline codex-install.js's /
// codex-doctor.js's `ordinaryDirectoryPath` already enforce (synchronous here,
// matching this module): walk every EXISTING component from the filesystem
// root down to `path`, rejecting any that is a symlink or a non-directory, and
// naming the offender. Stop at the first not-yet-existing component -- whatever
// is below it will be created fresh (and therefore symlink-free) by the
// subsequent mkdirSync -- so this must run BEFORE that mkdir.
function ensureOrdinaryAncestry(path, label) {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`${label} ancestry must not be a symlink: ${current}`);
    if (!stat.isDirectory()) throw new Error(`${label} ancestry must be an ordinary directory: ${current}`);
  }
}

// Second, independent defense for the publish mutations. Even after the
// pre-lock ancestry walk certifies every existing ancestor is an ordinary
// directory, a same-user writer could swap an ancestor for a symlink in the
// window before -- or between -- the mutations below. So immediately before
// each mutation re-assert (a) the whole ancestry is still symlink-free, naming
// any offending link, and (b) `pluginsRoot` still resolves to the exact
// canonical realpath captured at validation time, so an ancestor swap that
// redirects the path is caught and the mutation is never executed through it.
function assertPluginsRootCanonical(pluginsRoot, expectedReal, mutation) {
  ensureOrdinaryAncestry(pluginsRoot, "Codex plugin staging root");
  let real;
  try { real = realpathSync(pluginsRoot); }
  catch (error) { throw new Error(`Codex plugin staging root vanished before the ${mutation}: ${pluginsRoot}`, { cause: error }); }
  if (real !== expectedReal) {
    throw new Error(`Codex plugin staging root realpath changed before the ${mutation} (ancestor swapped under publish): ${pluginsRoot} resolves to ${real}, expected ${expectedReal}`);
  }
}

// Kept for same-device renames where cross-device copy doesn't apply and no
// hot-written-tree burst precedes the rename: atomicWritePointer below (a
// small single file) and publishCodexPlugin's retire-the-existing-plugin-dir
// step plus its restore-on-failure counterpart (an existing, cold directory
// — not the tree that was just hot-written). The freshly staged plugin tree
// itself is no longer renamed into place at all — see publishCodexPlugin's
// docblock — so this helper is never used for that. A/B testing (sandboxed
// and unsandboxed) confirmed the drvfs pathology is real and independent of
// any external process; strace-level syscall slowdown passes, but even a
// 50-second bounded backoff on the same rename does not reliably clear it
// for a large directory, so this retry is deliberately not relied on for
// that hot-written case anymore either.
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function renameWithRetry(source, destination, { retries = 4, delayMs = 250 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { renameSync(source, destination); return; }
    catch (error) {
      if (error.code !== "ENOENT" || attempt >= retries) throw error;
      sleepSync(delayMs * 2 ** attempt);
    }
  }
}

// On win32, relative() returns `target` itself (still absolute, unchanged)
// when `base` and `target` are on different drives -- there is no relative
// path across drives -- which would otherwise slip past the ".." checks
// above undetected. Unreachable via this module's sole call path today
// (assertRegularTree below only ever passes a target built by joining
// directory segments read from within `base`, never a foreign-drive path),
// but restored anyway for defense-in-depth so a future caller of `contained`
// can't have this guard silently miss a cross-drive escape on Windows.
function contained(base, target, label) {
  const rel = relative(resolve(base), resolve(target));
  if (!rel || rel === ".") return;
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error(`${label} is not contained by ${base}: ${target}`);
  }
}

// Descriptor-pinned no-follow read (run-5 audit Med #6). O_NOFOLLOW makes the
// open itself refuse to traverse a symlinked FINAL component (a same-user
// writer swapping the file for a symlink after any prior lstat cannot redirect
// the read to the link's target), and the size/type gate is asserted with
// fstat on the RETURNED descriptor -- never a second lstat(path), which would
// re-resolve the name and reopen the very TOCTOU the descriptor exists to pin.
// O_NOFOLLOW guards only the final component; a symlinked ANCESTOR is still
// followed (Node has no openat to hold each parent by descriptor), which is why
// the tree-level ancestry walks and the staged-vs-copied digest below exist.
export function readRegularNoFollow(path, label, maxBytes = 32 * 1024 * 1024) {
  let fd;
  try { fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0)); }
  catch (error) {
    if (error.code === "ELOOP") throw new Error(`${label} must not be a symlink: ${path}`, { cause: error });
    if (error.code === "ENOENT") throw new Error(`${label} is missing: ${path}`, { cause: error });
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
    if (stat.size > maxBytes) throw new Error(`${label} must be a bounded regular file: ${path}`);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function readRegular(path, label, maxBytes = 32 * 1024 * 1024) {
  ordinary(path, "file", label);
  return readRegularNoFollow(path, label, maxBytes);
}
const readRegularJson = (path, label, maxBytes = 64 * 1024) => JSON.parse(readRegular(path, label, maxBytes).toString("utf8"));
const sha256 = value => createHash("sha256").update(value).digest("hex");

// Walks a tree, rejecting any symlink or special file, and returns every
// regular file's path/size/digest (still needed by the packaged plugin's
// point-of-use internal-asset integrity check, which is orthogonal to the
// deleted generation-hash/release-addressing system) plus its directories.
//
// This used to also fsync every visited file/directory, on the theory that
// writes weren't durable before the immediately following publish rename.
// The confirmed root cause (see renameWithRetry above) is a drvfs
// rename-after-write-burst race at the rename call site itself, not a
// durability gap here, so the extra fsync pass — real cost on every build,
// on every filesystem — was removed. The freshly written tree is instead
// never renamed at all: it is staged on native tmpfs (scripts/build-codex.mjs's
// top comment) and published by copy (publishCodexPlugin's docblock), which
// sidesteps the drvfs rename hazard entirely rather than retrying around it.
export async function assertRegularTree(root) {
  let rootStat;
  try { rootStat = lstatSync(root); }
  catch (error) { throw new Error(`tree root is missing: ${root}`, { cause: error }); }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`tree root must be a regular directory: ${root}`);
  const files = [], dirs = [];
  function walk(dir) {
    const entries = readdirSync(dir).sort();
    for (const name of entries) {
      const path = join(dir, name);
      contained(root, path, "tree entry");
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`tree entry must not be a symlink: ${path}`);
      const rel = relative(root, path).replaceAll("\\", "/");
      if (stat.isDirectory()) {
        dirs.push(rel);
        walk(path);
      } else if (stat.isFile()) {
        // Read through a no-follow descriptor, not readFileSync(path): the
        // lstat above and this read are two syscalls, and a same-user writer
        // could swap this entry for a symlink in between. O_NOFOLLOW + fstat
        // (readRegularNoFollow) reject that swap instead of reading the link's
        // target (run-5 audit Med #6).
        const content = readRegularNoFollow(path, "tree entry");
        files.push({ path: rel, sha256: sha256(content), size: content.length });
      } else throw new Error(`tree entry must be a regular file or directory: ${path}`);
    }
  }
  walk(root);
  return { dirs, files };
}

// Content identity of an assertRegularTree result: a single digest over every
// directory's relative path plus every file's relative path, size, and content
// sha256, order-independent (sorted first). Used to compare the STAGED tree
// against the tree that actually landed at the copy destination: a same-user
// attacker who swaps an ancestor to a symlink mid-copy and swaps it back leaves
// the final-state realpath equal (defeating that check) but changes the bytes
// the destination received -- so a redirected or truncated copy produces a
// different copied digest and is rejected (run-5 audit Med #6, residual ii).
function treeDigest(tree) {
  const hash = createHash("sha256");
  for (const dir of [...tree.dirs].sort()) hash.update(`d\0${dir}\0`);
  for (const file of [...tree.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`f\0${file.path}\0${file.size}\0${file.sha256}\0`);
  }
  return hash.digest("hex");
}

export async function assertRegularFile(path) {
  ordinary(path, "file", "source file");
  return path;
}

// TOML basic-string encoder (run-5 audit Med #7). A subagent's Markdown body is
// attacker-influenceable free text. Emitted raw between multiline `"""`
// delimiters it could contain its own `"""` to close the string early and have
// the remainder parsed as TOP-LEVEL TOML keys -- injecting model /
// model_reasoning_effort / sandbox_mode (or a fresh privilege key such as
// approval_policy) that override the muster-pinned policy. (Even short of a full
// string break-out, a body line like `model = "..."` would also spoof the
// line-oriented pin readers in codex-conformance.js / codex-thread-limits.js.)
//
// Encoding the value as a SINGLE-LINE TOML basic string closes every escape
// route at once and is trivial to prove correct: the string is delimited by a
// single `"`, and this encoder replaces EVERY `"` with `\"` (so no byte can
// terminate the string early) and EVERY newline with `\n` (so the whole value
// is one physical line -- no byte in it can begin a `key = ...` line). `\` is
// doubled and control chars become `\uXXXX`, both required for the output to be
// a spec-valid basic string. The guarantee: no byte sequence in `value` can
// terminate the string or introduce a key, and the emitted string round-trips
// through a spec TOML parser to the original bytes exactly.
const TOML_BASIC_STRING_ESCAPES = new Map([
  ["\b", "\\b"], ["\t", "\\t"], ["\n", "\\n"], ["\f", "\\f"], ["\r", "\\r"],
  ["\"", "\\\""], ["\\", "\\\\"]
]);
export function encodeTomlBasicString(value) {
  let out = "\"";
  for (const ch of value) {
    const shortEscape = TOML_BASIC_STRING_ESCAPES.get(ch);
    if (shortEscape !== undefined) { out += shortEscape; continue; }
    const code = ch.codePointAt(0);
    // TOML basic strings forbid unescaped control chars (U+0000-U+001F, U+007F);
    // everything the short-escape map did not cover is emitted as \uXXXX.
    if (code < 0x20 || code === 0x7f) { out += `\\u${code.toString(16).padStart(4, "0").toUpperCase()}`; continue; }
    out += ch;
  }
  return out + "\"";
}

// Pure, dependency-free profile generation: the project/user-scope `.codex/agents/`
// materialization (codex-install.js) needs only this — no esbuild bundle, no
// Codex plugin tree — so it stays available even when the heavier plugin
// build cannot run (see the CONSTRAINT this wave preserves).
export function profileToml(id, source, config) {
  const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  const description = (source.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1].match(/^description:\s*(.+)$/m)?.[1] || "").trim().replace(/^['"]|['"]$/g, "") || `${id} Muster specialist.`;
  const defaultModel = CODEX_MODEL_POLICY.tiers[config.tier];
  if (!defaultModel) throw new Error(`unknown Codex profile tier for ${id}: ${config.tier}`);
  // Harness-neutral shape: an agent carries an optional SEMANTIC effort override
  // (workhorse|judgment|peak), never a concrete model/reasoning string. This
  // accept-list stays in exact parity with scripts/check-codex.mjs (test/codex-check.test.js
  // parses both literals) so the checker never green-lights an effort the generator rejects.
  if (config.effort !== undefined && !["workhorse", "judgment", "peak"].includes(config.effort)) {
    throw new Error(`invalid Codex profile effort override for ${id}: ${config.effort}`);
  }
  // Fail loud on a half-migrated entry: a leftover concrete model/reasoning key
  // would be silently ignored by the neutral resolver, so reject it here.
  if (config.model !== undefined || config.reasoning !== undefined) {
    throw new Error(`legacy model/reasoning key on ${id}: the neutral shape uses { tier, effort? } only`);
  }
  // Single-sourced with the `capabilities --codex` lane: codexProfileForConfig
  // resolves the neutral { tier, effort? } through CODEX_MODEL_POLICY, so the
  // committed TOML pin and the capabilities codexModel can never diverge. The
  // id-rich validation above stays here (tier/effort guards) for the generator's
  // fail-closed error messages.
  const model = codexProfileForConfig(config);
  const isolation = config.readOnly
    ? "Remain read-only. Do not edit files or run commands that mutate the workspace."
    : "Before writing, verify the task is running in an isolated git worktree; do not write directly on a base branch.";
  return [
    `name = ${JSON.stringify(id)}`,
    `description = ${JSON.stringify(description)}`,
    `model = ${JSON.stringify(model.model)}`,
    `model_reasoning_effort = ${JSON.stringify(model.effort)}`,
    `sandbox_mode = ${JSON.stringify(config.readOnly ? "read-only" : "workspace-write")}`,
    // Encode the whole instruction payload (body + isolation footer) as a
    // single-line TOML basic string so no byte in the attacker-influenceable
    // body can terminate the string or open a top-level key (run-5 audit Med #7).
    `developer_instructions = ${encodeTomlBasicString(`${body}\n\n${isolation}`)}`,
    ""
  ].join("\n");
}

// Read-side validator for the profiles profileToml above emits: the doctor's
// codex-agents check must REJECT a generated `.codex/agents/*.toml` that EXISTS
// but is malformed (a truncated/garbled profile that still ends in `.toml`),
// not merely count it. The codebase carries no general TOML parser by design --
// config.toml is handled by the scoped line editors in codex-thread-limits.js /
// codex-install.js ("a general parser is unwarranted complexity") -- so this is
// the counterpart line validator for the exact restricted subset profileToml
// produces: a flat list of top-level `key = <single-line scalar>` assignments
// (a double-quoted basic string, plus -- for robustness against hand-authored
// fixtures -- a single-quoted literal string, boolean, or integer), blank lines,
// and `#` comments. A generated profile is NEVER a table, array, or multiline
// string, so any of those -- or an unterminated string, an invalid escape, a
// bare value, or a duplicate key -- is malformed for THIS artifact class and
// throws. Returns the parsed key->raw-value map (proving it parsed) for a
// well-formed profile; every real generated profile round-trips through it.
const TOML_BASIC_STRING = String.raw`"(?:[^"\\]|\\(?:["\\btnfr/]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}))*"`;
const TOML_LITERAL_STRING = String.raw`'[^']*'`;
const TOML_SCALAR_PREFIX = new RegExp(`^(?:${TOML_BASIC_STRING}|${TOML_LITERAL_STRING}|true|false|[+-]?(?:0|[1-9](?:_?\\d)*))`);
const TOML_KEY_ASSIGNMENT = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/;

export function parseAgentProfileToml(text) {
  const profile = {};
  const lines = String(text).split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\r$/, "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const assignment = line.match(TOML_KEY_ASSIGNMENT);
    if (!assignment) throw new Error(`malformed agent profile TOML at line ${index + 1}: ${trimmed.slice(0, 40)}`);
    const [, key, valueRaw] = assignment;
    const scalar = valueRaw.match(TOML_SCALAR_PREFIX);
    if (!scalar || !/^\s*(?:#.*)?$/.test(valueRaw.slice(scalar[0].length))) {
      throw new Error(`malformed agent profile TOML value for "${key}" at line ${index + 1}`);
    }
    if (Object.hasOwn(profile, key)) throw new Error(`duplicate agent profile TOML key "${key}" at line ${index + 1}`);
    profile[key] = scalar[0];
  }
  return profile;
}

// codex/agents.manifest.json is a trust boundary: every `id` becomes a
// `${id}.toml` path segment a downstream writer join()s into a destination,
// and every `config.source` becomes a read path. A manifest-controlled id like
// "../evil" or a source like "../../etc/passwd" would otherwise escape their
// roots (arbitrary write / arbitrary read). Each id must be a strict safe
// kebab token BEFORE it is ever a segment. This is the exact stem of
// codex-install.js's PROFILE_FILENAME (`^[a-z0-9]+(?:-[a-z0-9]+)*$`), so every
// id accepted here yields a `${id}.toml` that also satisfies that destination
// guard -- no id can pass here yet trip the containment check there. It is a
// strict subset of src/sprint-waves.js's ID_TOKEN_RE (which tolerates the
// trailing/doubled hyphens this rejects).
const ID_TOKEN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// The manifest's top-level `agents` object (id -> config) is the SOLE input
// every profile, the staged agents tree, and the published plugin are built
// from. Validate its SHAPE before generating a single profile -- and therefore
// before the caller stages any TOML or mutates any publish destination -- so a
// missing / null / non-object / empty mapping fails closed with nothing staged
// or published (Codex dogfood audit of this path: the old `mapping.agents || {}`
// silently coerced missing/null/number/empty to ZERO profiles -- a degenerate
// publish -- and let an array/string crash late mid-iteration with a confusing
// per-entry "has no source" instead of naming the real shape problem). A valid
// nonempty mapping is returned unchanged, so the committed manifest generates
// the exact same profile set as before.
function assertAgentMapping(agents) {
  if (agents === undefined) throw new Error("Codex agent mapping is missing: agents.manifest.json must define a top-level \"agents\" object");
  if (agents === null) throw new Error("Codex agent mapping is null: agents.manifest.json \"agents\" must be a plain object, not null");
  if (typeof agents !== "object" || Array.isArray(agents)) {
    throw new Error(`Codex agent mapping must be a plain object mapping agent ids to configs, not ${Array.isArray(agents) ? "an array" : typeof agents}`);
  }
  if (Object.keys(agents).length === 0) throw new Error("Codex agent mapping is empty: agents.manifest.json \"agents\" defines no agents");
  return agents;
}

// Returns a Map of `${id}.toml` -> generated profile content, sourced only
// from the frozen codex/agents.manifest.json mapping and its referenced agent
// markdown files. No build step, no staging directory, no Codex CLI needed.
export async function generateCodexProfiles(root) {
  const mapping = readRegularJson(join(root, "catalog", "agents.manifest.json"), "Codex agent mapping", 256 * 1024);
  const agents = assertAgentMapping(mapping.agents);
  const files = new Map();
  for (const [id, config] of Object.entries(agents)) {
    if (!ID_TOKEN_RE.test(id)) throw new Error(`Codex agent mapping id is not a safe token: ${JSON.stringify(id)}`);
    if (typeof config.source !== "string" || !config.source) throw new Error(`Codex agent mapping entry ${id} has no source`);
    // resolve() honors an absolute source as-is (so it escapes root and is
    // rejected) and normalizes any `..` before the containment check; the
    // same resolved path is what gets read, so contained() rejecting an escape
    // guarantees the escaping file is never read.
    const sourcePath = resolve(root, config.source);
    contained(root, sourcePath, `Codex agent source for ${id}`);
    const source = readRegular(sourcePath, `Codex agent source for ${id}`).toString("utf8");
    files.set(`${id}.toml`, profileToml(id, source, config));
  }
  return files;
}

function atomicWritePointer(path, content) {
  let temporary, fd;
  try {
    for (let attempt = 0; ; attempt++) {
      temporary = `${path}.muster-${process.pid}-${randomUUID()}.tmp`;
      try { fd = openSync(temporary, "wx", 0o600); break; }
      catch (error) { if (error.code !== "EEXIST" || attempt === 7) throw error; }
    }
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    ordinary(temporary, "file", "staged Codex marketplace pointer");
    JSON.parse(readFileSync(temporary, "utf8"));
    renameWithRetry(temporary, path);
    temporary = null;
  } finally {
    if (fd !== null && fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
    if (temporary) rmSync(temporary, { force: true });
  }
}

// Copies a staged tree into place, rejecting (not silently dropping) any
// symlink or special file `assertRegularTree` would also reject, without
// requiring a second full tree walk before the copy starts: cpSync's filter
// callback inspects (and skips) each entry as it is visited during the copy
// itself. A skipped entry is a hard error — see publishCodexPlugin's
// docblock for why a silently incomplete copy would be worse than failing
// closed — so callers must not treat a normal return as "everything staged
// was copied" without also checking this can throw.
export function copyStagedPluginTree(source, destination) {
  const skipped = [];
  cpSync(source, destination, {
    recursive: true,
    filter: entry => {
      let stat;
      try { stat = lstatSync(entry); }
      catch { return true; } // let cpSync raise its own natural error for a source that vanished mid-copy
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) { skipped.push(entry); return false; }
      return true;
    }
  });
  if (skipped.length) {
    throw new Error(`Codex plugin publish refused to copy ${skipped.length} unsafe (symlink or special) staged entr${skipped.length === 1 ? "y" : "ies"}: ${skipped.join(", ")}`);
  }
}

// Publishes a freshly staged Codex plugin tree into `pluginsRoot/plugin`,
// replacing whatever was there before, and (re)writes
// `pluginsRoot/marketplace.json` to point at it. `pluginsRoot` is entirely
// caller-chosen (both `npm run build:codex` and codex-install.js use a
// gitignored repo-relative staging directory today; a directory under the
// user's CODEX_HOME is an equally valid target this function does not care
// about).
//
// This is NOT a single atomic swap. `stagedPlugin` is always staged on the
// native filesystem (scripts/build-codex.mjs's top comment), so it is
// frequently on a different device than `pluginsRoot` — an EXDEV rename is
// not an option — and even where they happen to share a device, renaming
// that tree immediately after the write burst that produced it is exactly
// the confirmed WSL2 drvfs (/mnt/c) rename-after-write-burst pathology
// documented above renameWithRetry. So publish retires-then-copies-then-
// commits: rename the existing `plugin` dir aside to a retirement path
// (same-device, a cold, already-settled directory, not the one just
// hot-written — unaffected by that pathology), copy the staged tree into
// place, then (re)write the marketplace pointer. The whole span from
// retirement THROUGH the durable pointer commit is transactional: the retired
// dir is RETAINED (not deleted right after a successful copy) until the
// pointer is committed, and on ANY failure in that span — a failing copy, the
// post-copy re-validation, or a malformed / missing / symlinked / write-
// failing marketplace pointer — both the previous plugin tree (from the
// retained retirement) AND the prior pointer are best-effort restored, so a
// failed publish leaves the previous plugin+pointer intact rather than the new
// plugin stranded with the old one already swept. The retirement is swept only
// once the pointer is durably committed.
//
// `assertRegularTree(stagedPlugin)` above validates the staged tree once,
// before the publish lock is even acquired. That leaves a real window: a
// same-user writer (or a crashed/racing build) could mutate the staged
// tmpdir between that validation and the copy below. THREE independent
// defenses close it: `copyStagedPlugin` (default `copyStagedPluginTree`)
// rejects/skips any symlink or special file it finds while copying, hard
// failing rather than silently dropping it; `pluginPath` — the actual copy
// destination — is re-validated with `assertRegularTree` again before
// anything durable (the marketplace pointer) is written; and the STAGED tree
// (hashed at copy time) is compared against the COPIED tree by content digest
// (treeDigest over every relative path + size + sha256). The digest check is
// the one that closes residual (ii): a same-user attacker who swaps an
// ancestor to a symlink mid-copy and swaps it back leaves the final-state
// realpath equal (so assertPluginsRootCanonical's realpath equality is
// defeated) but changes the bytes that reached `pluginPath`, so the copied
// digest no longer matches the staged digest and the publish is rejected —
// whether the redirect truncated the copy, dropped files, or swapped content.
// Any of the three firing restores the previous plugin AND the prior pointer
// the same way any late failure in the transactional span does.
//
// Residual (i) — the `.build.lock` create — is closed by re-asserting
// canonical resolution immediately BEFORE acquiring the lock AND again inside
// the lock primitive's `beforeOpen` hook, which fires synchronously right
// before each `open(lock,"wx")`. An ancestor swapped in the window between the
// pre-lock realpath capture and the lock open is therefore caught before the
// lock file can be created THROUGH the symlink into the attacker's target.
//
// DOCUMENTED RESIDUAL (genuinely unclosable in Node, same honesty as the
// atomicWritePointer window below): every guard here is check-then-syscall.
// Between a synchronous canonical re-check returning and the kernel resolving
// the very next open/copy path, a same-user attacker could still swap an
// ANCESTOR and — for a mutation whose final on-disk realpath it then restores
// — evade realpath equality. The digest comparison closes that for the copy
// (content, not path, is compared), but the sub-instruction window on the lock
// create and on the pointer commit is closable only by an openat/openat2
// primitive holding each parent by descriptor, which Node core does not
// expose; binding libc for it is out of proportion to a same-user,
// build/install-time-only threat, so it is documented rather than closed.
//
// Concurrent publishes to the same `pluginsRoot` are serialized by the
// shared codex-lock.js primitive, so two publishers never interleave. But
// nothing here synchronizes with a concurrent *reader*: resolveCodexPlugin
// below, scripts/check-codex.mjs, src/codex-doctor.js, and this module's own
// build-time skip-check all read `pluginsRoot` without taking any lock. A
// reader that runs during the retire-then-copy window can observe a
// transient ENOENT (while the previous `plugin` dir is retired but the new
// one is not yet in place) or, if it races the copy itself, a partial tree.
// That is an accepted trade, not an oversight: every one of those readers is
// dev/CI tooling invoked by a human or a build step, and simply rerunning
// resolves it — resolveCodexPlugin absorbs the narrow ENOENT case with a
// small bounded retry (see its docblock) so most callers never even notice.
// A publish that crashes mid-copy can still leave a partial `plugin` dir
// (and, if the crash lands between retirement and copy, an orphaned
// `.muster-retired-*` sibling — swept at the top of the next publish, below)
// for the next build/install to detect (via resolveCodexPlugin's tree and
// version checks) and overwrite.
// Codex resolves a marketplace entry's `source.path` relative to the ROOT passed
// to `codex plugin marketplace add`, NOT relative to the marketplace.json's own
// directory (verified empirically against Codex 0.144.5; see docs/research/codex-cli.md).
// muster always builds the plugin at `<addedRoot>/.agents/plugins/plugin` and adds
// the marketplace from `<addedRoot>`, so the pointer must name the plugin from that
// root: `./.agents/plugins/plugin`. Writing `./plugin` (relative to the manifest's
// own dir, as an earlier revision wrongly assumed Codex would resolve) makes Codex
// install `<addedRoot>/plugin` -- the Claude plugin, whose default `hooks/hooks.json`
// Codex >=0.144.5 auto-discovers and FIRES, duplicating muster's scoped hooks.json
// install (the hook-bombardment regression). The path is derived purely from
// pluginsRoot via the build invariant (pluginsRoot === <addedRoot>/.agents/plugins),
// so publish and resolve compute the identical string with no extra plumbing, and it
// stays an exact-match traversal guard.
//
// The invariant (pluginsRoot === <addedRoot>/.agents/plugins, addedRoot == the
// `marketplace add`-ed root) holds for every shipped caller -- the CLI's build
// (build-codex.mjs, outDir === <root>/.agents/plugins) and `runCodexInstall`
// (marketplace add <distributionRoot>, build into <distributionRoot>/.agents/plugins).
// It is NOT asserted at runtime: a hypothetical caller building to a differently
// nested pluginsRoot would still make publish and resolve agree with each other
// (muster's self-checks stay green) while Codex's external resolution installed from
// a different dir. No such caller exists today; doctor's pluginRoot branch already
// bypasses this pointer check for the same reason.
function codexMarketplacePluginPath(pluginsRoot) {
  const addedRoot = resolve(pluginsRoot, "..", "..");
  return "./" + relative(addedRoot, join(pluginsRoot, "plugin")).replaceAll("\\", "/");
}

// The canonical Muster plugin name. It is the value scripts/build-codex.mjs
// stamps into the staged `.codex-plugin/plugin.json` `name`, and the same
// literal the marketplace-pointer contract (below and in resolveCodexPluginOnce)
// requires. A staged manifest declaring any other name is a mislabeled build.
const EXPECTED_PLUGIN_NAME = "muster";

// Pre-publication contract check (run-5 audit Med #8). Before ANY destination
// mutation, prove the STAGED tree's declared identity matches the version this
// publish was ASKED to ship. A staging bug, a stale build tree, or a swapped
// file could otherwise land a plugin whose package.json / plugin.json name or
// version disagrees with `packageVersion`, mislabeling the plugin at the
// marketplace pointer (which pins `.../<version>/` paths). Both staged files
// are read through the no-follow reader (readRegularJson -> readRegular ->
// readRegularNoFollow), consistent with the harden-release-no-follow-io work,
// so a file swapped for a symlink is rejected rather than followed. Any
// mismatch throws naming the field and expected-vs-actual. This is called
// BEFORE the first destination mutation (before the pluginsRoot mkdir, the
// lock, the retire rename, and the copy), so a rejection leaves the destination
// byte-unchanged and emits no success receipt.
function assertStagedPublishContract(stagedPlugin, packageVersion) {
  const pkg = readRegularJson(join(stagedPlugin, "package.json"), "staged Codex plugin package descriptor", 64 * 1024);
  if (pkg?.version !== packageVersion) {
    throw new Error(`Codex plugin publish contract violation: staged package.json version ${JSON.stringify(pkg?.version)} does not match requested package version ${JSON.stringify(packageVersion)}`);
  }
  const manifest = readRegularJson(join(stagedPlugin, ".codex-plugin", "plugin.json"), "staged Codex plugin manifest", 64 * 1024);
  if (manifest?.version !== packageVersion) {
    throw new Error(`Codex plugin publish contract violation: staged .codex-plugin/plugin.json version ${JSON.stringify(manifest?.version)} does not match requested package version ${JSON.stringify(packageVersion)}`);
  }
  if (manifest?.name !== EXPECTED_PLUGIN_NAME) {
    throw new Error(`Codex plugin publish contract violation: staged .codex-plugin/plugin.json name ${JSON.stringify(manifest?.name)} does not match expected plugin name ${JSON.stringify(EXPECTED_PLUGIN_NAME)}`);
  }
}

export async function publishCodexPlugin({ pluginsRoot, stagedPlugin, packageVersion, marketplaceTemplate, copyStagedPlugin = copyStagedPluginTree, writePointer = atomicWritePointer, acquireLock = withCodexFileLock }) {
  if (typeof packageVersion !== "string" || !packageVersion.trim()) throw new Error("Codex plugin package version is required");
  ordinary(stagedPlugin, "directory", "staged Codex plugin");
  await assertRegularTree(stagedPlugin);
  // Verify the staged tree's declared name/version match what we were asked to
  // publish BEFORE touching the destination (no mkdir, no lock, no retire, no
  // copy has run yet), so a mislabeled build fails closed with the previous
  // plugin + pointer untouched. See assertStagedPublishContract's docblock.
  assertStagedPublishContract(stagedPlugin, packageVersion);
  // Reject a symlinked ANCESTOR of pluginsRoot before creating or locking it:
  // the lock file, and every publish mutation below, are built by join()ing
  // onto pluginsRoot, so a symlinked ancestor would silently redirect them out
  // of the intended tree. This must precede the mkdir so no fresh component is
  // created THROUGH such a link.
  ensureOrdinaryAncestry(pluginsRoot, "Codex plugin staging root");
  ensureOrdinaryDirectory(pluginsRoot, "Codex plugin staging root");
  // Canonical identity captured once, now that the ancestry is certified
  // symlink-free, to compare against before each mutation (see
  // assertPluginsRootCanonical).
  const canonicalPluginsRoot = realpathSync(pluginsRoot);
  // Residual (i): `.build.lock` is created by the lock primitive's
  // open(lock,"wx") BEFORE the first in-lock canonical re-check ("orphan
  // sweep") could fire. Re-assert canonical resolution here, synchronously
  // just before handing off to the lock, and again via the primitive's
  // `beforeOpen` hook (which fires immediately before each open attempt), so an
  // ancestor swapped in the realpath-capture -> lock-open window cannot
  // materialize the lock file THROUGH the symlink at the attacker's target.
  assertPluginsRootCanonical(pluginsRoot, canonicalPluginsRoot, "lock acquisition");
  return acquireLock(join(pluginsRoot, ".build.lock"), async () => {
    // A publish that crashed between retiring the previous plugin and either
    // completing or restoring leaves an orphaned `.muster-retired-*`
    // sibling behind. No other process can be mid-retire right now (this
    // publish just took the lock), so any such leftover is stale crash
    // debris from a prior run: sweep it before doing anything else. The sweep
    // is a mutation (rmSync) through pluginsRoot, so re-assert canonical
    // resolution first -- a swapped ancestor must not redirect the delete.
    assertPluginsRootCanonical(pluginsRoot, canonicalPluginsRoot, "orphan sweep");
    for (const name of readdirSync(pluginsRoot)) {
      if (name.startsWith(".muster-retired-")) rmSync(join(pluginsRoot, name), { recursive: true, force: true });
    }
    const pluginPath = join(pluginsRoot, "plugin");
    const retired = join(pluginsRoot, `.muster-retired-${process.pid}-${randomUUID()}`);
    let hadPrevious = false;
    // Whether a previous plugin exists (ENOENT-swallowed) is decided
    // separately from the canonical re-check, so a swapped-ancestor rejection
    // is never mistaken for "no previous plugin" and quietly swallowed.
    let previousExists = false;
    try { ordinary(pluginPath, "directory", "existing Codex plugin"); previousExists = true; }
    catch (error) { if (error.cause?.code !== "ENOENT") throw error; }
    if (previousExists) {
      assertPluginsRootCanonical(pluginsRoot, canonicalPluginsRoot, "retire rename");
      renameWithRetry(pluginPath, retired);
      hadPrevious = true;
    }
    // One transactional region spans BOTH the staged-tree copy AND the
    // marketplace pointer commit (see this function's docblock). The retired
    // backup is deliberately NOT swept between the two: retaining it through
    // the pointer commit is what lets a LATE pointer failure restore the prior
    // plugin. `priorPointer` holds the exact prior pointer bytes captured just
    // before the durable write, and `pointerWriteAttempted` records whether our
    // write could have altered the on-disk pointer at all -- a read/validate
    // failure never touched it and needs no pointer restore.
    const pointerPath = join(pluginsRoot, "marketplace.json");
    let priorPointer = null;
    let pointerWriteAttempted = false;
    try {
      // stagedPlugin was just populated by a large (several-hundred-file)
      // write burst and is frequently on a different device than
      // pluginPath (see this function's docblock), so it is published by
      // copy rather than renamed into place. copyStagedPlugin, the
      // assertRegularTree re-validation, and the staged-vs-copied digest
      // comparison below are this function's THREE independent copy-time-race
      // defenses (see the docblock above).
      assertPluginsRootCanonical(pluginsRoot, canonicalPluginsRoot, "staged-tree copy");
      // Hash the staged tree at copy time (as close to the cpSync read as
      // possible: a mutation between here and the read changes what cpSync
      // copies, and the copied digest then diverges from this one). Its content
      // digest is compared against the copied tree's after the copy to catch a
      // mid-copy ancestor swap-restore that final-state realpath equality would
      // miss (residual ii).
      const stagedTree = await assertRegularTree(stagedPlugin);
      await copyStagedPlugin(stagedPlugin, pluginPath);
      const copiedTree = await assertRegularTree(pluginPath);
      if (treeDigest(stagedTree) !== treeDigest(copiedTree)) {
        throw new Error(`Codex plugin publish staged-vs-copied digest mismatch (copy redirected or truncated mid-publish): ${pluginPath}`);
      }

      // Marketplace pointer read/validate/commit -- INSIDE the transactional
      // region so a malformed / missing / symlinked / write-failing pointer
      // rolls the whole publish back to the prior plugin + pointer rather than
      // leaving the freshly copied plugin stranded with the old one gone.
      //
      // The prior pointer's bytes are retained from THIS single read (not a
      // second readFileSync): the exact bytes that validate the pointer are the
      // ones a later write failure restores byte-for-byte, with no second read
      // that could transiently fail for a non-ENOENT reason and be mistaken for
      // "no prior pointer" -- which would delete a pointer that legitimately
      // existed. `priorPointer` therefore holds the prior REGULAR pointer's raw
      // bytes, or null when none existed (missing, or rejected as a symlink /
      // non-regular file). It is consumed on restore only once
      // `pointerWriteAttempted` is set, so a malformed pointer's captured bytes
      // (JSON.parse fails below, before any write) are never written back.
      let pointer;
      try { priorPointer = readRegular(pointerPath, "Codex marketplace pointer", 1024 * 1024); }
      catch (error) {
        if (error.cause?.code !== "ENOENT") throw error;
        if (!marketplaceTemplate) throw new Error(`Codex marketplace pointer is missing and no template was provided: ${pointerPath}`);
      }
      pointer = priorPointer !== null ? JSON.parse(priorPointer.toString("utf8")) : structuredClone(marketplaceTemplate);
      if (pointer?.name !== "muster" || !Array.isArray(pointer.plugins) || !pointer.plugins.some(item => item?.name === "muster")) {
        throw new Error(`Codex marketplace does not describe the Muster plugin: ${pointerPath}`);
      }
      const plugin = pointer.plugins.find(item => item.name === "muster");
      plugin.source = { ...plugin.source, source: "local", path: codexMarketplacePluginPath(pluginsRoot) };
      // Final mutation: the durable pointer commit. Re-assert canonical
      // resolution so the narrow window after the destination re-validation
      // (see this function's docblock) cannot let an ancestor swap redirect the
      // pointer write out of the intended tree.
      assertPluginsRootCanonical(pluginsRoot, canonicalPluginsRoot, "marketplace pointer commit");
      pointerWriteAttempted = true;
      writePointer(pointerPath, JSON.stringify(pointer, null, 2) + "\n");
    } catch (error) {
      // The rollback itself mutates through pluginsRoot -- it wipes pluginPath,
      // renames the retired backup back into place, and restores the prior
      // pointer -- so if an ancestor was swapped for a symlink under us (during
      // the copy or the pointer step that just failed), executing it would
      // delete/restore THROUGH the link into its target. Re-assert canonical
      // resolution first; if it no longer holds, refuse to touch the filesystem
      // at all and surface the tamper (preserving the original failure as its
      // cause) rather than mutate through the link.
      try { assertPluginsRootCanonical(pluginsRoot, canonicalPluginsRoot, "late-failure rollback"); }
      catch (tamperError) {
        throw new Error(`Codex plugin publish rollback refused; ancestor tampered: ${tamperError.message} (original publish failure: ${error.message})`, { cause: error });
      }
      // pluginPath may now hold a partial or tainted copy (unlike the old
      // copy-only failure mode, where cpSync itself never created it): wipe
      // it before restoring so a failed publish never leaves compromised
      // content in place, whether or not there was a previous plugin.
      //
      // Both restore steps below are still attempted independently and remain
      // best-EFFORT in the sense that a failure of one does not skip the other
      // -- but a failure is COLLECTED, never swallowed. If a publish fails AND
      // its rollback also fails, the retired backup or the pointer is left
      // inconsistent, and the caller must not see only the publish error while
      // silently losing that fact. Each rollback failure is recorded with the
      // EXACT affected paths and surfaced in an aggregate error whose `cause`
      // preserves the original publish failure (and its chain) unchanged. A
      // fully successful rollback still rethrows the original error untouched.
      rmSync(pluginPath, { recursive: true, force: true });
      const rollbackFailures = [];
      if (hadPrevious) {
        try { renameWithRetry(retired, pluginPath); }
        catch (restoreError) {
          rollbackFailures.push(`retired-plugin restore failed: ${restoreError.message} (retired backup ${retired} could not be renamed back to ${pluginPath}; prior plugin now missing)`);
        }
      }
      // Restore the prior pointer only if OUR write could have altered it. A
      // read/validate failure never touched the pointer, so leave it intact;
      // a write failure is undone by rewriting the captured prior bytes with
      // the internal atomic writer (independent of the possibly-failing
      // injected writePointer) or, when there was no prior pointer, by removing
      // whatever partial our write may have left behind.
      if (pointerWriteAttempted) {
        try {
          if (priorPointer !== null) atomicWritePointer(pointerPath, priorPointer.toString("utf8"));
          else rmSync(pointerPath, { force: true });
        } catch (pointerError) {
          rollbackFailures.push(`marketplace-pointer restore failed: ${pointerError.message} (pointer ${pointerPath} left inconsistent)`);
        }
      }
      if (rollbackFailures.length > 0) {
        throw new Error(
          `Codex plugin publish failed AND its rollback did not fully restore prior state; the Codex plugin/marketplace is now inconsistent: ${rollbackFailures.join("; ")} (original publish failure: ${error.message})`,
          { cause: error }
        );
      }
      throw error;
    }
    // The publish is now durably committed (plugin tree + marketplace pointer).
    // Only now is it safe to sweep the retired backup: retaining it until here
    // is what makes every late failure above recoverable. The sweep is a
    // mutation through pluginsRoot after a wide wall-clock window (copy +
    // revalidation + pointer commit), so re-assert canonical resolution first
    // -- a swapped ancestor must not redirect this delete out of the tree.
    if (hadPrevious) {
      assertPluginsRootCanonical(pluginsRoot, canonicalPluginsRoot, "retired-backup cleanup");
      rmSync(retired, { recursive: true, force: true });
    }
    return { pluginRoot: pluginPath, profilesRoot: join(pluginPath, "agents"), packageVersion };
  }, {
    // Fires synchronously right before each open(lock,"wx"): closes residual
    // (i) by rejecting an ancestor swapped into the realpath-capture ->
    // lock-open window before the lock file can be created through the symlink.
    beforeOpen: () => assertPluginsRootCanonical(pluginsRoot, canonicalPluginsRoot, "lock file creation")
  });
}

async function resolveCodexPluginOnce(pluginsRoot) {
  ordinary(pluginsRoot, "directory", "Codex plugin staging directory");
  const pointerPath = join(pluginsRoot, "marketplace.json");
  const pointer = readRegularJson(pointerPath, "Codex marketplace pointer", 1024 * 1024);
  const path = pointer?.plugins?.find(item => item?.name === "muster")?.source?.path;
  if (pointer?.name !== "muster" || path !== codexMarketplacePluginPath(pluginsRoot)) throw new Error(`Codex marketplace is missing a valid Muster plugin contract: ${pointerPath}`);
  const pluginRoot = join(pluginsRoot, "plugin");
  await assertRegularTree(pluginRoot);
  const pkg = readRegularJson(join(pluginRoot, "package.json"), "Codex plugin package descriptor", 64 * 1024);
  if (typeof pkg?.version !== "string" || !pkg.version.trim()) throw new Error(`Codex plugin is missing a coherent package version: ${pluginRoot}`);
  // Identity is the COMPLETE contract, not the package version alone (Codex
  // dogfood audit of this resolution path). A plugin whose package.json version
  // matches but whose .codex-plugin/plugin.json name or version disagrees is a
  // mislabeled or swapped manifest: version-only validation would resolve it as
  // valid and let buildCodexPlugin's same-version skip treat it as up-to-date,
  // never regenerating an internally inconsistent plugin. Re-assert the same
  // name + both-versions contract assertStagedPublishContract enforces at
  // publish time, now on the RESOLVED tree: the manifest name must equal
  // EXPECTED_PLUGIN_NAME, and its version must agree with the package version
  // (so both manifests are internally consistent and equal to the resolved
  // version). Read through the same no-follow reader (readRegularJson) so a
  // manifest swapped for a symlink is rejected rather than followed. A mismatch
  // makes resolution REJECT, so the build cache regenerates instead of skipping.
  // assertRegularTree above already proved this file is a present regular file,
  // so a mismatch here is a genuine identity violation, not a partial-copy race.
  const manifest = readRegularJson(join(pluginRoot, ".codex-plugin", "plugin.json"), "Codex plugin manifest", 64 * 1024);
  if (manifest?.name !== EXPECTED_PLUGIN_NAME) {
    throw new Error(`Codex plugin manifest name ${JSON.stringify(manifest?.name)} does not match expected plugin name ${JSON.stringify(EXPECTED_PLUGIN_NAME)}: ${pluginRoot}`);
  }
  if (manifest?.version !== pkg.version) {
    throw new Error(`Codex plugin manifest version ${JSON.stringify(manifest?.version)} does not match package version ${JSON.stringify(pkg.version)}: ${pluginRoot}`);
  }
  return { pluginRoot, profilesRoot: join(pluginRoot, "agents"), packageVersion: pkg.version };
}

// Resolves an already-published Codex plugin under `pluginsRoot` (defaulting
// to the repo-relative gitignored staging directory). Fails closed with a
// clear "run the build/install step first" error if nothing has been
// generated yet — there is no fallback bootstrap to fall back to anymore.
//
// This is a reader, and readers are never synchronized with a concurrent
// publish (see publishCodexPlugin's docblock): a call landing in the
// retire-then-copy window can see an ENOENT for `pluginPath` that clears a
// moment later on its own. A small bounded retry absorbs exactly that narrow
// window without adding any reader-side locking; it does not and cannot
// paper over a genuinely missing or invalid plugin, which still fails closed
// once the retries are exhausted.
export async function resolveCodexPlugin(root, { pluginsRoot = join(root, ".agents", "plugins") } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await resolveCodexPluginOnce(pluginsRoot); }
    catch (error) {
      if (error?.cause?.code !== "ENOENT" || attempt >= 3) throw error;
      await new Promise(r => setTimeout(r, 10 * (attempt + 1)));
    }
  }
}
