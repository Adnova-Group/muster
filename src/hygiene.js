// Burn-hygiene guards: a dead run (crashed orchestrator, killed CLI session) must
// never be able to strand machine state indefinitely. Guards against the exact
// shape of a real incident: a Codex orchestration burn left 2 zombie codex CLI
// processes running for a day (quota drain), 34 stale worktrees, and a dead
// runner's coordination claim ({claimed: codex-efficiency@...}) parked for a day.
//
// Three independent guards, each a pure function over an INJECTED provider (a
// process-list snapshot, a worktree-list snapshot, a backlog-file claim
// timestamp) -- none of the guard logic itself spawns `ps`/`git` or reads the
// real clock, so it is fully unit-testable without a real process or worktree.
// The OS-facing providers (listSystemProcessesSync/listGitWorktreesSync) live at
// the bottom of this file and are exercised only by the CLI wiring, never by the
// pure-function tests.
//
// Conservative by construction:
//   - Zombie reap is opt-in (`--reap`) AND further gated per-process TWICE:
//     only a process whose parent is provably dead (ppid 1, or a ppid absent
//     from the same snapshot), whose pid has a recorded Muster dispatch receipt,
//     AND whose stable start identity survives an immediate pre-signal check is
//     ever reap-eligible. A process
//     merely flagged by the stale-start age heuristic, but whose parent is
//     still alive, is reported ONLY -- it is still owned by a live supervisor,
//     and killing it on an age guess alone is exactly the burn this guard
//     exists to prevent, not cause. An orphaned process with no muster
//     provenance is likewise reported ONLY -- another tool's legitimately
//     orphaned codex/claude process has the same ps shape, and SIGTERMing it
//     would itself be the burn (audit S10).
//   - The worktree guard never deletes anything, `--reap` or not -- worktree
//     removal can destroy uncommitted work, which stays a human decision; this
//     guard only ever *offers* a sweep (reports candidates + a suggested command).
//   - Claim release only fires once a claim's heartbeat EXCEEDS the staleness
//     threshold (default 60 minutes) -- a live runner never races this guard,
//     it just needs to keep its own claim timestamp fresh.

import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { sep } from "node:path";
import { computeSprintWaves } from "./sprint-waves.js";

// ---------------------------------------------------------------------------
// Guard 1 -- zombie provider CLI process: detect + (conservatively) reap
// ---------------------------------------------------------------------------

export const DEFAULT_PROVIDER_PROCESS_PATTERN = /^(codex|claude|kimi)$/i;
export const DEFAULT_ZOMBIE_STALE_MS = 60 * 60 * 1000; // 60 minutes

// Reap PROVENANCE (audit S10, security): a dead parent alone never makes a
// host process muster's to kill -- another tool's legitimately orphaned
// codex/claude process (a detached editor session, a crashed non-muster run)
// matches the exact same ps shape, and SIGTERMing it would be the very burn
// this guard exists to prevent. Reap eligibility must be corroborated by
// MUSTER-OWNED state before any kill:
//   - "dispatch-receipt": the pid AND stable start identity match a recorded
//     dispatch receipt (injected via `dispatchReceipts: [{pid,startIdentity}]`).
// A `.worktrees/` cwd is useful diagnostic context but is not ownership proof:
// anyone can create a worktree under that directory. An unreceipted orphan is
// still detected and reported, but never reaped.

// True when `cwd` equals `root` or sits strictly inside it (lexical; both are
// expected absolute here -- ps /proc readlinks and git worktree paths are).
function cwdUnderRoot(cwd, root) {
  return cwd === root || cwd.startsWith(root.endsWith(sep) ? root : root + sep);
}

// Worktree roots matching muster's convention, retained for diagnostic context.
// They are not ownership provenance: a process parked there proves nothing
// about who dispatched it.
export function deriveMusterWorktreeRoots(worktrees) {
  return (Array.isArray(worktrees) ? worktrees : [])
    .filter((w) => w && !w.bare && typeof w.path === "string" && /[\\/]\.worktrees(?:[\\/]|$)/.test(w.path))
    .map((w) => w.path);
}

