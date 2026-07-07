// test/test-support/capabilities-helpers.js — shared "nothing installed" sentinel for
// tests exercising resolveCapabilities/isInstalled/matchProviders/readInstalled against a
// bare machine (no plugins, skills, mcpServers, or agents present).
//
// Exports:
//   bareCapabilities() — returns a fresh { plugins: [], skills: [], mcpServers: [], agents: [] }
//                          object each call (never a shared reference, so one test's mutation
//                          can never leak into another's).

/**
 * A bare-machine capabilities/installed sentinel: no plugins, skills, mcpServers, or
 * agents installed. Returns a fresh object on every call.
 *
 * @returns {{ plugins: string[], skills: string[], mcpServers: string[], agents: string[] }}
 */
export function bareCapabilities() {
  return { plugins: [], skills: [], mcpServers: [], agents: [] };
}
