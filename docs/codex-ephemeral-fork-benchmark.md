# Codex 0.146 ephemeral-fork model benchmark

## Decision

**REJECT production adoption.** Keep Muster's fresh-context subagent lanes and do not add an
app-server dependency for spec-gate, tournament, or read-only review dispatch.

The completed 12-pair run used the installed `codex-cli 0.146.0`, the app-server catalog's default
`gpt-5.6-sol` model from provider `openai`, low reasoning effort, and a 120-second per-turn timeout.
Both lanes scored 12/12 correct and ephemeral threads had zero persistence leaks. The fork lane was
12.8% faster at p50, but it consumed 23.591% more p50 input tokens and inherited the parent turn in
all 12 cases. The inherited-history and token thresholds therefore fail.

No production routing or dependency changed.

## Protocol

The rerunnable harness is `eval/codex-ephemeral-fork-benchmark.mjs`. It uses only Node built-ins and
the installed Codex binary.

- Twelve deterministic cases cover four spec gates, four tournament decisions, and four read-only
  reviews. Exact answer equality against each fixture's expected value is the correctness score.
- One persisted parent executes a seed turn containing a unique history sentinel. Each ephemeral
  fork inherits that parent; each matched ephemeral fresh thread starts without it.
- Every pair receives the same bounded evaluator instructions, case material, JSON output schema,
  model, reasoning effort, approval policy, sandbox, and timeout. Pair execution order alternates by
  case to reduce order bias.
- Each model turn records end-to-end wall time and the app-server
  `thread/tokenUsage/updated.tokenUsage.last` input-token receipt. Aggregate p50/p95 values use the
  nearest-rank method.
- History pollution has two checks: the number of turns returned on fork/start and the model's
  structured report of whether the earlier sentinel is visible. Every fork returned one inherited
  turn and reported the sentinel; every fresh thread returned zero and reported no sentinel.
- Two persisted sentinel threads force `thread/list` pagination at `limit: 1`. The harness exhausts
  opaque cursors, verifies both persistent IDs are found, and asserts that no ephemeral ID appears.
- Any missing model catalog entry, failed turn, invalid structured answer, absent numeric input-token
  receipt, pagination omission, or cleanup error makes the run fail without writing partial evidence.

Reproduce:

```sh
node --test test/codex-ephemeral-fork-benchmark.test.js
node eval/codex-ephemeral-fork-benchmark.mjs \
  --cwd "$PWD" \
  --effort low \
  --turn-timeout-ms 120000 \
  --out eval/results/codex-ephemeral-fork-benchmark.json
```

The checked-in run was generated at `2026-08-01T19:33:01.403Z`. Passing `--model` pins a requested
catalog model; omitting it, as in the checked-in run, resolves the catalog default and records the
resolved model before any benchmark thread starts.

## Results

The complete per-case receipts, including pair order, wall time, input/cached/output tokens,
structured model answer, exact correctness, sentinel visibility, inherited-turn count, and turn ID,
are in `eval/results/codex-ephemeral-fork-benchmark.json`.

| Measure | Ephemeral fork | Fresh context | Difference |
|---|---:|---:|---:|
| Cases | 12 | 12 | 0 |
| Wall time p50 | 4,261.151 ms | 4,886.636 ms | fork 12.8% faster |
| Wall time p95 | 7,207.541 ms | 7,069.603 ms | fork 1.951% slower |
| Input tokens p50 | 21,846 | 17,676 | fork 23.591% more |
| Input tokens p95 | 21,872 | 17,688 | fork 23.654% more |
| Correctness | 12/12 (100%) | 12/12 (100%) | 0 points |
| Sentinel visible | 12/12 | 0/12 | fork polluted in every pair |
| Inherited history turns, total | 12 | 0 | +12 fork turns |
| Ephemeral IDs in persisted listing | 0 | 0 | PASS |

The persisted listing read two pages at `limit: 1`, found both persistent control threads, and
exhausted at `nextCursor: null`.

## Adoption gate

Every threshold must pass:

| Threshold | Required | Observed | Verdict |
|---|---:|---:|---|
| Representative cases | at least 10 | 12 | PASS |
| Model wall-time reduction (p50) | at least 10% | 12.8% | PASS |
| Model input-token reduction (p50) | at least 10% | -23.591% | FAIL |
| Correctness delta versus fresh | at least 0 | 0 | PASS |
| History-pollution delta | at most 0 turns | +12 turns | FAIL |
| Ephemeral persistence leaks | 0 | 0 | PASS |

The p50 latency benefit is not enough to offset materially higher input usage and deterministic
proof that the parent turn remains model-visible. A future benchmark should reopen adoption only
after a native fork mode can exclude model-visible history while retaining the latency benefit.
