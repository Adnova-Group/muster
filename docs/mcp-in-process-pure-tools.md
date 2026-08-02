# In-process deterministic MCP tools

Twelve deterministic, read-only MCP operations now run in the long-lived MCP
server instead of creating temporary input files and forking `src/cli.js`:
`wave`, `next`, `gate-cadence`, `sprint-reconcile`, `score`, `prioritize`,
`pick`, `tally`, `advise`, `fuse`, `fast-path`, and `plan-checklist`.

The production dispatcher calls the same `src/` functions as the CLI in a
worker thread owned by the long-lived MCP process. Its integration test compares
every returned text payload to real CLI stdout, byte for byte. A worker can be
terminated on cancellation or the established 60-second timeout without
blocking the server event loop; this retains the old child process's
terminability without its process or temporary-file transport. Tools outside
this explicit allowlist keep the CLI boundary; in particular,
`muster_backlog_publish` remains a child-process call with stdin handoff.

## Reproducible 12-call latency replay

Run:

```sh
node eval/perf/replay-mcp-pure-tools.mjs
```

The before lane recreates the removed production transport for each call:
`mkdtemp`, JSON input writes, a Node CLI child, stdout collection, and recursive
cleanup. The after lane runs the production in-process dispatcher with the same
arguments. Each round performs the same twelve calls in both lanes, compares
their output bytes, and reports per-call p95 latency. The script exits nonzero
unless the call count is exactly 12, all outputs are byte-equivalent, and p95
improves by at least 50%.

The replay is a local transport benchmark, not an end-to-end host or model
latency claim. Machine load affects absolute milliseconds; the enforced result
is the relative p95 reduction on interleaved before/after calls from one run.
