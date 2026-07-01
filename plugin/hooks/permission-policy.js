// permission-policy.js — harness-agnostic permission gate core (wave 1).
//
// Exports a pure policy module used by the wave-2 adapter (pre-tool-use hook)
// to decide whether a tool call requires re-prompting, can be allowed from an
// allowlist, or should be denied.
//
// PORTABILITY BOUNDARY: this module is harness-agnostic. It contains NO
// hardcoded absolute paths and NO references to .claude/ paths. All file paths
// are supplied by the caller (the wave-2 adapter or tests). A reviewer may
// grep for ".claude/" and should find zero matches in this file.
//
// Intended store locations (supplied by the adapter, NOT hardcoded here):
//   Run scope   (ephemeral)  — .muster/allow.run.json
//                              Lives under .muster/ (gitignored), discarded
//                              when the run ends.
//   Project scope (durable)  — .muster-allow.json at the repo root.
//                              Tracked and committed. Deliberately NOT under
//                              .muster/ so it survives .gitignore cleanup and
//                              survives across runs.
//   Audit ledger             — .muster/permission-ledger.jsonl
//                              Append-only JSONL; one entry per gate decision.
//
// SELF-CONTAINED: only node: builtins. Ships under plugin/hooks/ with the hooks.

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

// ── classifyDestructive ──────────────────────────────────────────────────────
//
// classifyDestructive(toolName, command)
//
// Returns a short matched-fragment string when the command is destructive or
// irreversible, null otherwise. Conservative: false-negatives are preferred
// over false-positives on edge cases; the callers can always manually approve.
//
// Covered patterns:
//   rm with both -r and -f flags (any order, any spacing):
//     rm -rf ...   rm -fr ...   rm -r ... -f   rm -f ... -r
//   git push --force | git push -f | git push --force-with-lease
//   git reset --hard
//   git clean containing -f (with -d optionally):  -fd, -fdx, -df, etc.
//   SQL: DROP TABLE, DROP DATABASE, TRUNCATE (case-insensitive)
//   dd  (the low-level disk duplicator; matched as word boundary + space)
//   mkfs (any variant: mkfs.ext4, mkfs.xfs, etc.)
//
// NOT covered intentionally (handled elsewhere or low-signal):
//   cp/mv overwrites — handled by bash-write-target.js
//   rm without -r (single-file rm; recoverable from trash in most setups)
//   git clean without -f flag (dry-run form is safe)

export function classifyDestructive(toolName, command) {
  if (typeof command !== "string" || command.length === 0) return null;

  // rm with BOTH -r/-R AND -f flags present anywhere in the same invocation.
  // Match `rm` then check the combined flags in the token stream.
  const rmMatch = command.match(/\brm\b([^|;&\n]*)/);
  if (rmMatch) {
    const segment = rmMatch[1];
    // Collect all flag characters from flag tokens (tokens starting with -)
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    const flagChars = tokens
      .filter((t) => t.startsWith("-") && !t.startsWith("--"))
      .join("")
      .replace(/-/g, "");
    if (flagChars.toLowerCase().includes("r") && flagChars.toLowerCase().includes("f")) {
      return "rm -rf";
    }
    // Also check combined long-form: -rf or -fr in a single token (R/r and F/f)
    if (/\brm\s+[^|;&\n]*-[a-zA-Z]*[rR][a-zA-Z]*[fF]|rm\s+[^|;&\n]*-[a-zA-Z]*[fF][a-zA-Z]*[rR]/.test(command)) {
      return "rm -rf";
    }
  }

  // git push with a force flag
  if (/\bgit\s+push\b[^|;&\n]*(\s--force-with-lease\b|\s--force\b|\s-f\b)/.test(command)) {
    return "git push --force";
  }

  // git reset --hard
  if (/\bgit\s+reset\b[^|;&\n]*\s--hard\b/.test(command)) {
    return "git reset --hard";
  }

  // git clean with -f flag (fd, fdx, df, xfd, etc.)
  // git clean only: -f alone is destructive; -n is dry-run (safe).
  if (/\bgit\s+clean\b[^|;&\n]*-[a-zA-Z]*f/.test(command)) {
    // Ensure it is not solely -n (dry-run) — if -f is present it's destructive
    return "git clean -f";
  }

  // SQL destructive statements (case-insensitive)
  if (/\bDROP\s+TABLE\b/i.test(command)) return "DROP TABLE";
  if (/\bDROP\s+DATABASE\b/i.test(command)) return "DROP DATABASE";
  if (/\bTRUNCATE\b(?:\s+TABLE\b)?/i.test(command)) return "TRUNCATE";

  // dd (disk duplicator) — match as a word followed by whitespace or flags
  // so `add` or `odd` don't false-positive.
  if (/(?:^|[|;&\n]\s*)\s*\bdd\s/.test(command)) return "dd";

  // mkfs (any variant: mkfs, mkfs.ext4, mkfs.xfs, etc.)
  if (/\bmkfs(?:\.\w+)?\b/.test(command)) return "mkfs";

  return null;
}

