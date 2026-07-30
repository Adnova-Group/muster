import { readFile, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveContainedRealpath } from "./fs-safe.js";

// ───────────────────────────────────────────────────────────────────────────
// Kimi-native token receipts: per-dispatch usage attribution from wire.jsonl
//
// PROBE EVIDENCE (2026-07-27, kimi v0.29.1, real `kimi -p` runs; re-confirmed
// 2026-07-29 on kimi v0.30.0 -- same shapes throughout):
//   - `kimi -p --output-format stream-json` stdout carries NO usage fields --
//     only assistant/tool/meta objects (verified on a trivial prompt).
//   - The session tree DOES: every agents/<agentId>/wire.jsonl emits one
//       {"type":"usage.record","model":"kimi-code/k3",
//        "usage":{"inputOther":N,"output":N,"inputCacheRead":N,"inputCacheCreation":N},
//        "usageScope":"turn","time":<ms>}
//     per LLM step, and each step.end loop event embeds the same usage object.
//   - Per-dispatch attribution is structural: each dispatched subagent gets its
//     own agents/<agentId>/wire.jsonl, and state.json's agents map records
//     type ("main"|"sub") + parentAgentId -- so a subagent's wire sum IS that
//     dispatch's token consumption. This is the per-call consumption mechanism
//     docs/fast-path-token-gap.md records as missing in the other two harnesses.
//
// Scope: parse, attribute, return structured data. Nothing here prices tokens
// or rebuilds the token-gap pipeline -- it makes the measurement runnable.
// ───────────────────────────────────────────────────────────────────────────

// Verbatim field names from the captured usage.record objects (v0.29.1 captures,
// re-confirmed on v0.30.0, 2026-07-29).
// inputOther = non-cached input; the cache pair splits prompt-cache hits from
// creations. Total input = inputOther + inputCacheRead + inputCacheCreation.
export const KIMI_USAGE_FIELDS = Object.freeze(["inputOther", "output", "inputCacheRead", "inputCacheCreation"]);

// Parse one wire.jsonl's text into its usage records, in file order.
// Blank lines are skipped; a malformed JSON line throws with its line number
// (a truncated wire tail must fail loud, not silently undercount).
export function parseWireUsage(wireText) {
  if (typeof wireText !== "string") throw new Error("parseWireUsage: wireText must be a string");
  const records = [];
  const lines = wireText.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      throw new Error(`parseWireUsage: line ${index + 1} is not valid JSON: ${err.message}`);
    }
    if (obj?.type !== "usage.record") continue;
    const usage = {};
    for (const field of KIMI_USAGE_FIELDS) {
      const value = obj.usage?.[field];
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
        throw new Error(`parseWireUsage: line ${index + 1} usage.${field} must be a finite number`);
      }
      usage[field] = value ?? 0;
    }
    records.push({
      model: obj.model ?? null,
      usageScope: obj.usageScope ?? null,
      time: obj.time ?? null,
      usage
    });
  }
  return records;
}

// Fold usage records into one total. `input`/`total` are derived conveniences:
// input = all three input fields, total = input + output.
export function sumUsage(records) {
  const usage = Object.fromEntries(KIMI_USAGE_FIELDS.map(field => [field, 0]));
  const models = new Set();
  for (const record of records) {
    for (const field of KIMI_USAGE_FIELDS) usage[field] += record.usage[field];
    if (record.model) models.add(record.model);
  }
  const input = usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation;
  return {
    ...usage,
    input,
    total: input + usage.output,
    records: records.length,
    models: [...models]
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Thinking-effort receipts: the EFFECTIVE effort each LLM step ran at.
//
// PROBE EVIDENCE (2026-07-27, kimi v0.29.1, two tiny `kimi -p -m kimi-code/k3`
// runs with KIMI_MODEL_THINKING_EFFORT=low|high; re-confirmed 2026-07-29 on
// kimi v0.30.0 -- same effective-effort field and values):
//   - Every agents/<agentId>/wire.jsonl llm.request record carries a top-level
//     "thinkingEffort" field with the EFFECTIVE effort of that step -- the
//     low run emitted exactly "low", the high run exactly "high" (lowercase;
//     kimi-for-coding, which has no effort knob, emits "on").
//   - The profile.bind record ALSO carries a "thinkingEffort" -- but that is
//     the config DEFAULT ("high" in both runs, even the low one), never the
//     effective effort. It is deliberately NOT read here.
//   - The env override is conditional (it bypasses support_efforts), so the
//     receipts are the only trustworthy proof of what a step actually ran.
// ───────────────────────────────────────────────────────────────────────────

// Parse one wire.jsonl's text into the thinkingEffort of each llm.request
// record, in file order: one entry per LLM step -- the emitted string, or
// null when the field is absent (an unverifiable step, NOT a pass). Only
// llm.request records are read; profile.bind carries the config default, not
// the effective effort (probe evidence above). Blank lines are skipped; a
// malformed JSON line throws with its line number, mirroring parseWireUsage.
export function parseWireThinkingEfforts(wireText) {
  if (typeof wireText !== "string") throw new Error("parseWireThinkingEfforts: wireText must be a string");
  const efforts = [];
  const lines = wireText.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      throw new Error(`parseWireThinkingEfforts: line ${index + 1} is not valid JSON: ${err.message}`);
    }
    if (obj?.type !== "llm.request") continue;
    efforts.push(typeof obj.thinkingEffort === "string" && obj.thinkingEffort ? obj.thinkingEffort : null);
  }
  return efforts;
}

