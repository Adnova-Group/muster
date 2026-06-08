// Escapes regex metacharacters in a string so it can be safely interpolated
// into a `new RegExp(...)` pattern (e.g. for whole-word keyword matching).
export function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
