# Codex Code Mode inner-loop benchmark

## Decision

**REJECT production adoption on this host.** Retain Muster's current crew-member tool-call path.
Code Mode must remain inside mechanical investigator/evidence inner loops if a later host clears the
gate; it must never become the wave-orchestration mechanism.

The checked-in probe used `codex-cli 0.146.0` with the default active configuration and no feature
override. `codex features list` reported `code_mode` as `under development / false` and
`code_mode_host` as `stable / true`. The stable host process is infrastructure, not evidence that the
Code Mode feature is stable and enabled. The local model catalog advertised `code_mode_only` for
four models. That mode is also unusable as a control: model metadata wins over a feature override,
so disabling `code_mode` cannot turn a `code_mode_only` model into a direct-tool model.

## Protocol

The rerunnable gate is `eval/codex-code-mode-inner-loop-benchmark.mjs`; the ten deterministic,
commit-pinned gold cases are in `eval/fixtures/codex-code-mode-inner-loop-cases.json`.

- Five investigator cases cover mechanical locate/map work.
- Five evidence cases cover deterministic collection and aggregation work.
- On a stable host, the harness itself runs both paths on every pinned case. It measures wall time,
  derives input usage from Codex JSONL events, scores the schema-constrained answer against the gold
  result, and records the event-stream digest, model, commit, feature override, and answer. Pair
  execution order alternates to counterbalance warm-cache bias; each turn has a three-minute cap.
- The report computes p50 and p95 for latency and input tokens. Adoption requires at least ten
  completed pairs, zero correctness regressions, and at least 20% lower median latency **or** input
  tokens.
- The capability probe must see `code_mode` itself as both `stable` and enabled, plus an eligible
  same-model candidate whose catalog `tool_mode` is switchable `code_mode`, not `code_mode_only`.
  Every measured execution must then expose the expected effective tool identity in its JSONL events:
  `code_mode` for the candidate and `direct_tools` for the control. A missing, equivalent, or reversed
  identity discards the measurements, rejects adoption, and records `MODE_IDENTITY_UNVERIFIED`.
  Unsupported hosts execute zero pairs and retain the current path.
- The benchmark excludes collaboration and wave dispatch. It evaluates only inner-loop mechanics.

Reproduce the unsupported-host evidence:

```sh
node --test test/codex-code-mode-inner-loop-benchmark.test.js
node eval/codex-code-mode-inner-loop-benchmark.mjs \
  --out eval/results/codex-code-mode-inner-loop-benchmark.json
```

On a future stable host, the same command executes all twenty bounded turns (ten Code Mode and ten
current-path controls) only when a switchable same-model candidate exists. The gate deliberately
does not force-enable an under-development feature, treat `code_mode_only` as a direct-tool control,
accept externally supplied metrics, or manufacture model-turn measurements.

## Results

The checked-in result is `eval/results/codex-code-mode-inner-loop-benchmark.json`.

| Measure | Code Mode | Current path | Result |
|---|---:|---:|---|
| Defined paired cases | 10 | 10 | Five investigator + five evidence |
| Executed paired cases | 0 | 0 | Stable Code Mode unavailable |
| Latency p50 / p95 | `UNKNOWN` | `UNKNOWN` | Not measured |
| Input tokens p50 / p95 | `UNKNOWN` | `UNKNOWN` | Not measured |
| Correctness regressions | `UNKNOWN` | — | Not measured |
| Production adoption | rejected | retained | Fail-closed fallback |

No paired case was run because the brief permits bounded pairs only when stable Code Mode is
available. Consequently the 20% improvement and zero-regression gates are not satisfied; an
`UNKNOWN` never passes a numeric threshold.
