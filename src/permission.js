// src/permission.js — permission helpers exposed to the muster allow CLI.
//
// The canonical implementations live in plugin/hooks/permission-policy.js (the
// harness-agnostic pure core, wave 1). This module re-exports only what the CLI
// needs so the plugin hook never imports from src/ (that would invert the
// dependency direction and break the plugin's self-containment).
//
// Boundary summary:
//   plugin/hooks/permission-policy.js  — ONE canonical implementation (pure, no src/ imports)
//   plugin/hooks/pre-tool-use.js       — CC adapter (imports plugin/ only)
//   src/permission.js                  — re-exports for the CLI (imports plugin/hooks/)
//   src/cli.js                         — imports from src/permission.js
//
// No duplication: the three functions below delegate entirely to the canonical module.

export { permissionKey, addKey, readStore } from "../plugin/hooks/permission-policy.js";