// --- sessionDir containment (audit S2) ---------------------------------------
//
// A sessionDir is a path FROM DATA, never a trusted constant: the session
// index's `sessionDir` field (any string -- readSessionIndex validates the TYPE,
// not the location), an items.json resolution object, a prose CLI arg. The CLI
// arms gate the roots they can know (src/cli.js: the run root for flag args, the
// session index's own root for an index-resolved dir), but containment that
// lives ONLY in whichever caller remembers is a gap every future caller
// inherits -- so the shared readers refuse on their own here too.
//
// Root: the session dir's OWN parent, canonicalized. That is the only root a
// reader can know without being told, and it catches the escape a lexical check
// cannot see -- an in-root NAME whose symlink target is a tree elsewhere.
// resolveContainedRealpath realpath()s the base first, so a legitimate session
// under a symlinked ANCESTOR (macOS /tmp -> /private/tmp) is not a false
// refusal. A sessionDir that cannot be canonicalized at ALL is not a refusal:
// it is simply missing, and the read below must report it with this reader's own
// historical error, never a security message.
//
// resolveSessionForCwd stays a pure resolver (it returns index data as a value,
// including UNKNOWNs); the gate sits at every point that READS a session tree.
async function containedSessionDir(sessionDir) {
  const lexical = path.resolve(sessionDir);
  try {
    await realpath(lexical);
  } catch {
    return sessionDir; // missing/dangling -- let the caller's own read name it
  }
  const canonical = await resolveContainedRealpath(path.dirname(lexical), lexical);
  if (canonical === null) {
    throw new Error(`session dir ${sessionDir} does not resolve to a path contained under its own parent directory (a symlink escape) -- refusing to read`);
  }
  return canonical;
}