// A command LINE (full argv joined with spaces) is not the same thing as the
// invoked EXECUTABLE -- matching the pattern against the whole line would
// false-positive on any process whose path merely CONTAINS "codex"/"claude"
// as a substring (e.g. a hook script run from a `.claude/worktrees/...`
// checkout path, which is exactly this repo's own layout). Isolate the first
// whitespace-separated token, strip its directory and a Windows-style
// executable extension, and match the pattern against THAT basename only.
function commandExecutableName(command) {
  const firstToken = (command || "").trim().split(/\s+/)[0] || "";
  const base = firstToken.split(/[\\/]/).pop() || "";
  return base.replace(/\.(exe|cmd|bat)$/i, "");
}

// processes: [{ pid, ppid, command, startedAt, startIdentity?, cwd? }],
// startedAt is epoch ms or an ISO string; cwd is diagnostic only, while
// startIdentity is the stable kernel identity required for reap. newestRunMarkerAt
// anchors the stale-start heuristic -- the most recent known "a run started"
// timestamp (epoch ms or ISO string); a provider process whose start predates
// it by more than staleMs is flagged as stale. musterRoots: known muster run
// worktree roots (see deriveMusterWorktreeRoots); dispatchReceipts:
// identity-bound `{pid,startIdentity}` records. Legacy pid-only receipts never
// feed the ownership gate.
export function findZombieProcesses(processes, {
  pattern = DEFAULT_PROVIDER_PROCESS_PATTERN,
  newestRunMarkerAt,
  staleMs = DEFAULT_ZOMBIE_STALE_MS,
  musterRoots = [],
  dispatchReceipts = [],
} = {}) {
  const list = Array.isArray(processes) ? processes : [];
  const knownPids = new Set(list.map((p) => p.pid));
  const markerMs = newestRunMarkerAt == null
    ? null
    : (typeof newestRunMarkerAt === "number" ? newestRunMarkerAt : Date.parse(newestRunMarkerAt));
  const roots = Array.isArray(musterRoots) ? musterRoots : [];
  const receiptIdentities = new Map(
    (Array.isArray(dispatchReceipts) ? dispatchReceipts : [])
      .filter((r) =>
        r && Number.isInteger(Number(r.pid)) && Number(r.pid) > 0 &&
        typeof r.startIdentity === "string" && r.startIdentity
      )
      .map((r) => [Number(r.pid), r.startIdentity])
  );

  const zombies = [];
  for (const proc of list) {
    if (!proc || typeof proc.command !== "string" || !pattern.test(commandExecutableName(proc.command))) continue;

    const ppid = Number(proc.ppid);
    // "parent is dead/1": reparented to init (ppid === 1), or its ppid simply
    // isn't present in this same process-list snapshot (an orphan the kernel
    // hasn't relabeled ppid=1 for, e.g. some container/PID-namespace setups).
    const orphaned = ppid === 1 || (Number.isFinite(ppid) && !knownPids.has(ppid));

    let staleStart = false;
    if (markerMs != null && Number.isFinite(markerMs) && proc.startedAt != null) {
      const startMs = typeof proc.startedAt === "number" ? proc.startedAt : Date.parse(proc.startedAt);
      if (Number.isFinite(startMs) && (markerMs - startMs) > staleMs) staleStart = true;
    }

    if (!orphaned && !staleStart) continue;

    const reasons = [];
    if (orphaned) reasons.push("orphaned-parent");
    if (staleStart) reasons.push("stale-start");

    // Worktree membership is diagnostic only. Ownership comes exclusively
    // from the existing narrow dispatch receipt contract (a receipted pid).
    const cwdMatchesMusterWorktree =
      typeof proc.cwd === "string" && proc.cwd && roots.some((r) => cwdUnderRoot(proc.cwd, r));
    const startIdentity =
      typeof proc.startIdentity === "string" && proc.startIdentity ? proc.startIdentity : null;
    const receiptIdentity = receiptIdentities.get(Number(proc.pid)) ?? null;
    const receiptIdentityMatch =
      receiptIdentity === null || startIdentity === null ? null : receiptIdentity === startIdentity;
    const provenance = receiptIdentityMatch === true ? "dispatch-receipt" : null;

    zombies.push({
      pid: proc.pid,
      ppid: Number.isFinite(ppid) ? ppid : null,
      command: proc.command,
      startedAt: proc.startedAt ?? null,
      reasons,
      provenance,
      cwdMatchesMusterWorktree: Boolean(cwdMatchesMusterWorktree),
      startIdentity,
      receiptIdentity,
      receiptIdentityMatch,
      // The conservative reap gate requires orphanage, a receipt, and stable
      // identity. The identity is revalidated immediately before SIGTERM.
      reapable: orphaned && provenance !== null && startIdentity !== null,
    });
  }
  return { ok: true, zombies };
}

