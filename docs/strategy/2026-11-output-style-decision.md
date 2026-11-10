# Output style: keep Muster's, optional and unforced (2026-11-10)

Findings F20 ([2026-11-claude-code-findings.md](../research/2026-11-claude-code-findings.md#f20-the-built-in-concise-output-style-overlaps-musters)).
Claude Code 2.1.237: "Added a built-in \"Concise\" output style: Claude leads with results and
skips preamble and narration, while doing the work just as thoroughly."

## Decision

Keep `plugin/output-styles/muster.md` as an optional style the user picks in `/config`. It stays
unforced: its frontmatter has no `force-for-plugin`, and no muster setting selects it. That follows
the owner decision of 2026-11-09, "Output style: stop forcing it". It is not deprecated, because it
is not redundant with Concise.

## How it differs from Concise

| | Concise | Muster |
|---|---|---|
| Lead with the result, no preamble or narration | yes | yes (overlap) |
| Each non-obvious decision on one line with its evidence (route, why, fallback) | no | yes |
| "Done" stated with the command that proves it, inline | no | yes |
| Escalations, degradations and assumptions named in a clause | no | yes |
| Claims cite evidence; assumptions flagged as assumptions | no | yes |
| Real plans ticked `- [ ]` to `- [x]` | no | yes |
| Security warnings and irreversible confirmations revert to full prose | not stated | yes |

The brevity rules ("shortest complete answer", "act, then report", no "Let me…") duplicate Concise.
The glass-box rules are muster's own: they make an orchestration run auditable from the transcript.

## Follow-up (owner call, not done here)

- Trim the brevity paragraphs so the style is a thin glass-box layer and leaves brevity to Concise.
  That would cut the style roughly in half without changing what a user sees.
- Retire the style only if the glass-box rules move somewhere they apply without it, for example
  into the orchestrator skill's must-hold rules. Do not delete it without the owner.

A user who prefers Concise loses only the glass-box conventions above; nothing in muster's runs
depends on the style being active.
