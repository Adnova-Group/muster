import { discoverOrcaContext } from "./orca-context-adapter.js";

// This module intentionally does not launch an agent, send a prompt, inspect a
// provider's private files, or write a probe marker.  Orca owns the terminal and
// session lifecycle; the only live observation here is the public, read-only
// context adapter.  Provider entries below are bounded evidence profiles.  A
// profile is not proof that the currently selected build loaded every surface.

export const ORCA_AGENT_CAPABILITY_SCHEMA_VERSION = 1;
export const UNKNOWN = "UNKNOWN";
export const CAPABILITY_STATUSES = Object.freeze(["SUPPORTED", "UNSUPPORTED", UNKNOWN]);
export const CAPABILITY_SURFACES = Object.freeze([
  "working-directory",
  "skills",
  "mcp",
  "hooks",
  "transcript",
  "resume",
]);

const MAX_TEXT = 240;

const status = (value, evidence) => Object.freeze({
  status: value,
  evidence: evidence ?? "unverified",
});

// These are the six provider profiles for which this repository has a stable
// public evidence boundary.  `UNKNOWN` is deliberate where Orca cannot verify
// the selected provider's current build/session behavior.  Do not turn an
// UNKNOWN into SUPPORTED because another provider happens to expose the same
// feature.
const PROFILE_DATA = {
  "claude-code": {
    provider: "claude-code",
    evidence: "docs/research/claude-code-cli.md",
    capabilities: {
      "working-directory": status("SUPPORTED", "orca terminal launches the provider in the selected worktree"),
      skills: status("SUPPORTED", "Claude Code SKILL.md locations"),
      mcp: status("SUPPORTED", "Claude Code MCP installation scopes"),
      hooks: status("SUPPORTED", "Claude Code hooks lifecycle"),
      transcript: status("SUPPORTED", "Claude Code JSONL session transcript"),
      resume: status("SUPPORTED", "Claude Code --resume session addressing"),
    },
  },
  codex: {
    provider: "codex",
    evidence: "docs/research/codex-cli.md",
    capabilities: {
      "working-directory": status("SUPPORTED", "orca terminal launches the provider in the selected worktree"),
      skills: status("SUPPORTED", "Codex plugin and skills surfaces"),
      mcp: status("SUPPORTED", "Codex MCP integration"),
      hooks: status("SUPPORTED", "Codex lifecycle hooks"),
      transcript: status("SUPPORTED", "Codex session/rollout event surface"),
      resume: status("SUPPORTED", "Codex thread/session continuation surface"),
    },
  },
  kimi: {
    provider: "kimi",
    evidence: "docs/research/kimi-code-cli.md",
    capabilities: {
      "working-directory": status("SUPPORTED", "orca terminal launches the provider in the selected worktree"),
      skills: status("SUPPORTED", "Kimi SKILL.md convention"),
      mcp: status("SUPPORTED", "Kimi MCP client"),
      hooks: status("SUPPORTED", "Kimi lifecycle hooks"),
      transcript: status("SUPPORTED", "Kimi stream/session receipts"),
      resume: status("SUPPORTED", "Kimi session resume command"),
    },
  },
  hermes: {
    provider: "hermes",
    evidence: "docs/research/hermes.md",
    capabilities: {
      "working-directory": status("SUPPORTED", "orca terminal launches the provider in the selected worktree"),
      skills: status("SUPPORTED", "Hermes agentskills.io-compatible skills"),
      mcp: status("SUPPORTED", "Hermes MCP integration"),
      hooks: status("SUPPORTED", "Hermes lifecycle hooks"),
      transcript: status("SUPPORTED", "Hermes session persistence"),
      // Orca is the authority for resume INSIDE Orca, and it names Hermes as
      // non-resumable: "Cursor CLI, Hermes, Copilot, Trae, and other
      // non-resumable terminals are left running" [Orca docs, Agent
      // hibernation]. Whatever continuation Hermes offers on its own, Orca
      // will not hibernate and resume it.
      resume: status("UNSUPPORTED", "Orca lists Hermes among non-resumable terminals"),
    },
  },
  cowork: {
    provider: "cowork",
    evidence: "docs/research/claude-cowork.md",
    capabilities: {
      "working-directory": status(UNKNOWN, "provider session cwd is not exposed by the Orca adapter"),
      skills: status(UNKNOWN, "native plugin/skill load is unverified"),
      mcp: status(UNKNOWN, "MCP availability depends on the selected Cowork experience"),
      hooks: status(UNKNOWN, "provider hook behavior is not exposed by the Orca adapter"),
      transcript: status(UNKNOWN, "provider transcript addressing is not exposed by the Orca adapter"),
      resume: status(UNKNOWN, "provider resume behavior is not exposed by the Orca adapter"),
    },
  },
  "chatgpt-work": {
    provider: "chatgpt-work",
    evidence: "docs/research/gpt-work.md",
    capabilities: {
      "working-directory": status(UNKNOWN, "Work-mode working-directory inheritance is unverified"),
      skills: status(UNKNOWN, "Work-mode skills/plugin inheritance is unverified"),
      mcp: status(UNKNOWN, "Work-mode MCP inheritance is unverified for Orca-launched sessions"),
      hooks: status(UNKNOWN, "Work-mode hooks are not exposed by the Orca adapter"),
      transcript: status(UNKNOWN, "Work-mode transcript addressing is not exposed by the Orca adapter"),
      resume: status(UNKNOWN, "Work-mode resume behavior is not exposed by the Orca adapter"),
    },
  },
};

