# Codex 0.146 ephemeral-fork benchmark

## Decision

**REJECT production adoption.** Keep Muster's fresh-context subagent lanes and do not add an
app-server dependency for spec-gate, tournament, or read-only review dispatch.

The installed `codex-cli 0.146.0` app-server proved that ephemeral `thread/fork`, ephemeral
`thread/start`, and cursor-exhaustive `thread/list` work. That mechanism proof is not enough to
clear the adoption gate: representative model wall time, input-token deltas, correctness, and
history pollution remain `UNKNOWN`.

PR #174 (`backlog/codex-0146-audit`) was open and backlog-done when this benchmark ran, not merged.
Its 0.146 research informed the protocol, but no commit from that PR was merged or cherry-picked.

## Protocol

The rerunnable harness is `eval/codex-ephemeral-fork-benchmark.mjs`. It uses only Node built-ins and
the installed Codex binary; no production package or app-server client was added.

- Twelve deterministic case definitions: four spec-gates, four tournament decisions, and four
  read-only reviews. Each carries executable-shaped manifest, candidate, or verdict material. The
  harness serializes that material into `developerInstructions` on both members of its matching
  fork/start control-plane pair; it does not carry fabricated lane outputs.
- One minimal seed turn materializes a persisted parent rollout. This is required because the live
  server rejects a fork of an unmaterialized `thread/start` with `no rollout found for thread id`.
- Each case measures one `thread/fork` with `ephemeral: true, excludeTurns: true` and one fresh
  `thread/start` with `ephemeral: true`.
- Two persisted threads under a unique temporary cwd force a `thread/list` walk with `limit: 1`.
  The harness follows opaque `nextCursor` values until `null`, then checks that no ephemeral ID
  appeared in the persisted listing.
- No representative case executes a model turn. Correctness, model-side wall time, input tokens,
  and actual inherited-history pollution are therefore `UNKNOWN`.

Reproduce:

```sh
node --test test/codex-ephemeral-fork-benchmark.test.js
node eval/codex-ephemeral-fork-benchmark.mjs \
  --cwd "$PWD" \
  --out eval/results/codex-ephemeral-fork-benchmark.json
```

## Results

The checked-in run is `eval/results/codex-ephemeral-fork-benchmark.json`.

| Measure | Ephemeral fork | Fresh context | Result |
|---|---:|---:|---|
| Cases | 12 | 12 | Three lanes, four cases each |
| Model correctness | `UNKNOWN` | `UNKNOWN` | No representative model turns |
| Irrelevant inherited turns | `UNKNOWN` | `UNKNOWN` | Fork contents were not model-inspected |
| Model input tokens | `UNKNOWN` | `UNKNOWN` | Threshold cannot pass |
| Model wall time | `UNKNOWN` | `UNKNOWN` | Threshold cannot pass |
| Control-plane mean | 700.207 ms | 679.183 ms | Fork was 3.1% slower in this single run |
| Ephemeral IDs in persisted listing | 0 | 0 | Pass |
| Pagination | 2 pages at `limit: 1` | same listing | Exhausted at `nextCursor: null` |

Control-plane timings are single-run implementation measurements, not model-lane latency and not a
distribution. They are recorded because they are observable, but they do not substitute for the
model wall-time threshold.

## Adoption gate

Every threshold must pass:

| Threshold | Required | Observed | Verdict |
|---|---:|---:|---|
| Representative cases | at least 10 | 12 | PASS |
| Model wall-time reduction | at least 10% | `UNKNOWN` | FAIL |
| Model input-token reduction | at least 10% | `UNKNOWN` | FAIL |
| Correctness delta versus fresh | at least 0 | `UNKNOWN` | FAIL |
| History-pollution delta | at most 0 turns | `UNKNOWN` | FAIL |
| Ephemeral persistence leaks | 0 | 0 | PASS |

The decision is fail-closed: an `UNKNOWN` cannot satisfy a numeric threshold. A future pilot may
reopen adoption only if it executes representative model turns under a bounded token budget,
captures comparable completion usage and wall time for both lanes, and measures correctness plus
inherited-history pollution from the resulting model-visible contexts.