// zombies: findZombieProcesses(...).zombies. kill defaults to a real SIGTERM;
// tests inject a fake to assert exactly which pids get touched.
export function reapZombieProcesses(zombies, { kill, getProcessIdentity } = {}) {
  const killer = typeof kill === "function" ? kill : (pid) => process.kill(pid, "SIGTERM");
  const identityProvider = typeof getProcessIdentity === "function"
    ? getProcessIdentity
    : readProcessStartIdentitySync;
  const reaped = [];
  const skipped = [];
  for (const z of (zombies || [])) {
    if (!z.reapable) {
      // Distinguish the two non-reapable shapes: a parent-alive process (the
      // stale-start age heuristic alone is never sufficient), vs an orphan
      // with no muster provenance (orphanage alone is never sufficient --
      // audit S10; it could be another tool's legitimately orphaned process).
      const orphaned = (z.reasons || []).includes("orphaned-parent");
      skipped.push({
        pid: z.pid,
        reason: orphaned && z.receiptIdentity !== null && z.startIdentity === null
          ? "stable process-start identity unavailable -- not reaped (the identity-bound receipt cannot be matched on this platform)"
          : orphaned && z.receiptIdentityMatch === false
            ? "dispatch receipt identity mismatch -- not reaped (the pid now belongs to a different process)"
          : orphaned && z.provenance == null
            ? "no muster provenance -- not reaped (an orphaned parent or `.worktrees/` cwd is never sufficient; the process must have a matching {pid,startIdentity} Muster dispatch receipt)"
          : orphaned
            ? "stable process-start identity unavailable -- not reaped (unsupported identity platforms remain report-only)"
          : "parent alive -- not reaped (the stale-start age heuristic alone is never sufficient to kill)",
      });
      continue;
    }
    try {
      const currentIdentity = identityProvider(z.pid);
      if (typeof currentIdentity !== "string" || !currentIdentity) {
        skipped.push({
          pid: z.pid,
          reason: "stable process-start identity unavailable during revalidation -- not reaped",
        });
        continue;
      }
      if (currentIdentity !== z.startIdentity) {
        skipped.push({
          pid: z.pid,
          reason: `process identity changed before signal -- not reaped (expected ${z.startIdentity}, found ${currentIdentity})`,
        });
        continue;
      }
      killer(z.pid);
      reaped.push(z.pid);
    } catch (e) {
      skipped.push({ pid: z.pid, reason: e.message });
    }
  }
  return { reaped, skipped };
}

// ---------------------------------------------------------------------------
// Guard 2 -- stale-worktree sweep offer (report-only, never deletes)
// ---------------------------------------------------------------------------

export const DEFAULT_WORKTREE_THRESHOLD = 10;

