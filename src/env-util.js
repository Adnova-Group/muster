// env-util.js — shared environment-variable helpers.
//
// Pure functions, no I/O side effects. Deterministic, no external dependencies.

/**
 * Returns true when x is a non-null, non-array plain object.
 * Extracted from the common guard !x||typeof x!=="object"||Array.isArray(x)
 * used across advisor.js and fusion.js validators; centralised here so both
 * files import the same canonical form.
 */
export function isPlainObject(x) {
  return x !== null && x !== undefined && typeof x === "object" && !Array.isArray(x);
}

/**
 * Permissive opt-in flag parse: TRUE for any set value except "0" and (case-
 * insensitive) "false". Extracted from the identical expression duplicated at
 * src/cli.js (MUSTER_COWORK_NATIVE_PLUGIN) and src/model.js (MUSTER_ENABLE_APEX
 * / MUSTER_ENABLE_FABLE), both of which exist to be MCPB-boolean-safe: MCPB
 * substitutes boolean user_config as the STRING "false"/"true", so a bare
 * truthiness check would read "false" as on.
 *
 * Deliberately NOT the strict form used for capability declarations
 * (src/wave-dispatch.js's truthyEnv, which accepts only normalized "1"/"true"
 * and fails closed on everything else) -- these are opt-ins, where any set
 * value that is not an explicit denial means "the operator asked for it".
 */
export function isTruthyFlag(v) {
  return !!v && v !== "0" && String(v).toLowerCase() !== "false";
}

/**
 * Read an integer from an environment variable.
 *
 * Rules (in order):
 *   1. If the variable is absent (undefined) or empty-string -> return def.
 *   2. Trim the value; accept ONLY a base-10 integer string (matches /^-?\d+$/).
 *      "3foo", "2.9", "abc", "3.0" -> return def (tightened vs parseInt truncation).
 *   3. Parse with parseInt (base 10); if result < min -> return def.
 *   4. Otherwise return the parsed integer.
 *
 * @param {string} name                    - Environment variable name.
 * @param {{ min?: number, def: number }} opts
 *   min - inclusive lower bound (default 0); values below it return def.
 *   def - fallback when the value is absent, malformed, or out of range.
 * @param {object} [env]                   - env map; defaults to process.env (injectable for tests).
 * @returns {number}
 */
export function envInt(name, { min = 0, def }, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return def;
  const n = parseInt(trimmed, 10);
  if (n < min) return def;
  return n;
}
