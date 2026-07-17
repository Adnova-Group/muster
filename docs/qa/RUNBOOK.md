# QA runbook

Repo-local, compounding test knowledge for muster. This is where the review gate
(`plugin/skills/review-gate/SKILL.md`) and any human or agent about to test a
change should look first, and where it should record what it learns.

**Why this lives here, in git, and not under `.muster/`:** `.muster/` is
gitignored (`git check-ignore .muster/x` confirms it) — anything written there
evaporates at the end of a session and never compounds across runs. This file
is committed instead, so the next session (or the next reviewer) inherits every
gotcha the last one paid for. Keep it real: every command below was run against
this repo and the output pasted is what actually came back, not a guess.

Structure: one section per high-traffic flow — how to exercise it, what
"healthy" looks like, known divergences (dated), and gotchas. When you find a
new one, add it here in the same pass as the fix (see "update-after-divergence"
in the review-gate skill).

---

## Flow 1: full suite (`npm test`)

**How to exercise:**
```
npm test
```
(equivalent to `node --test`, per `package.json`'s `"test"` script — safe to
run directly as `node --test` too, same result.)

**Expected signals:** all suites green. The invariant that matters is `tests ==
pass` and `fail 0` (`cancelled 0`, `skipped 0` are the healthy baseline too) —
**never assert the absolute count from memory; read it from the run.** The
total grows with every feature slice, so a hardcoded number here goes stale
the next time someone adds a test and becomes a false "divergence" the moment
it's checked against a fresh run. Duration is ~15s (varies 14-18s on this box).

Two self-check tests in the suite are worth knowing by name because they catch
doc drift, not logic bugs:
- `every CLI subcommand in usage string appears in website/reference/commands.md`
- `every hook event in hooks.json appears in website/reference/architecture.md`
If either fails, the fix is almost always a docs edit, not a code edit.

**Known divergences:** none currently open (2026-07-06).

**Gotchas:**
- The suite count is a moving target by design — every feature slice adds
  tests. Don't hardcode it anywhere (here or elsewhere); the only thing to
  check is the invariant above, read fresh from the run's own summary line.
- Full run takes ~15s. If you only touched one area, run the narrower pattern
  in Flow 2/3 first and save the full run for the pre-merge gate.
- Do not overlap whole-suite invocations. Codex package/cache tests rebuild and
  inspect immutable release fixtures; serialize `npm test` and use the final
  non-overlapping run as the gate receipt. A 2026-07-14 integration run saw a
  transient failure only while output-recovery invocations overlapped; the
  subsequent serialized 1,626-test barrier passed with zero failures.

---

## Flow 2: CLI verb smoke pattern

Exercise a single `muster` verb directly against a fixture instead of going
through the test harness — fast, and what you'd do to manually sanity-check a
CLI change.

**How to exercise:**
```
node src/cli.js manifest validate test/fixtures/manifest.valid.json
node src/cli.js sprint-waves <backlog.md>
node src/cli.js citation-check <file.md>
```

Verified examples (run from repo root):
```
$ node src/cli.js manifest validate test/fixtures/manifest.valid.json
{
  "ok": true,
  "errors": []
}
$ echo "exit:$?"
exit:0
```
```
$ printf -- '- [ ] Do first\n- [ ] Do second {deps: none}\n' > /tmp/backlog-sample.md
$ node src/cli.js sprint-waves /tmp/backlog-sample.md
{
  "ok": true,
  "errors": [],
  "waves": [["item-1", "item-2"]],
  "items": { "item-1": {...}, "item-2": {...} },
  "annotated": true
}
```
```
$ node src/cli.js citation-check README.md
{
  "ok": true,
  "claims": 39,
  "cited": 0,
  "uncited": [ ... ]
}
$ echo "exit:$?"
exit:0
```

**Expected signals:** exit code `0` + `"ok": true` on a valid input. A failing
input (invalid manifest, cycle in backlog deps, dangling citation anchor)
exits **2** with `"ok": false` and a populated `errors`/`danglingAnchors`
array — this is a deliberate convention across `manifest validate`,
`sprint-waves`, and `citation-check` (see `src/cli.js`'s `process.exit(2)`
call sites), so a bare non-zero exit code is enough for a script to gate on
without parsing JSON.

**Known divergences:** none currently open (2026-07-06).

**Gotchas:**
- `citation-check` on a file with zero `[src: x]` anchors still exits 0 — no
  claims cited is not automatically a failure at the CLI layer; the "is this a
  claim needing evidence" judgment call is a reviewer's job per the
  citation-guard step in `review-gate/SKILL.md`, not the checker's.
