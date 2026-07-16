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

## Maintenance

- **check-before-test:** before testing a change, read this file if present.
- **update-after-divergence:** when a gate run finds a divergence from what's
  documented here (a count changed, a flow behaves differently, a new gotcha
  surfaces), the fix pass updates this file in the same commit — don't leave
  the runbook stale for the next reader.