// Parses `git worktree list --porcelain` output into entry objects. Entries
// are separated by blank lines; each begins with `worktree <path>`, then
// optional `HEAD <sha>`, `branch <ref>` (or `detached`), `bare`, `locked
// [reason]`, `prunable [reason]` lines.
export function parseWorktreePorcelain(text) {
  const worktrees = [];
  let current = null;
  for (const line of (text || "").split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) worktrees.push(current);
      current = {
        path: line.slice("worktree ".length),
        head: null, branch: null, bare: false, detached: false,
        locked: false, lockedReason: null, prunable: false, prunableReason: null,
      };
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "locked" || line.startsWith("locked ")) {
      current.locked = true;
      current.lockedReason = line === "locked" ? null : line.slice("locked ".length);
    } else if (line === "prunable" || line.startsWith("prunable ")) {
      current.prunable = true;
      current.prunableReason = line === "prunable" ? null : line.slice("prunable ".length);
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

// worktrees: parseWorktreePorcelain(...) output (or an equivalent injected
// array in tests). Never removes anything -- only ever reports a count,
// whether the count exceeds `threshold`, and which entries look safe to sweep
// (git's own `prunable` marker: a broken/missing worktree directory).
export function evaluateWorktreeSweep(worktrees, { threshold = DEFAULT_WORKTREE_THRESHOLD } = {}) {
  const list = Array.isArray(worktrees) ? worktrees : [];
  // A `bare` entry is the repo's own bare .git directory, not a working
  // worktree doing anything -- it never counts toward the live total.
  const live = list.filter((w) => !w.bare);
  const candidates = live.filter((w) => w.prunable).map((w) => w.path);
  const sweepOffered = live.length > threshold;
  return {
    ok: true,
    count: live.length,
    threshold,
    sweepOffered,
    candidates,
    message: sweepOffered
      ? `${live.length} live worktrees exceed the hygiene threshold of ${threshold} -- stale-worktree sweep offered` +
        (candidates.length
          ? ` (${candidates.length} already marked prunable by git: ${candidates.join(", ")}).`
          : ".") +
        " Review with `git worktree list` and remove stale ones with `git worktree remove <path>` " +
        "(or `git worktree prune` for entries git already marks prunable) -- " +
        "muster does not remove worktrees automatically, that decision stays with a human."
      : null,
  };
}

// ---------------------------------------------------------------------------
// Guard 3 -- stale coordination-claim auto-release
// ---------------------------------------------------------------------------

export const DEFAULT_STALE_CLAIM_MS = 60 * 60 * 1000; // 60 minutes

function parseClaimedValue(raw) {
  if (typeof raw !== "string") return null;
  const at = raw.indexOf("@");
  if (at < 0) return null;
  const runner = raw.slice(0, at).trim();
  const tsRaw = raw.slice(at + 1).trim();
  const ts = Date.parse(tsRaw);
  if (!runner || Number.isNaN(ts)) return null;
  return { runner, ts, tsRaw };
}

// A single `{key: value}` group, as a regex source fragment (no flags/anchors
// of its own) -- mirrors sprint-waves.js's own ANNOTATION_GROUP_SRC byte for
// byte, so the trailing-block grammar these two files share stays identical
// rather than silently drifting apart into two hand-synced copies.
const ANNOTATION_GROUP_SRC = "\\{\\s*[A-Za-z][\\w-]*\\s*:\\s*[^}]*\\}";

// The trailing annotation block: one-or-more annotation groups, each
// preceded by optional whitespace, anchored to run all the way to the end of
// the line. Fresh RegExp per call, same lastIndex-safety reason sprint-waves.js
// documents for its own copy of this construction.
function trailingAnnotationBlockRegex() {
  return new RegExp(`(?:\\s*${ANNOTATION_GROUP_SRC})+\\s*$`);
}

// A single `{key: value}` group WITH its key/value captured, for iterating
// the trailing block's groups one at a time (not for scanning the whole line
// -- see the file-level note on why "whole line" is exactly the bug this
// exists to avoid).
function annotationGroupRegex() {
  return /\{\s*([A-Za-z][\w-]*)\s*:\s*[^}]*\}/g;
}