function freezeProfile(profile) {
  const capabilities = {};
  for (const surface of CAPABILITY_SURFACES) {
    capabilities[surface] = profile.capabilities[surface];
  }
  return Object.freeze({
    provider: profile.provider,
    evidence: profile.evidence,
    capabilities: Object.freeze(capabilities),
  });
}

export const ORCA_AGENT_CAPABILITY_PROFILES = Object.freeze(
  Object.fromEntries(Object.entries(PROFILE_DATA).map(([id, profile]) => [id, freezeProfile(profile)])),
);
export const ORCA_AGENT_PROVIDERS = Object.freeze(Object.keys(ORCA_AGENT_CAPABILITY_PROFILES));

/**
 * Orca's own hibernation eligibility list, quoted from the docs rather than
 * inferred from a Muster provider profile.
 *
 * Eligible: "Claude, Codex, Gemini, Antigravity, OpenCode, Pi, MiMo Code,
 * Droid, Grok, Devin, or OMP."
 * Not eligible: "Cursor CLI, Hermes, Copilot, Trae, and other non-resumable
 * terminals are left running."
 * [Orca docs, Agent hibernation]
 *
 * This is deliberately separate from CAPABILITY_SURFACES.resume: that surface
 * describes what the provider CLI can do, this one describes what Orca will do
 * with it. Only the latter can explain a disconnected Orca terminal.
 */
export const ORCA_HIBERNATION_ELIGIBLE_PROVIDERS = Object.freeze([
  "claude", "claude-code", "codex", "gemini", "antigravity", "opencode",
  "pi", "mimo-code", "droid", "grok", "devin", "omp",
]);

export const ORCA_HIBERNATION_INELIGIBLE_PROVIDERS = Object.freeze([
  "cursor-cli", "hermes", "copilot", "trae",
]);

/** "eligible" | "not-eligible" | "unknown" -- never guessed from a resume flag. */
export function orcaHibernationEligibility(provider) {
  const key = profileKey(provider);
  if (key === null) return "unknown";
  if (ORCA_HIBERNATION_ELIGIBLE_PROVIDERS.includes(key)) return "eligible";
  if (ORCA_HIBERNATION_INELIGIBLE_PROVIDERS.includes(key)) return "not-eligible";
  return "unknown";
}

/**
 * The value Orca's `--agent` flag expects, per provider.
 *
 * A Muster profile id is not an Orca agent name. The catalog below is Orca's
 * supported-agent list [Orca docs, Supported agents]; membership in it is what
 * makes a provider placeable. `cowork` and `chatgpt-work` are Muster-side
 * providers absent from that catalog, so they map to null and placement refuses
 * them rather than emitting a flag Orca cannot resolve.
 *
 * Being placeable is NOT a capability claim. A provider here with no evidence
 * profile still reports every surface as UNKNOWN; see PLACEABLE_SURFACES below
 * for the one surface Orca itself can vouch for.
 */
