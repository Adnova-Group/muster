// Codex subagent thread-limit floor enforcement (backlog item
// `codex-thread-limits-enforcement`). Re-opened by
// docs/decisions/retriage-install-items.md: nothing in mainline wrote
// [agents] max_threads/max_depth at install time -- the module that would
// have done it (ensureCodexThreadLimits/restoreCodexThreadLimits) was
// dropped on a never-merged burn branch (f2da066). This is a fresh
// implementation reusing that commit's pure text-editor shape (a scoped
// line-based [agents]-table editor, not a full TOML parser -- the only
// keys this ever touches are max_threads/max_depth, so a general parser is
// unwarranted complexity) but wired fresh against the CURRENT
// install-time-generation architecture: no globalHomes/WSL-dual-home
// discovery (out of scope per the retriage's narrowing), a single
// shared-CODEX_HOME target used identically regardless of install scope,
// and a remediation string shared verbatim between install-time failure
// and doctor's drift check.
import { join } from "node:path";

export const REQUIRED_CODEX_THREAD_LIMITS = Object.freeze({ max_threads: 12, max_depth: 2 });

export const CODEX_THREAD_LIMIT_REMEDIATION =
  "Set [agents] max_threads >= 12 and max_depth >= 2 in Codex's config.toml, then rerun muster install codex.";

export const codexThreadLimitConfigPath = codexHomeDir => join(codexHomeDir, "config.toml");
export const codexThreadLimitManifestPath = codexHomeDir => join(codexHomeDir, "muster", "thread-limits.json");

export function codexThreadLimitsMeetFloor(limits) {
  return Object.entries(REQUIRED_CODEX_THREAD_LIMITS)
    .every(([key, minimum]) => Number.isInteger(limits?.[key]) && limits[key] >= minimum);
}

// Scoped [agents]-table editor: locates the FIRST top-level `[agents]`
// section (TOML sections are unambiguous top-level headers; muster never
// needs to reason about any other table), and within it recognizes only
// `max_threads`/`max_depth` as plain non-negative integer assignments
// (optionally trailing an inline comment, which is preserved verbatim on
// raise). Any other line, section, or key in the file is passed through
// byte-for-byte. A malformed existing max_threads/max_depth (non-integer,
// or a duplicate key) throws rather than silently accepting or mangling it
// -- this IS the "strict validation" gate clause (2) of the item requires.
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
    for (const key of Object.keys(REQUIRED_CODEX_THREAD_LIMITS)) {
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

// Read-only status (for doctor's drift check): current [agents] values,
// `null` for an absent key. Throws the same strict-validation errors as
// ensureCodexThreadLimits on malformed input -- a drifted config that is
// also malformed is still a floor violation, not a silent pass.
export function readCodexThreadLimits(text) {
  const state = parseAgentsSection(text);
  const result = {};
  for (const key of Object.keys(REQUIRED_CODEX_THREAD_LIMITS)) result[key] = state.values[key]?.value ?? null;
  return result;
}

// Raise-not-lower: an absent key is created at the floor; a lower existing
// value is raised to the floor (preserving its trailing comment); a higher
// existing value is left untouched (byte-identical output when the whole
// file already meets the floor). Returns enough of a record
// (`before`/`installed`/`sectionCreated`) for restoreCodexThreadLimits to
// undo exactly muster's own change and nothing else.
export function ensureCodexThreadLimits(text) {
  const state = parseAgentsSection(text), before = {}, installed = {}, sectionCreated = state.start < 0;
  for (const key of Object.keys(REQUIRED_CODEX_THREAD_LIMITS)) before[key] = state.values[key]?.value ?? null;
  if (sectionCreated) {
    if (state.lines.length && state.lines.at(-1).trim()) state.lines.push("");
    state.start = state.lines.length;
    state.lines.push("[agents]");
    state.end = state.lines.length;
  }
  let insertion = state.end;
  for (const [key, minimum] of Object.entries(REQUIRED_CODEX_THREAD_LIMITS)) {
    const current = state.values[key];
    installed[key] = Math.max(current?.value ?? 0, minimum);
    if (current) {
      if (current.value < minimum) state.lines[current.index] = `${current.prefix}${minimum}${current.suffix}`;
    } else {
      state.lines.splice(insertion++, 0, `${key} = ${minimum}`);
    }
  }
  return { text: render(state), before, installed, sectionCreated };
}

// Restores exactly the Muster-owned change recorded by ensureCodexThreadLimits:
// a key is only touched if its CURRENT value still equals what Muster
// installed (a user who raised it further after install keeps their own
// value, untouched); restoring to `null` (a key Muster created from
// nothing) removes the line entirely, and an empty section Muster itself
// created is removed too.
export function restoreCodexThreadLimits(text, record) {
  const state = parseAgentsSection(text);
  for (const key of Object.keys(REQUIRED_CODEX_THREAD_LIMITS)) {
    const current = state.values[key];
    if (!current || current.value !== record.installed[key]) continue;
    if (record.before[key] === null) {
      state.lines.splice(current.index, 1);
      for (const value of Object.values(state.values)) if (value.index > current.index) value.index--;
    } else {
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