// Strips ONLY the `{claimed: ...}` annotation group from a raw backlog line,
// leaving every other annotation (`{id}`/`{deps}`/`{disposition}`/etc.) and
// the item text untouched -- including any `{claimed: ...}`-shaped substring
// that happens to appear in the item's own PROSE rather than in the real
// trailing annotation block (e.g. an item literally about renaming a
// `{claimed: ...}` flag). A naive whole-line regex would match whichever
// occurrence comes first, which can be that prose rather than the real
// annotation -- exactly the forgery risk sprint-waves.js's own trailing-block
// anchoring exists to close off (see this file's header comment on
// computeSprintWaves reuse). Anchoring the strip to the SAME trailing block
// sprint-waves.js already recognizes as live annotations means only a real
// `{claimed:}` annotation is ever touched, never a look-alike substring
// earlier in the line.
function stripClaimedAnnotation(line) {
  const blockMatch = line.match(trailingAnnotationBlockRegex());
  if (!blockMatch) return line; // no trailing annotation block at all -- nothing recognized to strip
  const bodyText = line.slice(0, blockMatch.index);
  const remainingGroups = [];
  const re = annotationGroupRegex();
  let m;
  while ((m = re.exec(blockMatch[0]))) {
    if (m[1].toLowerCase() !== "claimed") remainingGroups.push(m[0]);
  }
  const rebuilt = remainingGroups.length ? `${bodyText} ${remainingGroups.join(" ")}` : bodyText;
  return rebuilt.replace(/[ \t]+$/, "");
}

// content: a backlog.md string (sprint-waves.js's `{id}`/`{deps}`/`{claimed:
// runner@ISO-ts}` grammar). now: epoch ms or ISO string (injectable clock).
// Reuses computeSprintWaves as the single source of truth for the annotation
// grammar and per-line id/claim parsing, rather than re-deriving it here.
export function findStaleClaims(content, { now = Date.now(), staleMs = DEFAULT_STALE_CLAIM_MS } = {}) {
  const parsed = computeSprintWaves(content);
  if (!parsed.ok && Object.keys(parsed.items).length === 0) {
    return { ok: false, errors: parsed.errors, stale: [] };
  }
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  const stale = [];
  for (const [id, item] of Object.entries(parsed.items)) {
    if (!item.claimed) continue;
    const claim = parseClaimedValue(item.claimed);
    if (!claim) continue; // malformed claim value -- leave it for a human, not this guard's problem
    const ageMs = nowMs - claim.ts;
    if (ageMs > staleMs) {
      stale.push({ id, line: item.line, runner: claim.runner, claimedAt: claim.tsRaw, ageMs, thresholdMs: staleMs });
    }
  }
  return { ok: true, errors: [], stale };
}

// Same inputs as findStaleClaims; additionally returns the backlog content
// with each stale claim's `{claimed:}` annotation stripped (other annotations
// on that line preserved) plus a receipt line per release.
export function releaseStaleClaims(content, opts = {}) {
  const { ok, errors, stale } = findStaleClaims(content, opts);
  if (!ok) return { ok: false, errors, content, releases: [] };
  if (stale.length === 0) return { ok: true, errors: [], content, releases: [] };

  const lines = content.split(/\r?\n/);
  for (const s of stale) {
    lines[s.line - 1] = stripClaimedAnnotation(lines[s.line - 1]);
  }
  const releases = stale.map((s) => ({
    ...s,
    receipt: `RELEASED ${s.id} ${s.runner} stale-claim age=${Math.round(s.ageMs / 60000)}m ` +
      `(threshold=${Math.round(s.thresholdMs / 60000)}m) claimedAt=${s.claimedAt}`,
  }));
  return { ok: true, errors: [], content: lines.join("\n"), releases };
}

// ---------------------------------------------------------------------------
// OS-facing providers -- real `ps`/`git` calls, used only by the CLI wiring.
// Degrade gracefully (empty list) rather than throw: a missing `ps` binary
// (e.g. Windows) or a non-git cwd must not fail the whole hygiene verb, only
// leave that one guard with nothing to report.
// ---------------------------------------------------------------------------

export function listSystemProcessesSync() {
  try {
    const raw = execFileSync("ps", ["-eo", "pid,ppid,etimes,args", "--no-headers"], { encoding: "utf8" });
    const now = Date.now();
    return raw.split("\n").filter(Boolean).map((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!m) return null;
      const [, pid, ppid, etimes, command] = m;
      // Best-effort cwd via /proc (Linux) -- the muster-provenance signal for
      // the reap gate. Any failure (non-Linux, race with process exit,
      // permissions) degrades to null, which simply means "no cwd provenance".
      let cwd = null;
      try { cwd = readlinkSync(`/proc/${pid}/cwd`); } catch { /* no cwd provenance */ }
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        startedAt: now - Number(etimes) * 1000,
        startIdentity: readProcessStartIdentitySync(Number(pid)),
        command,
        cwd,
      };
    }).filter(Boolean);
  } catch {
    return [];
  }
}

