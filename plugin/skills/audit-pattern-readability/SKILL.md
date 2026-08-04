---
name: audit-pattern-readability
description: Hunt-list pattern skill for muster's readability audit dimension -- oversized functions, misleading structure, and hand-rolled reimplementation of an existing primitive in muster's own repo. Loaded by the audit orchestrator as a REQUIRED SKILLS binding on the code-review dimension task; read on demand, never dispatched standalone.
---

<!-- prompt-lint-disable ANTH-ROLE-001: reference hunt-list loaded ON DEMAND into an already
role-anchored code-review dispatch; a second "You are..." opener here would duplicate the persona. -->

# Audit pattern: readability

**Version:** 1

Hunt-list for the **readability** audit dimension (`buildAuditManifest`, `src/audit.js`, role
`code-review`, focus "human readability, maintainability").

**Seeded verbatim from the 2026-08-04 structure survey** (backlog items `split-codex-install` and
`codex-install-lock-unification`) -- this is one of the 2 proven 2026-08-04 survey briefs seeded
as a skill (the other is `audit-pattern-dead-code-duplication`).

## Where to dig

- **Oversized-function sweep** (the general procedure): a function whose body runs past ~150
  lines, or whose `try`/`catch` nesting visually misleads about what's actually guarded, is a
  structural readability finding regardless of whether the logic inside is individually correct.
  There is no single grep for this -- scan function boundaries (`function NAME(` /
  `export function NAME(` /`export async function NAME(` to the next same-indent `}`) and count
  lines, or use an existing line-count/structural-ratchet test if one already guards the file.
- **Verified 2026-08-04 survey finding, quoted verbatim from backlog item `split-codex-install`**
  (still open as of this writing -- re-verify line count before citing as current): "Decompose
  `runCodexInstall` (503 lines with misleading try/catch indentation) into named phase helpers
  and split `codex-install.js` by concern (install, uninstall, hooks, config transactions,
  marketplace)." Success criteria from that item: "every helper is at most 150 lines, 1
  structural ratchet test blocks regression, focused behavior suites green."
- **Verified 2026-08-04 survey finding, quoted verbatim from backlog item
  `codex-install-lock-unification`** (still open as of this writing): "Rebuild
  `codex-install.js`'s hand-rolled scope-registry lock (~lines 1017-1332) on `codex-lock.js`'s
  `withCodexFileLock` and retirement primitives." Success criteria from that item: "at least 250
  duplicated lines deleted, 0 behavior changes across lock acquisition, stale recovery,
  quarantine, and rollback fixtures". This is the general PATTERN to hunt for beyond this one
  instance: a module reimplementing a lifecycle (lock/retry/retirement) that an existing shared
  primitive already owns, instead of importing it -- readability suffers because a reader has to
  verify two implementations agree instead of trusting one.
- Convention-consistency sweep: raw `mkdtempSync` outside `test-support/` (see
  `audit-pattern-tech-debt`'s `test-tmpdir-convention` finding) is also a readability signal --
  every reader has to remember which files follow the tracked-cleanup convention and which don't.
- **Indentation-lies check**: indentation that misrepresents the code's TRUE brace/try-catch
  nesting (precedent: `codex-install.js`'s `runCodexInstall`, where two `try {` blocks sit at
  equal indent but their `catch` clauses are indented shallower than the `try` they belong to --
  visually implying a shared/flatter control-flow shape than the real one). Never judge nesting
  by eye alone; verify the TRUE structure by brace-tracing (count `{`/`}` per line to the
  candidate) or an AST parse before filing -- eyeballed indentation is exactly what this class of
  bug exploits.
- **Two-modules-in-one**: for a large file, map its coarse INTERNAL call graph by concern cluster
  -- do the clusters ever call into each other, or does the file only share one name by history?
  Precedent: `codex-install.js` bundles 5 largely-independent concerns (install, uninstall, hooks,
  config transactions, marketplace) that a concern-mapped call graph shows barely calling each
  other -- the file reads as "5 modules taped together," not one cohesive unit.
- **Bare boolean/positional arguments** at a call site where an options object or a named local
  variable is the FILE'S OWN convention elsewhere (an inconsistency finding, not a universal
  style rule): precedent `codex-lock.js:265`'s
  `restoreOrRequireReplacement(path, retirement, moved, false)` passes a bare positional `false`
  where its two sibling call sites in the same file pass a named variable instead -- a reader has
  to jump to the function signature to learn what the trailing `false` even means, unlike its
  siblings.