// ── readStore ────────────────────────────────────────────────────────────────
//
// readStore(file) → string[]
//
// Read a JSON allowlist file and return its contents as a string array.
// Any missing file, corrupt JSON, non-array value, or non-string array entries
// are handled gracefully: missing/corrupt/non-array → []; non-string entries
// are filtered out. Never throws.

export function readStore(file) {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// ── addKey ───────────────────────────────────────────────────────────────────
//
// addKey(file, key) → void
//
// Persist `key` into the JSON allowlist at `file`. Idempotent: if the key is
// already present, the file is not modified. Best-effort: never throws.
// NOT atomic (read-modify-write without a lock). Safe because tool calls in
// the main loop are sequential in this harness. If concurrent writes are ever
// needed, switch to a temp-file + rename swap.

export function addKey(file, key) {
  try {
    const keys = readStore(file);
    if (!keys.includes(key)) {
      keys.push(key);
      writeFileSync(file, JSON.stringify(keys));
    }
  } catch { /* best-effort */ }
}

// ── permissionKey ────────────────────────────────────────────────────────────
//
// permissionKey(toolName, { command, target }) → string
//
// Produce a canonical dedupe key for use in the run/project allowlists.
//
// Key strategy:
//   Bash — key on the FULL command string. Static classifier fragments (like
//           "npm test") would collapse distinct invocations that happen to
//           share a fragment; the full string avoids that.
//   Editor tools (Edit, Write, MultiEdit, etc.) — `${toolName}:${target}`.
//           The path is the stable identity for an editor permission.

export function permissionKey(toolName, { command, target } = {}) {
  if (toolName === "Bash") {
    return `Bash:${command ?? ""}`;
  }
  return `${toolName}:${target ?? ""}`;
}

// ── resolvePermission ────────────────────────────────────────────────────────
//
// resolvePermission({ toolName, command, target, runKeys, projectKeys })
//   → { decision, reason?, scope? }
//
// decision ∈ "allow" | "prompt" | "deny"
//   "allow"  — key is in an allowlist and command is not destructive.
//              scope = "run" | "project" identifies which list matched.
//   "prompt" — user must be re-prompted. Reason is set when the destructive
//              classifier triggered (carve-out). Otherwise reason is omitted.
//   "deny"   — reserved in the enum/JSDoc for future use; not returned here.
//
// Load-bearing carve-out: if classifyDestructive returns non-null, the
// decision is ALWAYS "prompt" regardless of whether the key appears in any
// allowlist. This ensures destructive commands can never be silently allowed
// through a previously-granted permission.

export function resolvePermission({ toolName, command, target, runKeys, projectKeys }) {
  const destructiveFragment = classifyDestructive(toolName, command);
  if (destructiveFragment !== null) {
    return {
      decision: "prompt",
      reason: `destructive command matched: ${destructiveFragment}`,
    };
  }

  const key = permissionKey(toolName, { command, target });

  if (Array.isArray(runKeys) && runKeys.includes(key)) {
    return { decision: "allow", scope: "run" };
  }

  if (Array.isArray(projectKeys) && projectKeys.includes(key)) {
    return { decision: "allow", scope: "project" };
  }

  return { decision: "prompt" };
}

// ── appendLedger ─────────────────────────────────────────────────────────────
//
// appendLedger(file, { toolName, verdict, scope, runId, reason }) → void
//
// Append one JSON line (JSONL) to the ledger file at `file`. Each record
// includes an ISO 8601 timestamp in the `ts` field. The adapter supplies the
// ledger path (.muster/permission-ledger.jsonl). Best-effort: never throws.

export function appendLedger(file, { toolName, verdict, scope, runId, reason }) {
  try {
    const record = {
      ts: new Date().toISOString(),
      toolName,
      verdict,
      ...(scope != null ? { scope } : {}),
      ...(runId != null ? { runId } : {}),
      ...(reason != null ? { reason } : {}),
    };
    appendFileSync(file, JSON.stringify(record) + "\n");
  } catch { /* best-effort */ }
}