export const ORCA_AGENT_NAMES = Object.freeze({
  "claude-code": "claude",
  "claude-agent-teams": "claude-agent-teams",
  codex: "codex",
  kimi: "kimi",
  hermes: "hermes",
  gemini: "gemini",
  grok: "grok",
  copilot: "copilot",
  opencode: "opencode",
  pi: "pi",
  omp: "omp",
  antigravity: "antigravity",
  ante: "ante",
  aider: "aider",
  goose: "goose",
  amp: "amp",
  kilocode: "kilocode",
  kiro: "kiro",
  "charm-crush": "charm-crush",
  auggie: "auggie",
  autohand: "autohand",
  cline: "cline",
  codebuff: "codebuff",
  "command-code": "command-code",
  continue: "continue",
  "cursor-cli": "cursor-cli",
  devin: "devin",
  droid: "droid",
  "mistral-vibe": "mistral-vibe",
  minimax: "minimax",
  "mimo-code": "mimo-code",
  "qwen-code": "qwen-code",
  "rovo-dev": "rovo-dev",
  openclaw: "openclaw",
  trae: "trae",
  cowork: null,
  "chatgpt-work": null,
});

export function orcaAgentName(profile) {
  const key = profileKey(profile);
  return key === null ? null : ORCA_AGENT_NAMES[key] ?? null;
}

/**
 * The one capability Orca itself establishes for any agent it launches: the
 * process starts in the selected worktree. Orca's supported-agent page states
 * the mechanism plainly -- "the agent combobox just launches a process in a
 * terminal" -- and the read-only context adapter independently proves the
 * worktree path. Every other surface stays UNKNOWN without a provider profile.
 */
