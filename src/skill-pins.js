// Project skill pins: `.muster/config` (JSON) lists skills the planner must always bind.
//
//   { "version": 1, "skills": { "pins": [ { "id": "sp-tdd" }, { "id": "impeccable-core", "role": "frontend" } ] } }
//
// A pin without a role binds to every task; a pin with a role binds to the tasks whose
// agent_hint or bound skills carry that catalog role. `muster skills pin|unpin` edits the file;
// preflight lists pins first among its skill candidates and in the planner brief, and build-args
// adds each pinned skill to every matching task, so the binding holds even when the planner
// leaves it out. Synchronous and offline: preflight and build-args call it on every run.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROLES } from "./roles.js";

export const CONFIG_REL = join(".muster", "config");
export const ENABLED_MANIFEST_REL = join(".claude", "skills", ".muster-enabled.json");
export const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ROLE_SET = new Set(ROLES);

// The parsed config, {} when absent. A file that is not a JSON object throws: silently
// ignoring a broken config would drop the user's pins without a word.
export function readProjectConfig(cwd) {
  const path = join(cwd, CONFIG_REL);
  if (!existsSync(path)) return {};
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch (e) {
    throw new Error(`${CONFIG_REL} is not valid JSON (${e.message}); see website/reference/configuration.md`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${CONFIG_REL} must be a JSON object`);
  return value;
}

export const validPin = (p) => !!p && typeof p === "object" && SKILL_ID_RE.test(String(p.id || "")) && (p.role === undefined || ROLE_SET.has(p.role));

// [{id, role?}] in file order; malformed entries are dropped.
export function readPins(cwd) {
  const pins = readProjectConfig(cwd).skills?.pins;
  if (!Array.isArray(pins)) return [];
  const seen = new Set();
  const out = [];
  for (const p of pins) {
    if (!validPin(p) || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p.role ? { id: p.id, role: p.role } : { id: p.id });
  }
  return out;
}

export function readEnabledManifest(cwd) {
  const path = join(cwd, ENABLED_MANIFEST_REL);
  if (!existsSync(path)) return { version: 1, skills: {} };
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value && typeof value === "object" && value.skills && typeof value.skills === "object") return value;
  } catch { /* fall through */ }
  throw new Error(`${ENABLED_MANIFEST_REL} is not a muster manifest; fix or remove it by hand`);
}

// Pins resolved to SKILL.md paths: a builtin resolves to the plugin copy, a skill that
// `muster skills add` installed resolves to the project's .claude/skills/<id>/SKILL.md.
// Returns { pins: [{id, role?, path}], warnings }.
export function resolvePins(cwd, catalog) {
  const pins = [];
  const warnings = [];
  let manifest = { skills: {} };
  try { manifest = readEnabledManifest(cwd); } catch (e) { warnings.push(e.message); }
  for (const p of readPins(cwd)) {
    const builtin = catalog.skills.get(p.id);
    const projectPath = join(cwd, ".claude", "skills", p.id, "SKILL.md");
    if (builtin) pins.push({ ...p, path: builtin.path });
    else if (manifest.skills[p.id] && existsSync(projectPath)) pins.push({ ...p, path: projectPath });
    else warnings.push(`pinned skill ${p.id} is neither a builtin nor a skill muster installed in .claude/skills/; run muster skills unpin ${p.id}`);
  }
  return { pins, warnings };
}

// The catalog roles a planned task carries: its agent_hint's roles plus its bound skills' roles.
export function taskRoles(task, catalog) {
  const roles = new Set(catalog.agents.get(task.agentHint)?.roles || []);
  for (const id of task.skills || []) for (const r of catalog.skills.get(id)?.roles || []) roles.add(r);
  return roles;
}

export const pinApplies = (pin, roles) => !pin.role || roles.has(pin.role);