// Read every agents/<id>/wire.jsonl under a session dir into raw per-agent
// wire texts: { agentId: wireText }, agent dirs sorted. An agent dir without a
// wire file contributes an empty string (it recorded no steps). Shared by the
// two session readers below (audit S11); the containment refusal and a
// missing/unreadable agents tree both throw WITHOUT a caller prefix -- each
// caller re-throws with its own name so its error contract is unchanged.
async function readAgentWires(sessionDir) {
  const root = await containedSessionDir(sessionDir);
  let agentDirs = [];
  try {
    agentDirs = (await readdir(path.join(root, "agents"), { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort();
  } catch (err) {
    throw new Error(`cannot read agents tree under ${sessionDir}: ${err.message}`);
  }
  const wires = {};
  for (const agentId of agentDirs) {
    try {
      wires[agentId] = await readFile(path.join(root, "agents", agentId, "wire.jsonl"), "utf8");
    } catch {
      wires[agentId] = ""; // an agent dir without a wire file contributed nothing measurable
    }
  }
  return wires;
}

// Read every agents/<id>/wire.jsonl under a session dir into per-agent effort
// lists: { agentId: [efforts...] }, agent dirs sorted. An agent dir without a
// wire file (or with no llm.request records) contributes an empty list.
export async function readSessionThinkingEfforts(sessionDir) {
  if (typeof sessionDir !== "string" || !sessionDir) throw new Error("readSessionThinkingEfforts: sessionDir is required");
  let wires;
  try {
    wires = await readAgentWires(sessionDir);
  } catch (err) {
    throw new Error(`readSessionThinkingEfforts: ${err.message}`);
  }
  const byAgent = {};
  for (const [agentId, wireText] of Object.entries(wires)) {
    byAgent[agentId] = parseWireThinkingEfforts(wireText);
  }
  return byAgent;
}

// Attribute a whole session's token consumption per agent. Every
// agents/<id>/wire.jsonl under the session dir is summed; state.json (when
// present and parseable) supplies type + parentAgentId. `dispatches` is the
// per-dispatch view the token-gap measurement wants: one entry per subagent
// (state.json type "sub", or any non-main agent when state.json is absent).
export async function readSessionUsage(sessionDir) {
  if (typeof sessionDir !== "string" || !sessionDir) throw new Error("readSessionUsage: sessionDir is required");
  // Containment BEFORE the first read: state.json is read here, outside
  // readAgentWires, so this reader gates the dir itself (the refusal wears this
  // reader's name; a missing dir still falls through to "cannot read agents
  // tree"). `root` is the canonical dir every read below uses; the returned
  // `sessionDir` stays the caller's own label.
  let root;
  try {
    root = await containedSessionDir(sessionDir);
  } catch (err) {
    throw new Error(`readSessionUsage: ${err.message}`);
  }
  let state = null;
  try {
    state = JSON.parse(await readFile(path.join(root, "state.json"), "utf8"));
  } catch {
    state = null; // no state.json (or unreadable) -- fall back to the agents tree alone
  }
  let wires;
  try {
    wires = await readAgentWires(root);
  } catch (err) {
    throw new Error(`readSessionUsage: ${err.message}`);
  }
  const agents = {};
  for (const [agentId, wireText] of Object.entries(wires)) {
    const meta = state?.agents?.[agentId] ?? {};
    agents[agentId] = {
      type: meta.type ?? (agentId === "main" ? "main" : "sub"),
      parentAgentId: meta.parentAgentId ?? null,
      ...sumUsage(parseWireUsage(wireText))
    };
  }
  const dispatches = {};
  for (const [agentId, entry] of Object.entries(agents)) {
    if (entry.type !== "main") dispatches[agentId] = entry;
  }
  // Session total folds the per-agent SUMS (fields add; records and models
  // accumulate), so a session with zero usage records reports all zeros.
  const total = Object.fromEntries(KIMI_USAGE_FIELDS.map(field => [field, 0]));
  let recordCount = 0;
  const models = new Set();
  for (const entry of Object.values(agents)) {
    for (const field of KIMI_USAGE_FIELDS) total[field] += entry[field];
    recordCount += entry.records;
    for (const model of entry.models) models.add(model);
  }
  const input = total.inputOther + total.inputCacheRead + total.inputCacheCreation;
  return {
    sessionDir,
    agents,
    dispatches,
    total: { ...total, input, total: input + total.output, records: recordCount, models: [...models] }
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Session attribution: which on-disk session belongs to a -p dispatch leg.
//
// PROBE EVIDENCE (2026-07-27, kimi v0.29.1; re-confirmed 2026-07-29 on v0.30.0):
//   - `kimi -p --output-format stream-json` stdout ends with
//       {"role":"meta","type":"session.resume_hint","session_id":"session_<uuid>",
//        "command":"kimi -r session_<uuid>","content":"To resume this session: ..."}
//     -- the session id, captured at dispatch time (PREFERRED path).
//   - ~/.kimi-code/session_index.jsonl holds one
//       {"sessionId":"session_<uuid>","sessionDir":"<abs>","workDir":"<abs>"}
//     per line, NO timestamps and NO ordering guarantee -- recency comes ONLY
//     from each sessionDir's state.json `updatedAt` (ISO string).
//
// Ambiguity is a VALUE, never a throw: resolution returns
//   { resolved: true, sessionId, sessionDir, source }            or
//   { resolved: false, reason, candidates }                      (UNKNOWN)
// with reason one of "no-sessions-for-cwd" | "ambiguous-tie" |
// "missing-updated-at". Only genuinely broken inputs throw: unreadable or
// malformed index, and a captured id whose index entry/session dir is gone.
// ───────────────────────────────────────────────────────────────────────────

export const DEFAULT_SESSION_INDEX = path.join(os.homedir(), ".kimi-code", "session_index.jsonl");

// Reasons a fallback resolution can come back UNKNOWN (resolution.reason).
export const UNKNOWN_REASONS = Object.freeze(["no-sessions-for-cwd", "ambiguous-tie", "missing-updated-at"]);

// Extract the session id from a -p run's stream-json stdout. Returns the id
// from the first session.resume_hint meta record, or null when stdout has no
// hint (older versions, crashed run). Non-JSON lines are skipped -- this is a
// best-effort capture ahead of the fallback resolver, not a validator.
export function captureSessionId(stdoutText) {
  if (typeof stdoutText !== "string") throw new Error("captureSessionId: stdoutText must be a string");
  for (const line of stdoutText.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj?.role === "meta" && obj?.type === "session.resume_hint" && typeof obj.session_id === "string" && obj.session_id) {
      return obj.session_id;
    }
  }
  return null;
}

// Read + parse the session index. Malformed lines are broken input (the index
// is machine-written; a torn line means something is wrong) and throw with
// their line number, mirroring parseWireUsage.
async function readSessionIndex(indexPath) {
  let text;
  try {
    text = await readFile(indexPath, "utf8");
  } catch (err) {
    throw new Error(`resolveSessionForCwd: cannot read session index at ${indexPath}: ${err.message}`);
  }
  const entries = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      throw new Error(`resolveSessionForCwd: session index line ${index + 1} is not valid JSON: ${err.message}`);
    }
    if (typeof obj?.sessionId === "string" && typeof obj?.sessionDir === "string") entries.push(obj);
  }
  return entries;
}

// state.json's updatedAt as epoch ms; NaN when absent or unparseable.
async function readUpdatedAt(sessionDir) {
  try {
    const state = JSON.parse(await readFile(path.join(sessionDir, "state.json"), "utf8"));
    return Date.parse(state?.updatedAt);
  } catch {
    return NaN;
  }
}

// Resolve the on-disk session for one -p leg.
//   capturedSessionId: from captureSessionId (PREFERRED) -- authoritative, no
//     cwd filtering; throws when the id is absent from the index or its
//     sessionDir is unreadable (genuinely broken input).
//   fallback: index entries filtered to workDir === cwd. One candidate
//     resolves ("index-unique"); several resolve to the distinct newest by
//     state.json updatedAt ("index-newest", NEVER index line order); a tie or
//     any missing updatedAt across candidates is UNKNOWN-with-reason.
export async function resolveSessionForCwd({ indexPath = DEFAULT_SESSION_INDEX, cwd, capturedSessionId = null } = {}) {
  if (typeof cwd !== "string" || !cwd) throw new Error("resolveSessionForCwd: cwd is required");
  const entries = await readSessionIndex(indexPath);
  if (capturedSessionId) {
    const entry = entries.find(e => e.sessionId === capturedSessionId);
    if (!entry) throw new Error(`resolveSessionForCwd: captured session ${capturedSessionId} not found in session index at ${indexPath}`);
    try {
      await readdir(entry.sessionDir);
    } catch (err) {
      throw new Error(`resolveSessionForCwd: captured session ${capturedSessionId} has no readable session dir ${entry.sessionDir}: ${err.message}`);
    }
    return { resolved: true, sessionId: entry.sessionId, sessionDir: entry.sessionDir, source: "captured" };
  }
  const candidates = entries.filter(e => e.workDir === cwd);
  if (candidates.length === 0) return { resolved: false, reason: "no-sessions-for-cwd", candidates: [] };
  if (candidates.length === 1) {
    return { resolved: true, sessionId: candidates[0].sessionId, sessionDir: candidates[0].sessionDir, source: "index-unique" };
  }
  const timed = [];
  for (const entry of candidates) timed.push({ entry, updatedAt: await readUpdatedAt(entry.sessionDir) });
  if (timed.some(t => !Number.isFinite(t.updatedAt))) {
    return { resolved: false, reason: "missing-updated-at", candidates: candidates.map(e => e.sessionId) };
  }
  const newest = Math.max(...timed.map(t => t.updatedAt));
  const winners = timed.filter(t => t.updatedAt === newest);
  if (winners.length > 1) {
    return { resolved: false, reason: "ambiguous-tie", candidates: winners.map(t => t.entry.sessionId) };
  }
  return { resolved: true, sessionId: winners[0].entry.sessionId, sessionDir: winners[0].entry.sessionDir, source: "index-newest" };
}

// ───────────────────────────────────────────────────────────────────────────
// Batch accounting summary: one compact line per backlog item, suitable for
// transcription into STATE before worktree teardown.
// ───────────────────────────────────────────────────────────────────────────

// Format one item's session usage (a readSessionUsage result) as a single
// compact line: session totals + per-dispatch token breakdown. `source` is the
// resolution source that produced the session (captured | index-unique |
// index-newest) -- surfaced on the line so a FALLBACK attribution reads as a
// fallback, never as confidently as a captured one.
export function formatUsageLine(itemId, sessionUsage, source = null) {
  if (typeof itemId !== "string" || !itemId) throw new Error("formatUsageLine: itemId is required");
  if (!sessionUsage?.total) throw new Error("formatUsageLine: sessionUsage (a readSessionUsage result) is required");
  const t = sessionUsage.total;
  const dispatches = Object.entries(sessionUsage.dispatches ?? {})
    .map(([agentId, entry]) => `${agentId}=${entry.total}`)
    .sort()
    .join(" ");
  const attribution = source ? ` source=${source}` : "";
  return `${itemId}: session=${path.basename(sessionUsage.sessionDir)}${attribution} total=${t.total} in=${t.input} out=${t.output} cache-read=${t.inputCacheRead} cache-create=${t.inputCacheCreation} records=${t.records} dispatches: ${dispatches || "none"}`;
}

// Run readSessionUsage per resolved session and return one line per item, in
// input order. `items` is [{ itemId, resolution }] or [{ itemId, resolutions }]
// -- `resolutions` (plural) carries every leg of a retried/fix-looped item (one
// resolveSessionForCwd result per leg) and the line SUMS across legs, labeled
// per-leg with each leg's own resolution source, so a fallback attribution on
// one leg is visible as such. A single UNKNOWN resolution formats as
// "<itemId>: UNKNOWN (<reason>)"; in a multi-leg line an UNKNOWN leg is a
// labeled gap excluded from the sum -- a line, never a throw.
export async function summarizeItemReceipts(items) {
  if (!Array.isArray(items)) throw new Error("summarizeItemReceipts: items must be an array");
  const lines = [];
  for (const item of items) {
    const { itemId } = item;
    const legs = item.resolutions ?? [item.resolution];
    if (legs.length === 1) {
      const [resolution] = legs;
      if (!resolution?.resolved) {
        lines.push(`${itemId}: UNKNOWN (${resolution?.reason ?? "no-resolution"})`);
        continue;
      }
      lines.push(formatUsageLine(itemId, await readSessionUsage(resolution.sessionDir), resolution.source));
      continue;
    }
    // Multi-leg item: sum every resolved leg, label each leg with its source.
    const totals = Object.fromEntries(KIMI_USAGE_FIELDS.map(field => [field, 0]));
    let recordCount = 0;
    const labels = [];
    for (const [index, resolution] of legs.entries()) {
      const leg = `leg-${index + 1}`;
      if (!resolution?.resolved) {
        labels.push(`${leg}=UNKNOWN(${resolution?.reason ?? "no-resolution"})`);
        continue;
      }
      const usage = await readSessionUsage(resolution.sessionDir);
      for (const field of KIMI_USAGE_FIELDS) totals[field] += usage.total[field];
      recordCount += usage.total.records;
      labels.push(`${leg}[session=${path.basename(resolution.sessionDir)} source=${resolution.source ?? "unknown"} total=${usage.total.total}]`);
    }
    const input = totals.inputOther + totals.inputCacheRead + totals.inputCacheCreation;
    lines.push(`${itemId}: legs=${legs.length} total=${input + totals.output} in=${input} out=${totals.output} cache-read=${totals.inputCacheRead} cache-create=${totals.inputCacheCreation} records=${recordCount} legs: ${labels.join(" ")}`);
  }
  return lines;
}
