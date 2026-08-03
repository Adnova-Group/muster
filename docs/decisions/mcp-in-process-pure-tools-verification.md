# mcp-in-process-pure-tools: verification hardening

Status: satisfied-at-base, hardened

## Decision

The item's outcome ("remove the process and temporary-file boundary from
deterministic read-only MCP tools; byte-equivalent outputs and cancellation;
mutating tools retain isolation; the documented 12-call replay improves p95
latency by at least 50%") was already fully implemented before this run, in
base merge commit `ea22595` ("merge in-process deterministic MCP tools").
This run did not change production behavior. It added two regression tests
that close a real gap in the existing test coverage, and it records the
latency criterion's verification status honestly given this run's no-benchmark
constraint (see Latency evidence below).

## What base already delivers (inventory)

- `mcp/in-process-tools.mjs:19-32` declares `PURE_TOOLS`, the exact twelve
  deterministic read-only MCP tool names: `muster_wave`, `muster_next`,
  `muster_gate_cadence`, `muster_sprint_reconcile`, `muster_score`,
  `muster_prioritize`, `muster_pick`, `muster_tally`, `muster_advise`,
  `muster_fuse`, `muster_fast_path`, `muster_plan_checklist`. This matches
  `docs/mcp-in-process-pure-tools.md:3-6`'s documented inventory sentence
  verb-for-verb.
- `mcp/server.mjs:462-467` (`callTool`) calls `invokeInProcessTool(name, ...)`
  **before** any CLI dispatch; when `inProcess.handled` is true it returns
  immediately. `runCli` (the `execFile`-based CLI boundary) lives at
  `mcp/server.mjs:436-460` and is structurally unreachable for any name in
  `PURE_TOOLS` — this is a code-path guarantee, not just a behavioral one.
- `mcp/in-process-tools.mjs` and `mcp/in-process-worker.mjs` contain no
  `node:child_process` import and no `mkdtemp`/`tmpdir` call anywhere; pure
  tool arguments travel to the `worker_threads` `Worker` via `workerData`
  (`mcp/in-process-tools.mjs:178-187`), never through a temp file.
- Mutating tools retain the CLI/process boundary: `muster_backlog_publish`
  (`mcp/server.mjs:186-199`, exercised end-to-end at
  `mcp/server.mjs:535-547`) has no `argv`-intercepted-by-`PURE_TOOLS` entry
  and is proven to still shell out via
  `test/mcp-in-process-tools.test.js:131-149` ("mutating MCP tools retain the
  CLI process boundary").
- Cancellation bytes are identical on both the CLI-boundary and in-process
  paths because both literally return the same string constant: the
  CLI-boundary `cancelled()` at `mcp/server.mjs:335` and the worker-dispatcher
  abort/timeout branches at `mcp/in-process-tools.mjs:175,197,199` all produce
  `"muster MCP request cancelled"` (`mcp/in-process-tools.mjs:199` for the
  60s-timeout variant). Exercised by
  `test/mcp-in-process-tools.test.js:118-129` (immediate cancel) and
  `test/mcp-in-process-tools.test.js:198-237` (mid-computation cancel that
  does not block the event loop) and
  `test/mcp-in-process-tools.test.js:282-301` (worker termination completes
  before the invocation slot is released).
- Byte-equivalence against real CLI stdout is proven directly for all twelve
  tools at `test/mcp-in-process-tools.test.js:60-116`, plus edge cases:
  comma-containing ids (`:151-168`), empty ids (`:170-187`), a validation
  error's exact CLI error text (`:189-196`), and locale-sensitive tie
  ordering (`:265-280`).

## New in this run (verification hardening)

Two gaps existed in the otherwise-thorough base test suite:

1. `IN_PROCESS_TOOL_NAMES` (the exported source of truth for `PURE_TOOLS`)
   was exported by `mcp/in-process-tools.mjs:220` but never imported or
   asserted on by any test — nothing would catch the allowlist and
   `docs/mcp-in-process-pure-tools.md`'s inventory sentence drifting apart
   (e.g. a tool silently dropped from or added to the in-process lane without
   updating the doc, or vice versa).
2. The "no process/temp-file boundary" claim was proven only dynamically
   (an end-to-end RPC test that traps a forbidden CLI script) and never as a
   direct structural assertion against the two files that matter
   (`mcp/in-process-tools.mjs`, `mcp/in-process-worker.mjs`).

Added to `test/mcp-in-process-tools.test.js`:

- `test/mcp-in-process-tools.test.js:330` — "the exported pure-tool allowlist
  matches the documented twelve exactly": parses the doc's inventory sentence,
  maps each verb to its `muster_`-prefixed tool name, and asserts set equality
  against `IN_PROCESS_TOOL_NAMES`, plus that `muster_backlog_publish` (the
  doc's named mutating exception) is never a member.
- `test/mcp-in-process-tools.test.js:358` — "the in-process dispatcher and
  worker never reintroduce the removed child-process or temp-file transport":
  reads both source files and asserts neither matches
  `node:child_process|execFile|spawn(` nor `mkdtemp|node:os|tmpdir(`.

Both tests were verified to actually catch the regression they guard against
(not vacuous): temporarily removing a tool from `PURE_TOOLS` red-lines the
allowlist-sync test, and temporarily adding a `node:child_process` import to
`mcp/in-process-tools.mjs` red-lines the structural test; both reverts were
confirmed byte-identical to the pre-experiment file via `diff` before
committing. Neither experiment was committed.

## Latency evidence status: UNVERIFIED-THIS-RUN

This run's constraint prohibits executing any benchmark, including latency
measurement. The reproducible 12-call replay
(`eval/perf/replay-mcp-pure-tools.mjs`, documented at
`docs/mcp-in-process-pure-tools.md:22-40` and enforced by
`test/eval-replay-mcp-pure-tools.test.js:11-22`) exists and is wired to fail
its own process (`eval/perf/replay-mcp-pure-tools.mjs:107`) unless byte
equivalence holds and p95 improves by at least 50%, but it computes its
numbers fresh on every invocation — no prior run's concrete p95 numbers are
persisted anywhere in the tree. A repo-wide search of `CHANGELOG.md`,
`docs/**`, and test fixtures for a recorded past result (a concrete
millisecond or percentage figure tied to this replay) found none; the doc
only describes the script's behavior and pass/fail contract, not a specific
recorded outcome.

Reason not measured this run: benchmark execution is explicitly prohibited by
this run's constraints. Per that constraint, this criterion is recorded as
**UNVERIFIED-THIS-RUN** rather than measured or fabricated. The functional
contract that would make the number meaningful (byte equivalence, in-process
no-spawn, cancellation, mutating isolation) is fully verified above; only the
"at least 50%" magnitude claim itself is unverified in this run.

## Verification (this run)

`node --test test/mcp-in-process-tools.test.js` — 15/15 pass (13 pre-existing
+ 2 new). No benchmark or latency script was executed.
