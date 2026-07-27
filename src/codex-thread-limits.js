import { join } from "node:path";

export const DEFAULT_CODEX_THREAD_LIMITS = Object.freeze({
  max_concurrent_threads_per_session: 12,
});
// Kept as a compatibility export for callers that treat this object as the
// set of Muster-managed keys. It is a default, not a minimum: an existing
// positive user ceiling is authoritative even when it is below 12.
export const REQUIRED_CODEX_THREAD_LIMITS = DEFAULT_CODEX_THREAD_LIMITS;

export const CODEX_THREAD_LIMIT_REMEDIATION =
  "Set [agents] max_concurrent_threads_per_session to a positive integer in Codex's config.toml, then rerun muster install codex.";

export const codexThreadLimitConfigPath = codexHomeDir => join(codexHomeDir, "config.toml");
export const codexThreadLimitManifestPath = codexHomeDir => join(codexHomeDir, "muster", "thread-limits.json");

const CANONICAL_KEY = "max_concurrent_threads_per_session";
const LEGACY_KEYS = Object.freeze(["max_threads", "max_depth"]);
const PARSED_KEYS = Object.freeze([CANONICAL_KEY, ...LEGACY_KEYS]);

export function codexThreadLimitsMeetFloor(limits) {
  return Number.isInteger(limits?.[CANONICAL_KEY]) && limits[CANONICAL_KEY] > 0;
}

function parseAgentsSection(text) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const finalNewline = text.endsWith("\n");
  const lines = text ? text.split(/\r?\n/) : [];
  if (finalNewline) lines.pop();
  let start = -1, end = lines.length;
  for (let index = 0; index < lines.length; index++) {
    const section = lines[index].match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (!section) continue;
    if (start >= 0) { end = index; break; }
    if (section[1].trim() === "agents") start = index;
  }
  const values = {};
  if (start >= 0) for (let index = start + 1; index < end; index++) {
    for (const key of PARSED_KEYS) {
      const candidate = lines[index].match(new RegExp(`^(\\s*${key}\\s*=\\s*)(\\d+)(\\s*(?:#.*)?)$`));
      if (candidate) {
        if (Object.hasOwn(values, key)) throw new Error(`Codex config.toml has a duplicate [agents] ${key} key`);
        values[key] = { value: Number(candidate[2]), index, prefix: candidate[1], suffix: candidate[3] };
      } else if (new RegExp(`^\\s*${key}\\s*=`).test(lines[index])) {
        throw new Error(`Codex config.toml [agents] ${key} must be a non-negative integer`);
      }
    }
  }
  return { lines, newline, finalNewline, start, end, values };
}

const render = state => state.lines.join(state.newline) + (state.finalNewline || state.lines.length ? state.newline : "");

export function readCodexThreadLimits(text) {
  const state = parseAgentsSection(text);
  return { [CANONICAL_KEY]: state.values[CANONICAL_KEY]?.value ?? null };
}

export function resolveCodexThreadCeiling(text) {
  const state = parseAgentsSection(text);
  const value = state.values[CANONICAL_KEY]?.value
    ?? state.values.max_threads?.value
    ?? DEFAULT_CODEX_THREAD_LIMITS[CANONICAL_KEY];
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Codex config.toml [agents] ${CANONICAL_KEY} must be a positive integer`);
  }
  return value;
}

// Add only the canonical key. When it is absent, a user-authored legacy
// max_threads value is carried forward; otherwise Muster supplies its default.
// Existing canonical values are never raised or lowered.
export function ensureCodexThreadLimits(text) {
  const state = parseAgentsSection(text);
  const sectionCreated = state.start < 0;
  const existing = state.values[CANONICAL_KEY];
  const installedValue = existing?.value
    ?? state.values.max_threads?.value
    ?? DEFAULT_CODEX_THREAD_LIMITS[CANONICAL_KEY];
  if (installedValue < 1) {
    throw new Error(`Codex config.toml [agents] ${CANONICAL_KEY} must be a positive integer`);
  }
  if (sectionCreated) {
    if (state.lines.every(line => !line.trim())) state.lines.length = 0;
    if (state.lines.length && state.lines.at(-1).trim()) state.lines.push("");
    state.start = state.lines.length;
    state.lines.push("[agents]");
    state.end = state.lines.length;
  }
  if (!existing) state.lines.splice(state.end, 0, `${CANONICAL_KEY} = ${installedValue}`);
  return {
    text: render(state),
    before: { [CANONICAL_KEY]: existing?.value ?? null },
    installed: { [CANONICAL_KEY]: installedValue },
    sectionCreated,
  };
}

// Restore either the current canonical receipt or the pre-0.145 legacy
// max_threads/max_depth receipt. A value is touched only while it still equals
// what Muster recorded as installed; user edits after installation win.
export function restoreCodexThreadLimits(text, record) {
  const state = parseAgentsSection(text);
  const keys = Object.keys(record?.installed || {}).filter(key => PARSED_KEYS.includes(key));
  for (const key of keys) {
    const current = state.values[key];
    if (!current || current.value !== record.installed[key]) continue;
    if (record.before?.[key] === null) {
      state.lines.splice(current.index, 1);
      delete state.values[key];
      for (const value of Object.values(state.values)) if (value.index > current.index) value.index--;
    } else if (Number.isInteger(record.before?.[key])) {
      state.lines[current.index] = `${current.prefix}${record.before[key]}${current.suffix}`;
    }
  }
  if (record.sectionCreated) {
    const reparsed = parseAgentsSection(render(state));
    if (reparsed.start >= 0 && reparsed.lines.slice(reparsed.start + 1, reparsed.end).every(line => !line.trim())) {
      reparsed.lines.splice(reparsed.start, reparsed.end - reparsed.start);
      while (reparsed.lines.length && !reparsed.lines.at(-1).trim()) reparsed.lines.pop();
      return render(reparsed);
    }
  }
  return render(state);
}
