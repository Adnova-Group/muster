import { join, resolve } from "node:path";

export const REQUIRED_CODEX_THREAD_LIMITS = Object.freeze({ max_threads: 12, max_depth: 2 });

export function discoverCodexGlobalHomes({ cwd, home, codexHome, globalHomes } = {}) {
  const candidates = globalHomes?.length ? globalHomes : [codexHome || join(home, ".codex")];
  const wsl = String(cwd || "").replaceAll("\\", "/").match(/^\/mnt\/([a-z])\/Users\/([^/]+)(?:\/|$)/i);
  if (!globalHomes?.length && wsl) candidates.push(`/mnt/${wsl[1].toLowerCase()}/Users/${wsl[2]}/.codex`);
  const seen = new Set(), result = [];
  for (const candidate of candidates) {
    const path = resolve(candidate), key = /^\/mnt\/[a-z]\//i.test(path) ? path.toLowerCase() : path;
    if (!seen.has(key)) { seen.add(key); result.push(path); }
  }
  return result;
}

function parse(text) {
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
        if (Object.hasOwn(values, key)) throw new Error(`duplicate agents.${key}`);
        values[key] = { value: Number(candidate[2]), index, prefix: candidate[1], suffix: candidate[3] };
      } else if (new RegExp(`^\\s*${key}\\s*=`).test(lines[index])) {
        throw new Error(`agents.${key} must be a non-negative integer`);
      }
    }
  }
  return { lines, newline, finalNewline, start, end, values };
}

const render = state => state.lines.join(state.newline) + (state.finalNewline || state.lines.length ? state.newline : "");

export function ensureCodexThreadLimits(text) {
  const state = parse(text), before = {}, installed = {}, sectionCreated = state.start < 0;
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

export function restoreCodexThreadLimits(text, record) {
  const state = parse(text);
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
    const reparsed = parse(render(state));
    if (reparsed.start >= 0 && reparsed.lines.slice(reparsed.start + 1, reparsed.end).every(line => !line.trim())) {
      reparsed.lines.splice(reparsed.start, reparsed.end - reparsed.start);
      while (reparsed.lines.length && !reparsed.lines.at(-1).trim()) reparsed.lines.pop();
      return render(reparsed);
    }
  }
  return render(state);
}

export const threadLimitManifestPath = globalHome => join(globalHome, "muster", "thread-limits.json");
