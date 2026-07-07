# Anti-pattern ledger

**Version:** 1

This is muster's own record of caught failure classes: bugs and design gaps found and
fixed during muster's own development, kept here so the same class does not slip back in
under a new name. Each entry names the symptom (how it looked when it happened), the root
cause (why it happened), and the guard that now exists (the test or rule that would catch
it again).

Two consumers read this file: the orchestrator skill's brief-construction prose (see
`plugin/skills/orchestrator/SKILL.md`'s "Required skills (brief binding)" section) points a
dispatched builder or reviewer at relevant entries before work starts, and the
`muster-improver` agent treats it as an input when clustering a finished run's friction, so
a recurring problem gets checked against a known class before it is proposed as new.

To add an entry: append the next number, keep the Symptom / Root cause / Guard shape, cite
the actual guarding file and test by path, and bump the version above.

## 1. Dead namespaced ids

**Symptom:** `suggestSkillsForStack`'s framework-based skill suggestions used
colon-namespaced ids (for example `vercel:nextjs`) that never matched the real installed
inventory, which uses bare, un-namespaced ids (`nextjs`). Every suggestion for an installed
skill still came back flagged `missing: true`.

**Root cause:** the `STACK_SKILL_MAP` ids were authored against an assumed namespace-prefix
convention instead of the live `~/.claude` inventory naming, and the missing-check compared
ids by exact string equality, so a namespace mismatch on either side always read as absent.

**Guard:** `lastColonSegment()` in `src/match.js` compares a suggestion id and an inventory
id on their last colon-segment, namespace-insensitive in either direction. Pinned by
`test/match.test.js`'s test "suggestSkillsForStack: last-colon-segment matching is
namespace-insensitive in either direction" (fixed under commit 077d71c, flagged in review as
a blocker before merge).

## 2. Colon-description frontmatter parse

**Symptom:** reading a SKILL.md's frontmatter `description:` field with a full, strict YAML
parser threw on descriptions that legitimately contain a mid-string colon-space, such as
muster's own router and orchestrator SKILL.md text ("... Glass-box: every choice ..."). The
parser read the mid-string colon as the start of a nested mapping instead of plain text.

**Root cause:** a single scalar frontmatter field was being parsed as if it needed the full
YAML document structure, when only that one field's value was ever needed.

**Guard:** `descriptionFromSkillMdSync()` in `src/plugin-inventory.js` does a targeted line
extraction of the `description:` line (with block-scalar and quote handling) instead of a
full YAML parse. Regression-pinned by `test/capabilities.test.js`'s test "skills inventory:
a description containing a mid-string colon-space parses in full, not via a strict YAML
parse" (commit f0c0339).

## 3. Decorative announce lines

**Symptom:** the orchestrator's rule against inline crew-dispatch drift was enforced only by
asking the model to "announce the dispatch to STATE" in prose. A model under pressure could
skip the announcement and edit files inline, with nothing actually stopping it, so the
control was steering, not a gate.

**Root cause:** a behavior-critical rule was encoded only as an instruction to narrate
compliance, with no mechanism checking that the narration matched reality or blocking the
disallowed action when it did not.

**Guard:** `plugin/hooks/pre-tool-use.js`'s wave-guard denies main-loop `Edit`/`Write`/
`NotebookEdit` calls (and file-writing Bash patterns) while `.muster/wave-active` exists,
turning the announce-only rule into an enforced deny at the hook level. Covered by
`test/hook-pre-tool-use.test.js`'s test "deny when wave-active marker exists and editing
outside .muster/" (commits 6a1587f, de9e3dd).

## 4. Argument-carried scope

**Symptom:** an invocation's raw `$ARGUMENTS` text alone silently decided whether muster
treated the request as one outcome or a whole backlog, with no confirmation step. A
backlog-shaped argument could quietly run as a single item, or the reverse, with the user
never told which reading was chosen.

**Root cause:** scope (item vs. backlog) was inferred from argument text without ever being
checked against the user, so an ambiguous or backlog-shaped invocation had no forcing
function to surface the ambiguity before work began.

**Guard:** the deterministic `detectScope()` function (`src/scope.js`, the `muster scope`
CLI verb) plus `plan.md`'s and `go.md`'s step-0 AskUserQuestion confirm, which states the
detected scope and every signal verbatim and reads "NEVER silently choose when the signals
conflict". Pinned by `test/scope.test.js` and `test/mode-evals.test.js`'s test
"scope-confirm coverage: plan.md and go.md invoke muster scope, require verbatim signals,
and announce the artifact" (commits fd9441e, 4c38c8f, 322f05f).

