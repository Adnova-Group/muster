// Loader + minimal validator for plugin/skills/review-gate/verdict.schema.json --
// the single-sourced shape of .muster/verdicts.json (backlog item
// structured-output-binding). Muster hand-rolls schema validation elsewhere
// (src/manifest.js validates the Crew Manifest shape without an external
// dependency) rather than taking on a JSON Schema library; this module is the
// same discipline, scoped to the exact subset of JSON Schema
// verdict.schema.json actually uses: type, enum, properties/required/
// additionalProperties, items, oneOf. It is NOT a general JSON Schema
// implementation -- an unlisted keyword (e.g. $ref, allOf, pattern) is silently
// ignored, so extend validateNode deliberately if the schema ever grows one.
import { readFile } from "node:fs/promises";
import { dirFromImportMeta } from "./fs-util.js";

// One exported path constant so every caller (this module, tests, a future
// CLI wire) resolves the SAME schema file rather than re-deriving the
// relative path by hand.
export const VERDICT_SCHEMA_PATH = dirFromImportMeta(
  import.meta.url,
  "../plugin/skills/review-gate/verdict.schema.json"
);

export async function loadVerdictSchema() {
  return JSON.parse(await readFile(VERDICT_SCHEMA_PATH, "utf8"));
}

// JSON Schema's own type vocabulary distinguishes "object", "array", and
// "null" from JS's bare typeof -- normalize once so every `type` check below
// compares against the same vocabulary the schema file writes.
function schemaTypeOf(data) {
  if (data === null) return "null";
  if (Array.isArray(data)) return "array";
  return typeof data; // "object" | "string" | "number" | "boolean" | "undefined"
}

function validateNode(schema, data, path, errors) {
  if (schema.oneOf) {
    const matchCount = schema.oneOf.filter((sub) => {
      const subErrors = [];
      validateNode(sub, data, path, subErrors);
      return subErrors.length === 0;
    }).length;
    if (matchCount !== 1) {
      errors.push(`${path}: must match exactly one oneOf branch, matched ${matchCount}`);
    }
    return;
  }
  if (schema.enum) {
    if (!schema.enum.includes(data)) {
      errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(data)}`);
    }
    return;
  }
  if (schema.type) {
    const actual = schemaTypeOf(data);
    if (actual !== schema.type) {
      errors.push(`${path}: must be type "${schema.type}", got "${actual}"`);
      return; // a type mismatch makes property/item checks below meaningless
    }
  }
  if (schema.type === "object") {
    const properties = schema.properties || {};
    for (const key of schema.required || []) {
      if (!(key in data)) errors.push(`${path}: missing required property "${key}"`);
    }
    for (const key of Object.keys(data)) {
      if (properties[key]) {
        validateNode(properties[key], data[key], `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: unexpected property "${key}"`);
      }
    }
  }
  if (schema.type === "array" && schema.items) {
    data.forEach((item, i) => validateNode(schema.items, item, `${path}[${i}]`, errors));
  }
}

// Returns { ok, errors } -- the same shape src/manifest.js's validateManifest
// returns, so callers already familiar with that convention need nothing new.
export function validateAgainstSchema(schema, data) {
  const errors = [];
  validateNode(schema, data, "$", errors);
  return { ok: errors.length === 0, errors };
}

// Convenience: load the real bundled schema and validate against it in one call.
export async function validateVerdicts(verdicts) {
  const schema = await loadVerdictSchema();
  return validateAgainstSchema(schema, verdicts);
}
