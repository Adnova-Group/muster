# Dispatch brief — muster-runner (one claimed item)

ITEM: retry-flaky-upload
OUTCOME: Retries for the flaky upload endpoint — exponential backoff with jitter, max 3 attempts. Success criteria: a unit test covers 3-attempt exhaustion; 4xx responses are never retried.
ISOLATION: worktree .worktrees/retry-flaky-upload on branch item/retry-flaky-upload, base main @ 1a2b3c4
DISPOSITION: pr
SOURCE: backlog.md#retry-flaky-upload

RETURN CONTRACT: item id + PR URL (or the blocker), files touched (one line each), test
commands with pasted baseline + final results, the review gate's final `VERDICT: PASS`
line with its fix-loop count, assumptions/deviations. <= 2000 chars.
