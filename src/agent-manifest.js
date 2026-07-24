import { readFileSync } from "node:fs";

// The single, harness-neutral agent manifest, read once and cached.
//
// Shape: { format, description, agents: { <id>: { tier, effort?, readOnly?,
// source } } }. Each entry names a CONCEPTUAL tier + an optional SEMANTIC effort
// and NO concrete harness model, so every adapter (Codex, Kimi, ...) resolves the
// SAME file through its own policy (codexProfileForConfig / kimiProfileForConfig).
// That is the payoff of the neutral-shape migration: one manifest, every harness.
//
// It lives at catalog/ -- a shared, packaged data dir -- NOT under codex/: the
// manifest is not Codex-owned. Read via fs (not a JSON module import) to stay off
// Node's experimental-JSON-modules warning on the Node 20/22 CI lane. build-codex
// stages catalog/ wholesale into the plugin, so `../catalog/agents.manifest.json`
// resolves in both the source tree and the built plugin/runtime/. Lazy so
// importing an adapter for pure tier math never touches the filesystem.
let cache;
export function readAgentManifest() {
  if (!cache) {
    const raw = readFileSync(new URL("../catalog/agents.manifest.json", import.meta.url), "utf8");
    cache = Object.freeze(JSON.parse(raw));
  }
  return cache;
}

// The frozen { <id>: config } agent map -- what the adapters resolve per agent id
// (== the `capabilities --codex`/`--kimi` chosen.id for an agent provider).
export function agentProfiles() {
  return readAgentManifest().agents;
}