- **Error messages that name no offending value**: `grep -n 'throw new Error("' src/*.js` for
  sites with ZERO string interpolation (no `${...}`/concatenated variable) in the message --
  worst-case precedent, `src/install.js:105-224`'s six uninstall `throw new Error("...")` calls,
  none of which name the specific path/state that triggered them, so a failure report alone can't
  tell a reader WHICH of several similar guards fired.
- **Comment rot**: a comment or prose reference to a renamed/removed symbol, a retired verb name
  used as if still primary (`run`/`sprint`/`autopilot` instead of `plan`/`go`/`go-backlog` --
  legitimate only on their documented one-line alias note, never elsewhere), the OLD tier
  vocabulary used as if it were still the role-tier taxonomy (`haiku`/`sonnet`/`opus`/`fable` as
  role tiers -- semantic tiers have been `scout`/`core`/`prime`/`apex` since 2026-07-27; the old
  names are legitimate only inside a documented alias table or as a concrete-model example, e.g.
  "fable on Claude Code"), or a `"PR #NNN"` reference that reads as describing CURRENT work when
  that PR has long since merged and moved on.

## Repo-specific conventions to enforce

- Decompose by CONCERN, not by arbitrary line-count slicing: `split-codex-install`'s own success
  criteria name concrete concerns (install, uninstall, hooks, config transactions, marketplace)
  -- a readability fix that just chops a long function into `part1()`/`part2()` without a
  concern-named boundary is not the fix this pattern asks for.
- A structural ratchet test (a line-count or complexity assertion that fails on regression) is
  the sanctioned way to lock in a readability fix so it can't silently regress later.

## Known false positives to rule out

- A long SKILL.md/command markdown PROSE file is not a "function" -- line-length concerns here
  target JS functions in `src/*.js`, not documentation. Route a prose-length concern to
  `audit-pattern-prompt-quality` instead (its `CTX-RULE-001`/`CTX-EXAMPLE-001` rules already cover
  system-prompt density).
- A long function that is a flat SWITCH/dispatch table (e.g. `src/cli.js`'s command router) reads
  linearly even at high line counts -- judge misleading STRUCTURE (nesting that hides what's
  guarded), not raw line count alone, before filing.

## Appended patterns

- (2026-08-04, source: SonarSource, Cognitive Complexity, quoted verbatim: "Increment when there is a break in the linear (top-to-bottom, left-to-right) flow of the code" / "Increment when structures that break the flow are nested" — https://www.sonarsource.com/blog/cognitive-complexity-because-testability-understandability/) Nesting-weighted split ranking: rank oversized-function candidates by depth-weighted flow breaks (count if/for/catch/&&/|| with a nesting multiplier via a simple scan), not raw lines — this formalizes the existing flat-switch false-positive note: `src/cli.js`'s dispatch chain ranks low, `runCodexDoctor`-shaped nested flows rank high, so the split effort lands where comprehension actually suffers. — false-positive note: generated or vendored code is out of scope; a high score on a linear switch means the scan is miscounting, not the code.

(none yet -- `muster-improver` may append dated, evidenced entries here from run receipts; see
`plugin/skills/improve/SKILL.md`.)

Report findings as a bullet list, one finding per line: severity (P0/P1/P2), location
(file:line), problem, suggested fix -- matching the audit dispatch's own return contract
(`plugin/commands/audit.md` step 3).
