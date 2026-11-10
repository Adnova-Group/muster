// action-guard.js — pure action-class classification for the action fence.
//
// A third fence dimension alongside the path-scoped owns/frozen fences: an
// ACTION class, drawn from the fixed set mirrored from src/manifest.js's
// forbiddenActions enum:
//   send | sign | submit | publish | purchase | delete-remote
// Hooks ship standalone under plugin/hooks/ (no cross-import from src/), so
// this set is duplicated here by design — keep both in sync if it changes.
//
// classifyToolName(toolName): keyword match against a non-Bash tool_name (e.g.
// an MCP tool call). Matches the same words as the action-class names
// themselves, so `mcp__gmail__send_email` -> "send", `*_publish_*` -> "publish".
// Principle: action fences gate EXTERNAL effects, not the orchestrator's own
// machinery. Only mcp__* tool names (external MCP server calls) are eligible
// for classification here — a harness-internal tool (SendMessage, SendUserFile,
// TaskCreate/TaskUpdate, Agent, Edit/Write, etc.) always returns null, no matter
// how keyword-shaped its name reads, since it never IS the external send/sign/
// publish action. (Bash is classified separately by classifyBashCommand, always.)
// Word-boundary matched (not a bare substring test): "sign" must not fire on
// "assign"/"assignments" — a class only matches as its own token, delimited by
// non-letter characters (`_`, `-`, `.`, digits) or the string's start/end.
//
// classifyBashCommand(command): a small, conservative allowlist of
// high-confidence external-effect shell patterns (not general shell parsing —
// fail-open on anything unrecognized). Unmatched -> null.
//
// classifyAction(payload): dispatches a PreToolUse payload to one of the above
// based on tool_name — Bash and PowerShell payloads are classified by command
// (the listed CLIs — git, gh, npm, curl — read the same in either shell),
// everything else by tool_name.
//
// All three return a class string or null (unmatched -> null, never throws).

const TOOL_NAME_CLASSES = ["send", "submit", "publish", "sign", "purchase"];

// Claude Desktop's own side-effect-free turn tools, called many times per Desktop session.
// hooks.json's matcher already skips exactly these names; the hook skips them again so a
// matcher mistake cannot widen the exclusion. EXACT names only, never a server or prefix: a
// user-configured server named ccd_<anything> (or any other ccd_turn tool) is still classified.
export const DESKTOP_HOST_TOOLS = new Set(["mcp__ccd_turn__update_plan", "mcp__ccd_turn__wrap_up"]);

// True if `word` appears in `str` as its own token: bounded on both sides by a
// non-letter character (or the string's start/end). Prevents "sign" firing
// inside "assign"/"assignments" while still matching "sign_document",
// "docusign__sign_document" (the standalone "__sign_" occurrence), etc.
function hasWordBoundaryMatch(str, word) {
  return new RegExp(`(?:^|[^a-zA-Z])${word}(?:[^a-zA-Z]|$)`, "i").test(str);
}

export function classifyToolName(toolName) {
  if (typeof toolName !== "string" || toolName.length === 0) return null;
  if (!toolName.startsWith("mcp__")) return null;
  for (const cls of TOOL_NAME_CLASSES) {
    if (hasWordBoundaryMatch(toolName, cls)) return cls;
  }
  return null;
}

// Ordered allowlist — first match wins. `git push --delete`/`-d` (removing a
// remote ref) is checked before plain `git push` so a delete-remote push isn't
// mis-classified as a general publish.
const BASH_PATTERNS = [
  { re: /\bgit\s+push\b[^|;&\n]*(?:--delete\b|\s-d\b)/i, cls: "delete-remote" },
  { re: /\bgh\s+release\s+create\b/i, cls: "publish" },
  { re: /\bnpm\s+publish\b/i, cls: "publish" },
  { re: /\bgit\s+push\b/i, cls: "publish" },
  { re: /\bcurl\b[^|;&\n]*\s-X\s*POST\b/i, cls: "send" },
  { re: /\bgh\s+pr\s+merge\b/i, cls: "submit" },
];

export function classifyBashCommand(command) {
  if (typeof command !== "string" || command.length === 0) return null;
  for (const { re, cls } of BASH_PATTERNS) {
    if (re.test(command)) return cls;
  }
  return null;
}

const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

export function classifyAction(payload) {
  if (!payload) return null;
  if (SHELL_TOOLS.has(payload.tool_name)) {
    const command = (payload.tool_input && payload.tool_input.command) || "";
    return classifyBashCommand(command);
  }
  return classifyToolName(payload.tool_name);
}
