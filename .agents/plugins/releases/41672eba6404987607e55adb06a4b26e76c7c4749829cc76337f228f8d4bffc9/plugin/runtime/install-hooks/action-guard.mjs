// Codex-packaged copy of Muster's pure action-class classifier. The validation
// suite exercises the same action vocabulary and boundary behavior.

const TOOL_NAME_CLASSES = ["send", "submit", "publish", "sign", "purchase"];

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

export function classifyAction(payload) {
  if (!payload) return null;
  if (payload.tool_name === "Bash") {
    const command = (payload.tool_input && payload.tool_input.command) || "";
    return classifyBashCommand(command);
  }
  return classifyToolName(payload.tool_name);
}
