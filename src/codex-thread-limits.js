import { join } from "node:path";

export const DEFAULT_CODEX_THREAD_LIMITS = Object.freeze({
  max_concurrent_threads_per_session: 12,
});

// Compatibility export for callers that use this object as the managed-key
// schema. This is a default, not a floor: a positive user ceiling always wins.
export const REQUIRED_CODEX_THREAD_LIMITS = DEFAULT_CODEX_THREAD_LIMITS;

export const CODEX_THREAD_LIMIT_REMEDIATION =
  "Set [agents] max_concurrent_threads_per_session to a positive integer in Codex's config.toml, then rerun muster install codex.";

export const codexThreadLimitConfigPath = codexHomeDir => join(codexHomeDir, "config.toml");
export const codexThreadLimitManifestPath = codexHomeDir => join(codexHomeDir, "muster", "thread-limits.json");

const CANONICAL_KEY = "max_concurrent_threads_per_session";
const LEGACY_KEYS = Object.freeze(["max_threads", "max_depth"]);
const PARSED_KEYS = Object.freeze([CANONICAL_KEY, ...LEGACY_KEYS]);
const TOML_BASIC_KEY = String.raw`"(?:[^"\\]|\\(?:["\\btnfr]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}))*"`;
const TOML_LITERAL_KEY = String.raw`'[^']*'`;
const TOML_BARE_KEY = String.raw`[A-Za-z0-9_-]+`;
const TOML_KEY_TOKEN = `(?:${TOML_BASIC_KEY}|${TOML_LITERAL_KEY}|${TOML_BARE_KEY})`;
const INTEGER_TOKEN = "(?:\\+?\\d(?:_?\\d)*|0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*)";
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function decodeTomlKey(raw) {
  if (raw.startsWith("'")) return raw.slice(1, -1);
  if (!raw.startsWith('"')) return raw;
  return raw.slice(1, -1).replace(
    /\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g,
    (_, escape) => {
      if (escape[0] === "u" || escape[0] === "U") return String.fromCodePoint(Number.parseInt(escape.slice(1), 16));
      return { '"': '"', "\\": "\\", b: "\b", t: "\t", n: "\n", f: "\f", r: "\r" }[escape];
    },
  );
}

const integerValue = raw => {
  const normalized = raw.replaceAll("_", "");
  const exact = BigInt(normalized);
  return exact <= MAX_SAFE_BIGINT ? Number(exact) : exact.toString();
};
const integerBigInt = value => typeof value === "string" && /^\d+$/.test(value)
  ? BigInt(value)
  : Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
const positiveInteger = value => {
  const exact = integerBigInt(value);
  return exact !== null && exact > 0n;
};
const sameInteger = (left, right) => {
  const leftExact = integerBigInt(left);
  const rightExact = integerBigInt(right);
  return leftExact !== null && rightExact !== null && leftExact === rightExact;
};

function parseAgentsSection(text) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const finalNewline = text.endsWith("\n");
  const lines = text ? text.split(/\r?\n/) : [];
  if (finalNewline) lines.pop();
  let start = -1;
  let end = lines.length;
  let firstSection = lines.length;
  for (let index = 0; index < lines.length; index++) {
    const section = lines[index].match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (!section) continue;
    firstSection = Math.min(firstSection, index);
    if (start >= 0) {
      end = index;
      break;
    }
    const headerKey = section[1].trim();
    if (new RegExp(`^${TOML_KEY_TOKEN}$`).test(headerKey) && decodeTomlKey(headerKey) === "agents") start = index;
  }
  const values = {};
  let dottedEnd = -1;
  let inlineAgents = false;
  const record = (key, raw, index, prefix, suffix, { inline = false } = {}) => {
    if (Object.hasOwn(values, key)) throw new Error(`Codex config.toml has a duplicate [agents] ${key} key`);
    values[key] = {
      value: integerValue(raw),
      index,
      prefix,
      suffix,
      inline,
    };
  };
  for (let index = 0; index < firstSection; index++) {
    const inline = lines[index].match(new RegExp(`^\\s*(${TOML_KEY_TOKEN})\\s*=\\s*\\{(.*)\\}\\s*(?:#.*)?$`));
    if (inline && decodeTomlKey(inline[1]) !== "agents") continue;
    if (inline) {
      inlineAgents = true;
      const validKeys = new Set();
      for (const match of inline[2].matchAll(
        new RegExp(`(?:^|,)\\s*((${TOML_KEY_TOKEN})\\s*=\\s*)(${INTEGER_TOKEN})(\\s*)(?=,|$)`, "g"),
      )) {
        const key = decodeTomlKey(match[2]);
        if (!PARSED_KEYS.includes(key)) continue;
        record(key, match[3], index, match[1], match[4], { inline: true });
        validKeys.add(key);
      }
      for (const match of inline[2].matchAll(new RegExp(`(?:^|,)\\s*(${TOML_KEY_TOKEN})\\s*=`, "g"))) {
        const key = decodeTomlKey(match[1]);
        if (PARSED_KEYS.includes(key) && !validKeys.has(key)) {
          throw new Error(`Codex config.toml [agents] ${key} must be a non-negative integer`);
        }
      }
      continue;
    }
    const dotted = lines[index].match(
      new RegExp(`^(\\s*(${TOML_KEY_TOKEN})\\s*\\.\\s*(${TOML_KEY_TOKEN})\\s*=\\s*)(${INTEGER_TOKEN})(\\s*(?:#.*)?)$`),
    );
    const dottedAssignment = lines[index].match(
      new RegExp(`^\\s*(${TOML_KEY_TOKEN})\\s*\\.\\s*(${TOML_KEY_TOKEN})\\s*=`),
    );
    if (dotted && decodeTomlKey(dotted[2]) === "agents") {
      const key = decodeTomlKey(dotted[3]);
      if (PARSED_KEYS.includes(key)) {
        record(key, dotted[4], index, dotted[1], dotted[5]);
        dottedEnd = Math.max(dottedEnd, index + 1);
      }
    } else if (dottedAssignment && decodeTomlKey(dottedAssignment[1]) === "agents") {
      const key = decodeTomlKey(dottedAssignment[2]);
      if (PARSED_KEYS.includes(key)) {
        throw new Error(`Codex config.toml [agents] ${key} must be a non-negative integer`);
      }
    }
  }
  if (start >= 0) {
    for (let index = start + 1; index < end; index++) {
      const candidate = lines[index].match(
        new RegExp(`^(\\s*(${TOML_KEY_TOKEN})\\s*=\\s*)(${INTEGER_TOKEN})(\\s*(?:#.*)?)$`),
      );
      const assignment = lines[index].match(new RegExp(`^\\s*(${TOML_KEY_TOKEN})\\s*=`));
      if (candidate) {
        const key = decodeTomlKey(candidate[2]);
        if (PARSED_KEYS.includes(key)) record(key, candidate[3], index, candidate[1], candidate[4]);
      } else if (assignment) {
        const key = decodeTomlKey(assignment[1]);
        if (PARSED_KEYS.includes(key)) {
          throw new Error(`Codex config.toml [agents] ${key} must be a non-negative integer`);
        }
      }
    }
  }
  return { lines, newline, finalNewline, start, end, dottedEnd, inlineAgents, values };
}

