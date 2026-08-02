import { codexSpawnAgentCall, CODEX_MULTI_AGENT_VERSIONS } from "./wave-dispatch.js";
import { codexProfileForAgentId } from "./codex.js";
import { readCodexMultiAgentVersion } from "./codex-inventory.js";

const KNOWN_APIS = new Set(Object.values(CODEX_MULTI_AGENT_VERSIONS));

function normalizedApis(callableApis) {
  if (!Array.isArray(callableApis)) {
    throw new Error("selectCodexAuditProvider: callableApis must be an array of active-session API versions");
  }
  const result = [];
  for (const api of callableApis) {
    if (!KNOWN_APIS.has(api)) throw new Error(`selectCodexAuditProvider: unknown callable API ${JSON.stringify(api)}`);
    if (!result.includes(api)) result.push(api);
  }
  return result;
}

function normalizedCandidate(candidate, index) {
  if (!candidate || typeof candidate !== "object") {
    throw new Error(`selectCodexAuditProvider: candidate ${index} must be an object`);
  }
  if (typeof candidate.id !== "string" || !candidate.id) {
    throw new Error(`selectCodexAuditProvider: candidate ${index} id is required`);
  }
  if (candidate.kind !== "agent") {
    throw new Error(`selectCodexAuditProvider: candidate ${JSON.stringify(candidate.id)} must be an independent agent provider`);
  }
  if (candidate.apiVersion !== null && !KNOWN_APIS.has(candidate.apiVersion)) {
    throw new Error(`selectCodexAuditProvider: candidate ${JSON.stringify(candidate.id)} apiVersion must be "v1", "v2", or null when the current catalog has no safe answer`);
  }
  if (typeof candidate.available !== "boolean") {
    throw new Error(`selectCodexAuditProvider: candidate ${JSON.stringify(candidate.id)} availability must be explicit`);
  }
  return { ...candidate };
}

const PROFILE_PRECEDENCE = Object.freeze({ plugin: 1, user: 2, project: 3 });

function effectiveAgentProfile(id, inventory, manifestProfile) {
  const records = Array.isArray(inventory?.agentProfiles)
    ? inventory.agentProfiles.filter(record => record?.name === id)
    : [];
  if (!records.length) {
    return manifestProfile?.model
      ? { status: "manifest", scope: "manifest", path: null, model: manifestProfile.model }
      : { status: "unresolved", scope: null, path: null, model: null };
  }
  const highest = Math.max(...records.map(record => PROFILE_PRECEDENCE[record.scope] || 0));
  const winners = records.filter(record => (PROFILE_PRECEDENCE[record.scope] || 0) === highest);
  if (highest === 0 || winners.length !== 1) {
    return {
      status: "shadowed",
      scope: null,
      path: null,
      model: null,
      contenders: winners.map(({ scope, path, plugin, status, model }) => ({
        scope,
        path: path || null,
        plugin: plugin || null,
        status,
        model: model || null,
      })),
    };
  }
  const winner = winners[0];
  if (winner.status !== "resolved" || typeof winner.model !== "string" || !winner.model) {
    return { status: "unresolved", scope: winner.scope, path: winner.path || null, model: null };
  }
  return {
    status: "resolved",
    scope: winner.scope,
    path: winner.path || null,
    plugin: winner.plugin || null,
    model: winner.model,
  };
}

// Enrichs the role's full manifest-ordered chain from authoritative runtime
// inputs. Callers do not hand-author candidate metadata: availability comes
// from the live agent inventory, while each profile's model is resolved through
// the current Codex model catalog. Unknown versions remain null and are never
// eligible for packet construction.
export async function deriveCodexAuditCandidates(roleEntry, inventory, {
  profileForAgent = codexProfileForAgentId,
  versionForModel = readCodexMultiAgentVersion,
} = {}) {
  if (!Array.isArray(roleEntry?.chain)) throw new Error("deriveCodexAuditCandidates: role chain is required");
  const available = new Set(Array.isArray(inventory?.agents) ? inventory.agents : []);
  const agents = roleEntry.chain.filter(candidate => candidate?.kind === "agent");
  return Promise.all(agents.map(async candidate => {
    const profile = effectiveAgentProfile(candidate.id, inventory, profileForAgent(candidate.id));
    const apiVersion = typeof profile.model === "string"
      ? await versionForModel(profile.model)
      : null;
    return {
      id: candidate.id,
      source: candidate.source,
      kind: "agent",
      apiVersion,
      available: available.has(candidate.id) && apiVersion !== null &&
        (profile.status === "resolved" || profile.status === "manifest"),
      profile,
    };
  }));
}

// Selects an audit worker from the manifest-ordered provider chain, but only
// after intersecting each provider's model-resolved API with the tool namespace
// callable in THIS active session. Packet construction happens after that
// compatibility check, so an incompatible preference can never leak a wrong
// v1/v2 payload onto the wire. Inline is a last resort with a stable receipt.
export function selectCodexAuditProvider({ role, taskId, message, callableApis, candidates } = {}) {
  if (typeof role !== "string" || !role) throw new Error("selectCodexAuditProvider: role is required");
  if (!Array.isArray(candidates)) throw new Error("selectCodexAuditProvider: candidates must be an array");

  const apis = normalizedApis(callableApis);
  const chain = candidates.map(normalizedCandidate);
  const compatible = chain.find(candidate => candidate.available && apis.includes(candidate.apiVersion));

  if (compatible) {
    const provider = {
      id: compatible.id,
      source: compatible.source,
      kind: compatible.kind,
      apiVersion: compatible.apiVersion,
      profile: compatible.profile || null,
    };
    return {
      mode: "independent",
      provider,
      packet: codexSpawnAgentCall({
        taskId,
        message,
        agentType: compatible.id,
        version: compatible.apiVersion,
      }),
      degradation: null,
    };
  }

  return {
    mode: "inline",
    provider: { id: "inline", source: "inline", kind: "inline" },
    packet: null,
    degradation: {
      code: "CODEX_AUDIT_NO_COMPATIBLE_PROVIDER",
      role,
      callableApis: apis,
      considered: chain.map(candidate => ({
        id: candidate.id,
        apiVersion: candidate.apiVersion,
        available: candidate.available,
        profile: candidate.profile || null,
      })),
    },
  };
}