- `sprint-waves` fixtures should use unchecked (`- [ ] `) items to appear in a
  wave at all — checked (`- [x] `) items are dropped from `waves` (see
  `test/sprint-waves.test.js`, "checked items are ignored").

---

## Flow 3: hook testing pattern (pipe JSON into `plugin/hooks/*.js`)

Hooks read a single JSON payload from stdin and print a JSON response to
stdout — no CLI args. Test them by piping a payload directly, with any
required `.muster/` marker files staged in a tmpdir first.

**How to exercise (manual, matches `test/test-support/hook-helpers.js`'s
`spawnHook` pattern used by every `test/hook-*.test.js` file):** the example
below hits `pre-tool-use.js`'s action-class fence, the one hard deny left in
the enforcement stack (the wave-guard, the per-turn scale-gate, and the
todo-driving gate that used to live at `plugin/hooks/todo-gate.js` were all
removed by the enforcement-model redesign; see CHANGELOG -- `node
plugin/hooks/todo-gate.js` is a dead command now, the file is gone).
```
mkdir -p /tmp/muster-hook-check/.muster
echo "run-001" > /tmp/muster-hook-check/.muster/run-active
printf "send\n" > /tmp/muster-hook-check/.muster/forbidden-actions

echo '{"tool_name":"mcp__gmail__send_email","tool_input":{},"cwd":"/tmp/muster-hook-check","session_id":"sess-test"}' \
  | node plugin/hooks/pre-tool-use.js
```

Verified output (run 2026-07-16):
```
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Action class \"send\" is forbidden for this run — this tool call would perform a send action. If this class should not be forbidden: remove its line from .muster/forbidden-actions. To soften or disable this check: set MUSTER_ACTION_GUARD=warn or off."}}
```
exit code `0` — hooks always exit 0; the verdict lives in the JSON body
(`hookSpecificOutput.permissionDecision`: absent/undefined = ALLOW, `"deny"` =
DENY), not in the process exit code.

Env overrides are passed the same way any child process reads them, e.g.
`MUSTER_ACTION_GUARD=off` piped the same payload flips the verdict to ALLOW
(silences the fence for this run) -- see
`test/hook-pre-tool-use-action-fence.test.js` for the full
warn/off/fail-open matrix.

**Expected signals:** valid JSON on stdout, always exit 0, `hookSpecificOutput
.hookEventName` matches the hook (e.g. `"PreToolUse"`). Absence of
`permissionDecision` means ALLOW.

**Known divergences:** none currently open (2026-07-16).

**Gotchas:**
- The fence is a no-op (fails open, ALLOW) unless BOTH `.muster/run-active`
  AND `.muster/forbidden-actions` exist -- either missing/unreadable falls
  through silently rather than denying; verified above by dropping either
  file and re-running the same payload.
- The DENY reason text is prose, not an error code -- if you assert on it in
  a new test, match with a regex (e.g. `/send/i`) the way
  `test/hook-pre-tool-use-action-fence.test.js` does, not an exact string, so
  wording tweaks don't need a test edit.
- `agent_id` on the payload (a subagent call) and a target path under
  `.muster/`/`.claude/` both bypass the fence entirely, forbidden class or
  not -- see `pre-tool-use.js`'s decision-order docblock for the full
  precedence.

---

## Flow 4: Codex hook health, install-time-generation copy-publish, and legacy-manifest migration

Codex hooks are installed in project (`<cwd>/.codex`) and/or user
(`$CODEX_HOME`) layers. As of the 2026-07-15 lock/lease/quarantine/retirement
teardown, `.codex/muster/hooks/muster-hook.mjs` and `codex/hooks/muster-hook.mjs`
have no emission-dedupe subsystem (no per-event lock files, no 64-per-shard
capacity cap, no cleanup/capacity locks) — every context/advisory they emit is
idempotent, so two installed copies (or two runs of the same event) both emit
independently rather than deduping. Run the focused regression coverage while
changing the hook runtime or installer contract:

```
node --test --test-name-pattern='idempotent context|exports no lock' test/codex-hooks.test.js
node --test --test-name-pattern='requires exact owned' test/codex-doctor.test.js
```

**Expected signals:** all three tests pass. "emits idempotent context" proves
two installed copies both emit for the same event (no cross-copy dedupe) and
that a repeated `turn_id` still emits (no per-event dedupe state). "exports no
lock" proves the hook module has zero exports (no lock/quarantine/retirement
machinery survives) and that CODEX_HOME never gets a bookkeeping directory
created under it. The doctor test installs the project layer from source and
the user layer from the selected cache release, then requires `codex-hooks`
and `codex-hooks-overlap` to be healthy — doctor still compares installed
Muster groups against their ownership manifest exactly by event, matcher,
command/`commandWindows`, timeout, and every other group option, alongside
`packageVersion` and runtime hash. A changed matcher, timeout, command, or
duplicate owned group makes hook health fail; refresh that scope with
`muster install codex`.

