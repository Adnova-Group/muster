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
//   - Zombie reap is opt-in (`--reap`) AND further gated per-process: only a
//     process whose parent is provably dead (ppid 1, or a ppid absent from the
//     same snapshot) is ever reap-eligible. A process merely flagged by the
//     stale-start age heuristic, but whose parent is still alive, is reported
//     ONLY -- it is still owned by a live supervisor, and killing it on an age
//     guess alone is exactly the burn this guard exists to prevent, not cause.
//   - The worktree guard never deletes anything, `--reap` or not -- worktree
//     removal can destroy uncommitted work, which stays a human decision; this
//     guard only ever *offers* a sweep (reports candidates + a suggested command).
//   - Claim release only fires once a claim's heartbeat EXCEEDS the staleness
//     threshold (default 60 minutes) -- a live runner never races this guard,
//     it just needs to keep its own claim timestamp fresh.

import { execFileSync } from "node:child_process";
import { computeSprintWaves } from "./sprint-waves.js";

// ---------------------------------------------------------------------------
// Guard 1 -- zombie provider CLI process: detect + (conservatively) reap
// ---------------------------------------------------------------------------

export const DEFAULT_PROVIDER_PROCESS_PATTERN = /\b(codex|claude)\b/i;
export const DEFAULT_ZOMBIE_STALE_MS = 60 * 60 * 1000; // 60 minutes

// processes: [{ pid, ppid, command, startedAt }], startedAt is epoch ms or an
// ISO string. newestRunMarkerAt anchors the stale-start heuristic -- the most
// recent known "a run started" timestamp (epoch ms or ISO string); a provider
// process whose start predates it by more than staleMs is flagged as stale.
export function findZombieProcesses(processes, {
  pattern = DEFAULT_PROVIDER_PROCESS_PATTERN,
  newestRunMarkerAt,
  staleMs = DEFAULT_ZOMBIE_STALE_MS,
} = {}) {
  const list = Array.isArray(processes) ? processes : [];
  const knownPids = new Set(list.map((p) => p.pid));
  const markerMs = newestRunMarkerAt == null
    ? null
    : (typeof newestRunMarkerAt === "number" ? newestRunMarkerAt : Date.parse(newestRunMarkerAt));

  const zombies = [];
  for (const proc of list) {
    if (!proc || typeof proc.command !== "string" || !pattern.test(proc.command)) continue;

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

    zombies.push({
      pid: proc.pid,
      ppid: Number.isFinite(ppid) ? ppid : null,
      command: proc.command,
      startedAt: proc.startedAt ?? null,
      reasons,
      // The conservative reap gate: ONLY an orphaned process is ever eligible
      // for --reap. See the file-level note above for why age alone never is.
      reapable: orphaned,
    });
  }
  return { ok: true, zombies };
}

// zombies: findZombieProcesses(...).zombies. kill defaults to a real SIGTERM;
// tests inject a fake to assert exactly which pids get touched.
export function reapZombieProcesses(zombies, { kill } = {}) {
  const killer = typeof kill === "function" ? kill : (pid) => process.kill(pid, "SIGTERM");
  const reaped = [];
  const skipped = [];
  for (const z of (zombies || [])) {
    if (!z.reapable) {
      skipped.push({ pid: z.pid, reason: "parent alive -- not reaped (the stale-start age heuristic alone is never sufficient to kill)" });
      continue;
    }
    try {
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

// Strips ONLY the `{claimed: ...}` annotation group from a raw backlog line,
// leaving every other annotation (`{id}`/`{deps}`/`{disposition}`/etc.) and
// the item text untouched, then collapses the whitespace the removal leaves.
function stripClaimedAnnotation(line) {
  return line
    .replace(/\{\s*claimed\s*:\s*[^}]*\}/i, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/, "");
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
      return { pid: Number(pid), ppid: Number(ppid), startedAt: now - Number(etimes) * 1000, command };
    }).filter(Boolean);
  } catch {
    return [];
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
  for (const z of result.zombies) {
    lines.push(`    pid ${z.pid} ppid ${z.ppid ?? "?"} [${z.reasons.join(",")}] ` +
      `${z.reapable ? "reapable" : "report-only (parent alive)"} :: ${z.command}`);
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
//   kill: injected process killer for reapZombieProcesses
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
} = {}) {
  const processList = typeof processes === "function" ? await processes() : (processes || []);
  const zombieResult = findZombieProcesses(processList, {
    newestRunMarkerAt: now,
    ...zombieOptions,
  });

  const wtRaw = typeof worktrees === "function" ? await worktrees() : worktrees;
  const wtList = typeof wtRaw === "string" ? parseWorktreePorcelain(wtRaw) : (wtRaw || []);
  const worktreeResult = evaluateWorktreeSweep(wtList, worktreeOptions);

  const content = typeof backlogContent === "function" ? await backlogContent() : backlogContent;
  const claimResult = content != null
    ? releaseStaleClaims(content, { now, ...claimOptions })
    : { ok: true, errors: [], content: null, releases: [] };

  const reapedProcesses = reap ? reapZombieProcesses(zombieResult.zombies, { kill }) : { reaped: [], skipped: [] };

  return {
    ok: true,
    reap,
    zombies: zombieResult.zombies,
    reapedProcesses,
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