const render = state => state.lines.join(state.newline) + (state.finalNewline || state.lines.length ? state.newline : "");

export function readCodexThreadLimits(text) {
  const state = parseAgentsSection(text);
  return { [CANONICAL_KEY]: state.values[CANONICAL_KEY]?.value ?? null };
}

export function codexThreadLimitsMeetFloor(limits) {
  return positiveInteger(limits?.[CANONICAL_KEY]);
}

export function resolveCodexThreadCeiling(text) {
  const state = parseAgentsSection(text);
  const value = state.values[CANONICAL_KEY]?.value
    ?? state.values.max_threads?.value
    ?? DEFAULT_CODEX_THREAD_LIMITS[CANONICAL_KEY];
  if (!positiveInteger(value)) {
    throw new Error(`Codex config.toml [agents] ${CANONICAL_KEY} must be a positive integer`);
  }
  return value;
}

// Add the canonical key only. An existing canonical value is byte-preserved.
// Otherwise an unowned legacy ceiling is copied without deleting or raising it.
export function ensureCodexThreadLimits(text) {
  const state = parseAgentsSection(text);
  const sectionCreated = state.start < 0 && state.dottedEnd < 0 && !state.inlineAgents;
  const existing = state.values[CANONICAL_KEY];
  const installedValue = existing?.value
    ?? state.values.max_threads?.value
    ?? DEFAULT_CODEX_THREAD_LIMITS[CANONICAL_KEY];
  if (!positiveInteger(installedValue)) {
    throw new Error(`Codex config.toml [agents] ${CANONICAL_KEY} must be a positive integer`);
  }
  if (!existing && state.inlineAgents) {
    throw new Error(`Codex config.toml uses an inline [agents] table without ${CANONICAL_KEY}; convert it to a standard [agents] table before installation`);
  }
  if (sectionCreated) {
    if (state.lines.every(line => !line.trim())) state.lines.length = 0;
    if (state.lines.length && state.lines.at(-1).trim()) state.lines.push("");
    state.start = state.lines.length;
    state.lines.push("[agents]");
    state.end = state.lines.length;
  }
  if (!existing) {
    if (state.start >= 0) {
      state.lines.splice(state.end, 0, `${CANONICAL_KEY} = ${installedValue}`);
    } else if (state.dottedEnd >= 0) {
      state.lines.splice(
        state.dottedEnd,
        0,
        `agents.${CANONICAL_KEY} = ${installedValue}`,
      );
    } else {
      state.lines.splice(state.end, 0, `${CANONICAL_KEY} = ${installedValue}`);
    }
  }
  return {
    text: render(state),
    before: { [CANONICAL_KEY]: existing?.value ?? null },
    installed: { [CANONICAL_KEY]: installedValue },
    sectionCreated,
  };
}

// Restore current or legacy receipt keys only while their live values still
// equal the exact values Muster recorded. Any later user edit is authoritative.
export function restoreCodexThreadLimits(text, record) {
  const state = parseAgentsSection(text);
  const keys = Object.keys(record?.installed || {}).filter(key => PARSED_KEYS.includes(key));
  for (const key of keys) {
    const current = state.values[key];
    if (!current || !sameInteger(current.value, record.installed[key])) continue;
    if (current.inline || sameInteger(record.before?.[key], record.installed[key])) continue;
    if (record.before?.[key] === null) {
      state.lines.splice(current.index, 1);
      delete state.values[key];
      for (const value of Object.values(state.values)) {
        if (value.index > current.index) value.index--;
      }
    } else if (integerBigInt(record.before?.[key]) !== null) {
      state.lines[current.index] = `${current.prefix}${record.before[key]}${current.suffix}`;
    }
  }
  if (record?.sectionCreated) {
    const reparsed = parseAgentsSection(render(state));
    if (reparsed.start >= 0 && reparsed.lines.slice(reparsed.start + 1, reparsed.end).every(line => !line.trim())) {
      reparsed.lines.splice(reparsed.start, reparsed.end - reparsed.start);
      while (reparsed.lines.length && !reparsed.lines.at(-1).trim()) reparsed.lines.pop();
      return render(reparsed);
    }
  }
  return render(state);
}