**Install-time-generation copy-publish (`src/codex-release.js`, `scripts/build-codex.mjs`):**
the Codex plugin is no longer a committed, content-addressed release — it is
generated fresh into a native-tmpfs staging directory (never under a possibly
drvfs-mounted `outDir`, to sidestep a confirmed WSL2 rename-after-write-burst
pathology) and *published by copy* (`cpSync`, not a rename) into
`outDir/plugin`, guarded by `withCodexFileLock`'s single lockfile so two
concurrent publishers to the same `outDir` always serialize. `publishCodexPlugin`
validates the staged tree once before taking that lock; because a same-user
writer could in principle mutate the staged tmpdir in the gap between that
validation and the copy, two independent defenses close it: the copy step
rejects (hard errors on, never silently drops) any symlink or special file it
encounters, and the copy destination is re-validated with `assertRegularTree`
again before the marketplace pointer is written. A publish that fails after
retiring the previous `plugin` dir restores it; a crash that leaves an orphaned
`.muster-retired-*` sibling behind is swept at the start of the next publish.
Regression coverage:

```
node --test --test-name-pattern='serializes concurrent holders|copy-time filter rejects a symlink|destination re-validation independently|sweeps an orphaned|concurrent publishes to the same pluginsRoot' test/codex-lock.test.js test/codex-release.test.js
```

**Expected signals:** all five tests pass. "serializes concurrent holders"
covers the lockfile primitive directly (mutual exclusion, clean release).
"copy-time filter rejects a symlink" and "destination re-validation
independently" each cover one of the two copy-time-race defenses in
isolation (one bypassing the other) so neither is a single point of failure.
"sweeps an orphaned" covers crash-debris cleanup. "concurrent publishes to
the same pluginsRoot" covers two real overlapping publishers leaving one
coherent winner with no leftover retirement directory.

**Readers are not synchronized with a publish.** `resolveCodexPlugin`,
`scripts/check-codex.mjs`, `src/codex-doctor.js`, and `buildCodexPlugin`'s own
skip-check all read `outDir` without taking the publish lock, so one running
during the retire-then-copy window can observe a transient ENOENT or a
partial tree. `resolveCodexPlugin` absorbs the narrow ENOENT case with a small
bounded retry; anything else is dev/CI tooling that simply reruns. This is
documented, not a bug — see `publishCodexPlugin`'s docblock.

**Version-only skip-if-current, and its force escape hatch:** `buildCodexPlugin`
(and therefore `npm run build:codex` / the `pretest` hook) skips regeneration
entirely when `outDir` already holds a published plugin whose `packageVersion`
matches `package.json` — it does not compare file content, so editing a source
file without bumping the version is a silent no-op. Set `MUSTER_BUILD_FORCE=1`
to force a real rebuild regardless of the published version:

```
node --test --test-name-pattern='MUSTER_BUILD_FORCE' test/codex-build-repro.test.js
```

**Legacy pre-0.5.x managed-manifest migration:** the 2026-07-15 teardown
renamed the managed-manifest coherence key from `generation`/`bootstrapDigest`
to `packageVersion` (see CHANGELOG.md) — an install made before that change
fails `codex-install-generation`/`codex-hooks`/`codex-hooks-overlap` with no
auto-migration. `runCodexDoctor` detects that exact legacy shape and reports
"legacy pre-0.5.x install detected at `<dir>` (rerun `muster install codex
--scope project`/`--scope user` to migrate)" instead of an opaque
version-mismatch message. Regression coverage:

```
node --test --test-name-pattern='legacy pre-0.5.x' test/codex-doctor.test.js
```

**Expected signal:** one test passes, asserting all three checks name the
legacy scope and the exact remediation command rather than a generic "does
not match"/"is stale" message.

**Codex limitation:** these hooks provide lifecycle context, diagnostics, and
supported policy warnings. They do not prove subagent liveness and cannot
reliably enforce every unified-shell or subagent action; write-capable waves
still require isolated worktrees and event-driven, wait-first receipt handling.

---

## Maintenance

- **check-before-test:** before testing a change, read this file if present.
- **update-after-divergence:** when a gate run finds a divergence from what's
  documented here (a count changed, a flow behaves differently, a new gotcha
  surfaces), the fix pass updates this file in the same commit — don't leave
  the runbook stale for the next reader.