## 5. False-green coverage

**Symptom:** the lifecycle runner's own receipts-grading regex accepted a result line like
"0 passed, 12 failed" as proof of a green run, because it only checked for a passed-count
digit plus the word "passed" and never checked whether the failed count was zero.

**Root cause:** the test-evidence check was written to detect the presence of pasted output
rather than to verify the output reports success, so a red run using the right vocabulary
could still pass grading.

**Guard:** `RUNNER_TEST_BASELINE_RE` and `RUNNER_TEST_FINAL_RE` in
`eval/modes/grade-skills.mjs` now require an explicit `0 failed` alongside the passed count.
Mutant-killed by `test/mode-evals.test.js`'s "runner-return-receipts" test, whose red-final
case mutates a clean "12 passed, 0 failed" line to "0 passed, 12 failed" and asserts the
check now fails (commit ad70966).

## 6. Stale-version walk

**Symptom:** looking up an installed skill's description by walking
`~/.claude/plugins/cache/.../<name>/<version>/` in directory (lexical) order returned an old
cached version's SKILL.md instead of the version actually recorded as installed. The
observed case returned muster 0.2.4's description instead of the installed 0.4.0's.

**Root cause:** directory listing order has no relationship to install recency, so a
name-only walk over cached version directories is not a substitute for reading the
authoritative `installed_plugins.json` install record.

**Guard:** `installedSkillDescription()` in `src/plugin-inventory.js` resolves via
`installed_plugins.json`'s recorded `installPath` first, falling back to the directory walk
only when no install record exists. Pinned by `test/plugin-inventory.test.js`'s test
"installedSkillDescription resolves via installed_plugins.json's installPath, not
directory-order (which would hit a stale cached version first)" (commit f0c0339).

## 7. Unanchored eval-regex false positive

**Symptom:** a grading regex for the lifecycle runner's dispatch-brief base-ref requirement
(originally `/base\s+\S+/i`) matched any occurrence of the word "base" anywhere in the brief
text, so unrelated prose such as "retries for the database migration" in the outcome line
could satisfy a check meant to verify the ISOLATION line names an actual base ref.

**Root cause:** the check regex was scoped to the whole brief text instead of the specific
line the requirement is actually about, so an incidental word match anywhere in the document
counted as satisfying it.

**Guard:** `RUNNER_BASE_RE` in `eval/modes/grade-skills.mjs` is now anchored to the
`^ISOLATION: ...` line. Pinned by `test/mode-evals.test.js`'s test "runner-dispatch-brief: a
brief carrying the full dispatch contract passes; each missing input fails", whose
`baseMissing` case removes the base ref from ISOLATION while inserting the word "database"
elsewhere and asserts the check still fails (commit ad70966).

## 8. Incidental-prose test scope leakage

**Symptom:** dispatch-contract assertions for the `muster-runner` agent definition matched
against the whole file source, so a required input or receipt mentioned anywhere else in the
document (outside the actual "## Dispatch contract" section) could satisfy an assertion that
was supposed to verify the contract section itself carries it.

**Root cause:** the test read the entire file rather than scoping its assertions to the
section the requirement actually applies to, so unrelated incidental prose could produce a
false pass.

**Guard:** `dispatchContractSection()` in `test/lifecycle-agent.test.js` extracts the
"## Dispatch contract" section and every brief-input and receipts assertion runs against
that extract alone, not the full file (commit ad70966).

## 9. Generated-artifact model-tier drift

**Symptom:** three vendored agent files (`wsh-backend-architect.md`, `wsh-cloud-architect.md`,
`wsh-docs-architect.md`) shipped with a stale `model: opus` frontmatter value after the
model-tier policy had moved those roles to `fable`. The frontmatter had been generated once
and never re-checked against the policy that was supposed to govern it.

**Root cause:** a generated artifact's value was frozen at generation time instead of being
derived from, or checked against, the single-source policy it represents, so the artifact
and the policy drifted apart independently.

**Guard:** `test/agents.generated.test.js`'s test "vendored agent plugin files have model
frontmatter matching current policy (no drift)" compares every vendored agent's frontmatter
`model` against `modelForRoles(roles)` from `src/model.js` (commit fdb65ff).
