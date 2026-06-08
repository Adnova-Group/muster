// Channel steering classifier: maps a free-text message from a human operator to a discrete action.
// Precedence (stop > retarget > approve > status) encodes safety: an explicit halt is honored first;
// a scope change must not be silently collapsed into an approval of the wrong work; approve advances;
// status is informational and only fires when nothing more decisive matched.
const RULES = [
  {
    action: "stop",
    patterns: [/\bstop\b/i, /\bhalt\b/i, /\babort\b/i, /\bcancel\b/i, /\bpause\b/i, /\bhold\b/i],
  },
  {
    action: "retarget",
    patterns: [
      /\binstead\b/i,
      /\bretarget\b/i,
      /\bredirect\b/i,
      /\bswitch to\b/i,
      /\bchange scope\b/i,
      /\balso do\b/i,
      /\brescope\b/i,
    ],
  },
  {
    action: "approve",
    patterns: [
      /\bapprove[d]?\b/i,
      /\bcontinue\b/i,
      /\bproceed\b/i,
      /\blgtm\b/i,
      /\bgo ahead\b/i,
      /\bship it\b/i,
      /\byes\b/i,
      /\bok\b/i,
      /\bokay\b/i,
    ],
  },
  {
    action: "status",
    patterns: [
      /\bstatus\b/i,
      /\bprogress\b/i,
      /\bupdate\b/i,
      /\bchecklist\b/i,
      /\bwhere are we\b/i,
      /\bhow'?s it going\b/i,
      /\bhow is it going\b/i,
    ],
  },
];

export function classifySteer(text) {
  if (typeof text !== "string") return { action: "unknown" };
  const trimmed = text.trim();
  if (!trimmed) return { action: "unknown" };
  for (const { action, patterns } of RULES) {
    if (patterns.some((re) => re.test(trimmed))) return { action };
  }
  return { action: "unknown" };
}
