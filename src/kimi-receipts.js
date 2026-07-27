import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

// ───────────────────────────────────────────────────────────────────────────
// Kimi-native token receipts: per-dispatch usage attribution from wire.jsonl
//
// PROBE EVIDENCE (2026-07-27, kimi v0.29.1, real `kimi -p` runs):
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

// Verbatim field names from the captured usage.record objects (v0.29.1).
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

// Attribute a whole session's token consumption per agent. Every
// agents/<id>/wire.jsonl under the session dir is summed; state.json (when
// present and parseable) supplies type + parentAgentId. `dispatches` is the
// per-dispatch view the token-gap measurement wants: one entry per subagent
// (state.json type "sub", or any non-main agent when state.json is absent).
export async function readSessionUsage(sessionDir) {
  if (typeof sessionDir !== "string" || !sessionDir) throw new Error("readSessionUsage: sessionDir is required");
  let state = null;
  try {
    state = JSON.parse(await readFile(path.join(sessionDir, "state.json"), "utf8"));
  } catch {
    state = null; // no state.json (or unreadable) -- fall back to the agents tree alone
  }
  let agentDirs = [];
  try {
    agentDirs = (await readdir(path.join(sessionDir, "agents"), { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort();
  } catch (err) {
    throw new Error(`readSessionUsage: cannot read agents tree under ${sessionDir}: ${err.message}`);
  }
  const agents = {};
  for (const agentId of agentDirs) {
    let wireText = "";
    try {
      wireText = await readFile(path.join(sessionDir, "agents", agentId, "wire.jsonl"), "utf8");
    } catch {
      // an agent dir without a wire file contributed nothing measurable
    }
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
