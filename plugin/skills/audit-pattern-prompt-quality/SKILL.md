---
name: audit-pattern-prompt-quality
description: Hunt-list pattern skill for muster's prompt-quality audit dimension -- points into src/prompt-lint.js's rule set and muster prompt scan rather than duplicating the rule list. Loaded by the audit orchestrator as a REQUIRED SKILLS binding on the prompt-quality dimension task; read on demand, never dispatched standalone.
---

<!-- prompt-lint-disable ANTH-ROLE-001: reference hunt-list loaded ON DEMAND into an already
role-anchored prompt-quality dispatch; a second "You are..." opener here would duplicate the
persona. -->

# Audit pattern: prompt quality

**Version:** 1

Hunt-list for the **prompt-quality** audit dimension (`buildAuditManifest`, `src/audit.js`, role
`prompt-quality`, conditional on the target project's own prompting signal).

**Single-source rule**: this pillar's pattern source is the deterministic, already-versioned lint
rule set in `src/prompt-lint.js` -- this file POINTS INTO it rather than re-listing the rules.
Read the source for exact regexes/thresholds; do not paraphrase them here where they can drift.

## Where to dig

- Run `muster prompt scan <path>` (`src/prompt-scan.js`) first, always -- it deterministically
  discovers every prompt doc/file in scope (`src/prompt-discover.js`'s conventions: dedicated
  `.prompt`/`.tmpl`/`prompts/` files, `name:`+`description:` frontmatter docs under
  `agents|commands|skills|builtins`, and backtick template-literal assignments to a prompt-ish
  identifier) and lints each with `lintPrompt`. Read its JSON output before doing any manual
  prompt review -- do not re-derive findings the deterministic scan already produced.
- Read `src/prompt-lint.js`'s `RULES` array directly for the current rule set: `ANTH-ROLE-001`/
  `ANTH-XML-001`/`ANTH-FMT-001`/`ANTH-SHOT-001`/`ANTH-POS-001`/`ANTH-CLEAR-001` (Anthropic
  best-practice: structure/examples/clarity), `LINT-TOOL-001`/`LINT-STOP-002`/`LINT-SCHEMA-003`
  (lintlang: agentic-tool framing), `GUARD-IDK-001`/`GUARD-CITE-002`/`GUARD-SEP-003`
  (guardrails: hallucination/injection defense), `CTX-EXAMPLE-001`/`CTX-RULE-001` (Claude-5
  context-engineering ratchets: example density, imperative-rule density). Each rule's `fix`
  field is the exact remediation phrasing to use in a finding.
- `lintChat`/`lintWorkflow` (same file) cover chat-turn hygiene and cross-task shared-state
  leakage respectively -- run these too when the audited scope defines multi-turn conversations
  or a sibling-prompt workflow (a pipeline with several phase prompts).
- Floor gate: `DEFAULT_GATE = { floor: 1, pass_total: 10 }` -- a prompt whose WEAKEST dimension
  scores below 1/3, or whose total is below 10/15, is `passing: false`. Cite the exact `rubric`
  breakdown from the scan output in the finding, not just "prompt quality is low".

## Repo-specific conventions to enforce

- `<!-- prompt-lint-disable RULE-ID: reason -->` is the ONLY sanctioned exception mechanism --
  whole-document scope, always carries a stated reason. A prompt that fails a rule with no
  disable comment and no fix is the finding; a prompt with an UNDOCUMENTED disable comment (no
  reason, or a reason that doesn't hold up) is ALSO a finding.
- `genre: "system"` (agent/skill/instruction prompts, what the scanner tags every discovered
  prompt doc as) exempts `taskOnly` rules (`ANTH-SHOT-001`, `ANTH-CLEAR-001`) and tolerates more
  negative-instruction density (`ANTH-POS-001`) -- don't flag a system prompt for lacking
  worked examples or an action-verb opening line; that rubric is for task prompts only.

## Known false positives to rule out

- `CTX-EXAMPLE-001` already EXCLUDES `plugin/builtins/**` and `codex/fallback-skills/**` content
  (vendored recipe skills whose worked examples ARE their payload) -- don't re-flag their example
  density; the rule's own `applies()` guard already skips them.
- A reference file loaded on-demand INTO an already-role-anchored context (e.g. this very file, or
  `plugin/skills/orchestrator/references/*.md`) legitimately disables `ANTH-ROLE-001` -- a missing
  "You are..." opener there is not a finding when the file states why in its own disable comment.

## Appended patterns

(none yet -- `muster-improver` may append dated, evidenced entries here from run receipts; see
`plugin/skills/improve/SKILL.md`.)

Report findings as a bullet list, one finding per line: severity (P0/P1/P2), location
(file:line), problem, suggested fix -- matching the audit dispatch's own return contract
(`plugin/commands/audit.md` step 3).
