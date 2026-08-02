// Desktop surfaces share an application shell but not a capability or init
// contract. Detection is declaration-based: an external CLI cannot safely infer
// the selected ChatGPT Desktop experience from files or processes on disk.

const CONTRACTS = Object.freeze({
  "chatgpt-desktop": Object.freeze({
    surface: "chatgpt-desktop",
    host: "chatgpt-desktop",
    runtime: null,
    detection: "declared",
    capabilities: Object.freeze({
      mode: "select-experience",
      cliFlag: null,
      dispatch: "unknown-until-mode-selected",
    }),
    init: Object.freeze({
      state: "handoff",
      reason: "unavailable",
      expectedArtifacts: Object.freeze([]),
      instruction: null,
    }),
  }),
  "codex-desktop": Object.freeze({
    surface: "codex-desktop",
    host: "chatgpt-desktop",
    runtime: "codex",
    detection: "declared",
    capabilities: Object.freeze({
      mode: "codex",
      cliFlag: "--codex",
      dispatch: "codex-native",
    }),
    init: Object.freeze({
      state: "handoff",
      reason: "not-callable",
      expectedArtifacts: Object.freeze(["AGENTS.md"]),
      instruction: "/init",
    }),
  }),
  "chatgpt-work": Object.freeze({
    surface: "chatgpt-work",
    host: "chatgpt-desktop-or-web",
    runtime: "work",
    detection: "declared",
    capabilities: Object.freeze({
      mode: "work",
      cliFlag: "--work",
      dispatch: "mcp-or-inline",
    }),
    init: Object.freeze({
      state: "handoff",
      reason: "unavailable",
      expectedArtifacts: Object.freeze([]),
      instruction: null,
    }),
  }),
});

const ALIASES = Object.freeze({
  "desktop-codex": "codex-desktop",
  "gpt-work": "chatgpt-work",
  work: "chatgpt-work",
});

export const DESKTOP_HARNESS_SURFACES = Object.freeze(Object.keys(CONTRACTS));

export function resolveDesktopHarness(surface) {
  const declared = typeof surface === "string" ? surface.trim().toLowerCase() : "";
  const key = ALIASES[declared] || declared;
  const contract = CONTRACTS[key];
  if (!contract) {
    throw new Error(
      `unknown desktop harness "${declared || "(missing)"}"; declare chatgpt-desktop, codex-desktop, or gpt-work`,
    );
  }
  return structuredClone(contract);
}
