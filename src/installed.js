// Shared install check. Matches entry.detect.match across EVERY installed
// source — a tool installed as a plugin often also exposes an MCP server
// (e.g. serena, context7), and naming varies, so detect.kind is a hint, not a
// filter. Optional-chains the detect lookup and guards each installed array
// against undefined so a partial `installed` shape can't throw.
export function isInstalled(entry, installed) {
  if (entry.kind !== "external" || !entry.detect?.match) return false;
  const m = entry.detect.match;
  return (installed.plugins || []).includes(m)
    || (installed.skills || []).includes(m)
    || (installed.mcpServers || []).includes(m)
    || (installed.agents || []).includes(m);
}