// Linux exposes a process's kernel start tick as field 22 of /proc/<pid>/stat.
// This is stable for the process lifetime and changes when a pid is reused.
// Unsupported platforms and unreadable entries fail closed with null.
export function readProcessStartIdentitySync(pid) {
  try {
    const stat = readFileSync(`/proc/${Number(pid)}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const fieldsFromState = stat.slice(close + 1).trim().split(/\s+/);
    const startTicks = fieldsFromState[19];
    return /^\d+$/.test(startTicks || "") ? `linux-proc-stat:${startTicks}` : null;
  } catch {
    return null;
  }
}

export function listGitWorktreesSync(cwd = process.cwd()) {
  try {
    const text = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8" });
    return parseWorktreePorcelain(text);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Composition: everything the `hygiene` CLI verb needs, provider-injectable.
// ---------------------------------------------------------------------------

export function renderHygieneReport(result) {
  const lines = [];
  lines.push(`muster hygiene${result.reap ? " --reap" : ""}`);

  lines.push(`  zombies: ${result.zombies.length} detected` +
    (result.reap ? `, ${result.reapedProcesses?.reaped.length ?? 0} reaped` : " (report-only; pass --reap to reap orphaned ones)"));
  const blind = result.provenance?.blind === true;
  for (const z of result.zombies) {
    const eligibility = z.reapable
      ? `reapable (${z.provenance})`
      : (z.reasons.includes("orphaned-parent")
        ? (z.receiptIdentity !== null && z.receiptIdentityMatch !== true
          ? "report-only (dispatch receipt identity mismatch)"
          : z.provenance == null
            ? "report-only (no identity-bound dispatch receipt)"
          : "report-only (stable process identity unavailable)")
        : "report-only (parent alive)");
    lines.push(`    pid ${z.pid} ppid ${z.ppid ?? "?"} [${z.reasons.join(",")}] ` +
      `${eligibility} :: ${z.command}`);
  }
  // Without injected dispatch receipts, --reap can never fire. Say so rather
  // than letting a `.worktrees/` cwd read like ownership was established.
  if (blind) {
    const disabled = result.zombies.filter((z) => z.reasons.includes("orphaned-parent") && !z.reapable).length;
    if (disabled > 0) {
      lines.push(`  identity-bound ownership receipts unavailable: reap disabled for ${disabled} candidate${disabled === 1 ? "" : "s"} ` +
        `(no matching Muster {pid,startIdentity} dispatch receipts; cwd/worktree naming and legacy pid-only receipts are diagnostic only)`);
    }
  }
  if ((result.provenance?.rejectedDispatchReceipts ?? 0) > 0) {
    lines.push(`  dispatch receipts: ${result.provenance.rejectedDispatchReceipts} rejected ` +
      `(report-only; malformed, legacy, symlinked, or unsafe rows are never trusted or removed)`);
  }
  if ((result.provenance?.cleanedDispatchReceipts ?? 0) > 0) {
    lines.push(`  dispatch receipts: ${result.provenance.cleanedDispatchReceipts} stale receipt` +
      `${result.provenance.cleanedDispatchReceipts === 1 ? "" : "s"} cleaned without signaling`);
  }

  lines.push(`  worktrees: ${result.worktrees.count} live (threshold ${result.worktrees.threshold})` +
    (result.worktrees.sweepOffered ? " -- SWEEP OFFERED" : ""));
  if (result.worktrees.message) lines.push(`    ${result.worktrees.message}`);

  lines.push(`  stale claims: ${result.claims.releases.length}` +
    (result.reap ? " released" : " (report-only; pass --reap to auto-release)"));
  for (const r of result.claims.releases) lines.push(`    ${r.receipt}`);

  return lines.join("\n");
}

// options:
//   processes: array | () => array|Promise<array>   (default: listSystemProcessesSync)
//   worktrees: string|array | () => ...              (default: listGitWorktreesSync)
//   backlogContent: string|null | () => ...          (a missing/unreadable file -> null; claim guard reports nothing)
//   now: epoch ms (default Date.now())
//   reap: boolean -- gates zombie kill + claim release; the worktree guard NEVER deletes, reap or not
//   zombieOptions/worktreeOptions/claimOptions: passed through to each guard's pure function
//   kill/getProcessIdentity: injected signal and stable-identity providers
export async function runHygiene({
  processes = listSystemProcessesSync,
  worktrees = () => listGitWorktreesSync(process.cwd()),
  backlogContent = null,
  now = Date.now(),
  reap = false,
  zombieOptions = {},
  worktreeOptions = {},
  claimOptions = {},
  kill,
  getProcessIdentity,
  dispatchReceiptStore = null,
} = {}) {
  const processList = typeof processes === "function" ? await processes() : (processes || []);

  const wtRaw = typeof worktrees === "function" ? await worktrees() : worktrees;
  const wtList = typeof wtRaw === "string" ? parseWorktreePorcelain(wtRaw) : (wtRaw || []);
  const worktreeResult = evaluateWorktreeSweep(wtList, worktreeOptions);

  // The reap-provenance gate (see findZombieProcesses) defaults its muster
  // roots retain diagnostic cwd context; only explicit identity-bound
  // zombieOptions.dispatchReceipts establish process ownership.
  const stored = typeof dispatchReceiptStore === "function"
    ? await dispatchReceiptStore({ processes: processList, reap })
    : { receipts: [], rejected: [], cleaned: [] };
  const injectedReceipts = Array.isArray(zombieOptions.dispatchReceipts)
    ? zombieOptions.dispatchReceipts
    : [];
  const effectiveDispatchReceipts = [...injectedReceipts, ...(stored.receipts || [])];
  const zombieResult = findZombieProcesses(processList, {
    newestRunMarkerAt: now,
    musterRoots: deriveMusterWorktreeRoots(wtList),
    ...zombieOptions,
    dispatchReceipts: effectiveDispatchReceipts,
  });

  const content = typeof backlogContent === "function" ? await backlogContent() : backlogContent;
  const claimResult = content != null
    ? releaseStaleClaims(content, { now, ...claimOptions })
    : { ok: true, errors: [], content: null, releases: [] };

  const reapedProcesses = reap
    ? reapZombieProcesses(zombieResult.zombies, { kill, getProcessIdentity })
    : { reaped: [], skipped: [] };

  // Ownership availability is surfaced by renderHygieneReport. Cwd is tracked
  // only for diagnostics; injected dispatch receipts are the ownership source.
  const dispatchReceipts = effectiveDispatchReceipts;
  const validDispatchReceipts = dispatchReceipts.filter((r) =>
    r && Number.isInteger(Number(r.pid)) && Number(r.pid) > 0 &&
    typeof r.startIdentity === "string" && r.startIdentity
  );
  const provenance = {
    cwdAvailable: processList.some((p) => p && typeof p.cwd === "string" && p.cwd !== ""),
    dispatchReceipts: validDispatchReceipts.length,
    rejectedLegacyPidReceipts: Array.isArray(zombieOptions.dispatchPids)
      ? zombieOptions.dispatchPids.length
      : 0,
    stableIdentities: processList.filter(
      (p) => p && typeof p.startIdentity === "string" && p.startIdentity
    ).length,
    rejectedDispatchReceipts: stored.rejected?.length ?? 0,
    cleanedDispatchReceipts: stored.cleaned?.length ?? 0,
    blind: false,
  };
  provenance.blind = processList.length > 0 && provenance.dispatchReceipts === 0;

  return {
    ok: true,
    reap,
    zombies: zombieResult.zombies,
    reapedProcesses,
    provenance,
    worktrees: worktreeResult,
    claims: {
      // releases (with their would-be receipt text) are always computed and reported,
      // reap or not -- only whether the rewritten `content` is surfaced (below) gates
      // on --reap, since that's the only thing that would actually mutate the backlog.
      releases: claimResult.releases,
      // Only surface rewritten backlog content when actually releasing (--reap); a report-only
      // pass never produces content a caller should write back to disk.
      content: reap ? claimResult.content : undefined,
    },
  };
}