const PLACEABLE_SURFACES = Object.freeze({
  "working-directory": status("SUPPORTED", "Orca launches the selected agent in the worktree it manages"),
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value, fallback = null) {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return fallback;
  return value.trim().slice(0, MAX_TEXT);
}

function normalizeStatus(value) {
  const candidate = isObject(value) ? value.status : value;
  return CAPABILITY_STATUSES.includes(candidate) ? candidate : UNKNOWN;
}

function normalizeEvidence(value) {
  const candidate = isObject(value) ? value.evidence : null;
  return text(candidate, "unverified");
}

function unknownCapabilities(reason = "no verified provider profile") {
  return Object.fromEntries(CAPABILITY_SURFACES.map((surface) => [surface, {
    status: UNKNOWN,
    evidence: reason,
  }]));
}

function profileKey(value) {
  const raw = text(value, "");
  if (!raw) return null;
  const aliases = {
    "claude": "claude-code",
    "claude-code-cli": "claude-code",
    "codex-cli": "codex",
    "kimi-code": "kimi",
    "chatgpt-work": "chatgpt-work",
    "gpt-work": "chatgpt-work",
  };
  return aliases[raw.toLowerCase()] ?? raw.toLowerCase();
}

function normalizeProfile(key, supplied = null) {
  const known = ORCA_AGENT_CAPABILITY_PROFILES[key];
  const source = isObject(supplied) ? supplied : known;
  if (!source || !isObject(source.capabilities)) {
    // A provider in Orca's catalog with no Muster evidence profile is not a
    // blank: Orca vouches for the working directory. Everything else stays
    // UNKNOWN, which is what keeps this from becoming an inferred-support path.
    const placeable = orcaAgentName(key) !== null;
    return {
      id: key || "unknown",
      provider: key || "unknown",
      evidence: placeable
        ? "Orca supported-agent catalog; no Muster evidence profile"
        : "unverified provider profile",
      capabilities: {
        ...unknownCapabilities(placeable
          ? "no Muster evidence profile for this Orca agent"
          : "unverified provider profile"),
        ...(placeable ? PLACEABLE_SURFACES : {}),
      },
    };
  }
  const capabilities = {};
  for (const surface of CAPABILITY_SURFACES) {
    const value = source.capabilities[surface];
    const normalized = normalizeStatus(value);
    capabilities[surface] = {
      status: normalized,
      evidence: normalized === UNKNOWN ? "unverified" : normalizeEvidence(value),
    };
  }
  return {
    id: key,
    provider: text(source.provider, key),
    evidence: text(source.evidence, "fixture evidence"),
    capabilities,
  };
}

function capabilityAliases(capabilities) {
  // Keep the machine contract's hyphenated names, while providing JS-friendly
  // aliases for callers that do not want quoted property access.  Both values
  // point at fresh immutable records and therefore cannot mutate the profile.
  return {
    ...capabilities,
    workingDirectory: capabilities["working-directory"],
    working_directory: capabilities["working-directory"],
  };
}

/**
 * Probe the selected agent's bounded capabilities inside an Orca context.
 *
 * Provider identity is a declaration (`profile`, ORCA_AGENT_PROFILE, or
 * ORCA_AGENT_PROVIDER), never inferred from a terminal title or process list.
 * `contextOptions` is passed to discoverOrcaContext and therefore remains on
 * Orca's public JSON CLI boundary. A caller may provide `contextResult` in a
 * test or after a prior read-only adapter call; no second CLI call is made.
 */
export async function probeOrcaAgentCapabilities({
  profile,
  profileFixture,
  env = process.env,
  contextOptions = {},
  contextResult,
} = {}) {
  const context = contextResult ?? await discoverOrcaContext({ ...contextOptions, env });
  const declared = profileKey(profile ?? env.ORCA_AGENT_PROFILE ?? env.ORCA_AGENT_PROVIDER);
  const selected = normalizeProfile(declared, profileFixture);

  if (!context?.available || !context.context) {
    const reason = text(context?.reason, "orca-unavailable");
    return {
      schemaVersion: ORCA_AGENT_CAPABILITY_SCHEMA_VERSION,
      available: false,
      availability: "unavailable",
      reason,
      provider: selected.provider,
      profile: selected.id,
      evidence: selected.evidence,
      capabilities: capabilityAliases(unknownCapabilities(`Orca context unavailable: ${reason}`)),
      context: null,
    };
  }

  // The context adapter already proves this is an absolute runtime path. Keep
  // it as an observation, not a provider claim; an unknown provider cannot
  // upgrade its working-directory status from the presence of the path.
  const observedWorkingDirectory = text(context.context.worktree_path);
  const capabilities = { ...selected.capabilities };
  if (!observedWorkingDirectory) {
    capabilities["working-directory"] = {
      status: UNKNOWN,
      evidence: "Orca context omitted worktree path",
    };
  }

  return {
    schemaVersion: ORCA_AGENT_CAPABILITY_SCHEMA_VERSION,
    available: true,
    availability: "available",
    reason: null,
    provider: selected.provider,
    profile: selected.id,
    evidence: selected.evidence,
    capabilities: capabilityAliases(capabilities),
    observations: {
      working_directory: observedWorkingDirectory,
      orca_runtime_id: text(context.context.orca_runtime_id),
      orca_worktree_id: text(context.context.orca_worktree_id),
      terminal_handle: text(context.context.terminal_handle),
      session_id: text(context.context.session_id),
    },
    context: context.context,
  };
}

export const readOrcaAgentCapabilities = probeOrcaAgentCapabilities;
export const probeOrcaCapabilities = probeOrcaAgentCapabilities;

/** Validate a probe result without accepting unbounded provider-specific keys. */
export function validateOrcaAgentCapabilityProbe(result) {
  const errors = [];
  if (!isObject(result)) return { ok: false, errors: ["probe result must be an object"] };
  if (result.schemaVersion !== ORCA_AGENT_CAPABILITY_SCHEMA_VERSION) errors.push("unsupported probe schemaVersion");
  if (typeof result.available !== "boolean") errors.push("available must be boolean");
  if (!isObject(result.capabilities)) errors.push("capabilities must be an object");
  else {
    for (const surface of CAPABILITY_SURFACES) {
      if (!isObject(result.capabilities[surface])) errors.push(`capabilities.${surface} must be an object`);
      else if (!CAPABILITY_STATUSES.includes(result.capabilities[surface].status)) {
        errors.push(`capabilities.${surface}.status is outside the bounded status set`);
      }
    }
  }
  if (result.available && !isObject(result.observations)) errors.push("available probe must include observations");
  if (!result.available && result.context !== null) errors.push("unavailable probe must not include context");
  return { ok: errors.length === 0, errors };
}
