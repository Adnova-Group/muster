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
`spawnHook` pattern used by every `test/hook-*.test.js` file):**
```
mkdir -p /tmp/muster-hook-check/.muster
echo "run-001" > /tmp/muster-hook-check/.muster/run-active
: > /tmp/muster-hook-check/transcript.jsonl   # empty = no TodoWrite yet

echo '{"tool_name":"Task","tool_input":{"description":"do work"},"transcript_path":"/tmp/muster-hook-check/transcript.jsonl","cwd":"/tmp/muster-hook-check","session_id":"sess-test"}' \
  | node plugin/hooks/todo-gate.js
```

Verified output (run 2026-07-06):
```
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"muster runs are todo-driven so plan progress stays visible. Create the run's todo list first — one TodoWrite item per plan step (encode the crew owner + state in each item's text), then dispatch the wave."}}
```
exit code `0` — hooks always exit 0; the verdict lives in the JSON body
(`hookSpecificOutput.permissionDecision`: absent/undefined = ALLOW, `"deny"` =
DENY), not in the process exit code.

Env overrides are passed the same way any child process reads them, e.g.
`MUSTER_TODO_GATE=off` piped the same payload flips the verdict to ALLOW
(the todo-gate escape hatch) — see `test/hook-todo-gate.test.js` for the full
env-override matrix per hook.

**Expected signals:** valid JSON on stdout, always exit 0, `hookSpecificOutput
.hookEventName` matches the hook (e.g. `"PreToolUse"`). Absence of
`permissionDecision` means ALLOW.

**Known divergences:** none currently open (2026-07-06).

**Gotchas:**
- A missing or unreadable `transcript_path` fails OPEN (ALLOW), not closed —
  don't mistake a typo'd path in a manual check for a passing gate; verified
  above (`/nonexistent.jsonl` still returned ALLOW with no `permissionDecision`
  field).
- The DENY reason text on `todo-gate.js` is prose, not an error code — if you
  assert on it in a new test, match with a regex (`/todo-driven|TodoWrite/i`)
  the way `test/hook-todo-gate.test.js` does, not an exact string, so wording
  tweaks don't need a test edit.
- `.muster/run-active`'s mtime matters for `todo-gate.js`: a `TodoWrite` in
  the transcript only counts if its timestamp is AFTER the marker's mtime.
  Clean up your tmpdir between runs — a stale marker with an old mtime will
  make a fresh TodoWrite look like it predates the run.

---

## Flow 4: Codex hook health, single-lockfile semantics, and lease-respecting retention

Codex hooks are installed in project (`<cwd>/.codex`) and/or user
(`$CODEX_HOME`) layers. As of the 2026-07-15 lock/lease/quarantine/retirement
teardown, `.codex/muster/hooks/muster-hook.mjs` and `codex/hooks/muster-hook.mjs`
have no emission-dedupe subsystem (no per-event lock files, no 64-per-shard
capacity cap, no cleanup/capacity locks) — every context/advisory they emit is
idempotent, so two installed copies (or two runs of the same event) both emit
independently rather than deduping. Run the focused regression coverage while
changing the hook runtime or installer contract:

```
node --test --test-name-pattern='idempotent context|exports no lock|requires exact owned' test/codex.test.js
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
generation, bootstrap digest, and runtime hash. A changed matcher, timeout,
command, or duplicate owned group makes hook health fail; refresh that scope
with `muster install codex`.

**Single-lockfile semantics (`src/codex-lock.js`):** `withCodexFileLock` is a
plain create-or-fail lockfile: on contention it checks staleness (age past
`staleMs`, plus the recorded PID/process-start-identity check) and either
unlinks-then-retries a stale lock or waits/times out on a live one — no
quarantine/retirement directory dance. Release is a direct unlink after an
ownership (token) check. Regression coverage:

```
node --test --test-name-pattern='serializes concurrent holders|protects its generation|bounded current-plus-previous' test/codex-lock.test.js test/codex-release.test.js
```

**Expected signals:** all three tests pass. "serializes concurrent holders"
covers the lockfile primitive directly (mutual exclusion, clean release).
"bounded current-plus-previous" covers `publishCodexRelease`'s default
retention: it prunes to the current + immediately-prior generation (plus the
stable bootstrap and whatever the marketplace pointer advertises) — no
per-process lease tracking lives in `src/codex-release.js` or the hook
anymore. "protects its generation" covers the one read-only exception:
`codex/bootstrap/resolve-release.mjs` (a separate, still-owned artifact,
exercised by `test/codex-cache-package.test.js` and the "cached resolver"
tests in `test/codex-release.test.js`) still registers/renews a lease file under
`.agents/plugins/leases/<generation>/` while it holds a generation open for
point-of-use asset revalidation. `publishCodexRelease` never creates, renews,
or retires a lease itself, but before pruning a non-kept generation it checks
that generation's lease directory for any file touched within the last 5
minutes (`LEASE_FRESH_MS`) and skips pruning if one exists; a lease older than
that is treated as abandoned/crashed debris and is swept (release + lease
directory both removed) on the next publish.

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
