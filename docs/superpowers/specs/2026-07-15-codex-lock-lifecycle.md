# Shared Codex lock lifecycle

## Decision

`withCodexFileLock` is the sole exported asynchronous lock-lifecycle entry point. It owns exclusive `0600` creation and failed-write cleanup, no-follow inode-bound reads, stale reclaim, quarantine, private `0700` retirement, restoration, final owner revalidation, unlink, heartbeat, retry, and release. Consumer callbacks may define records and policy; they cannot perform lifecycle filesystem mutations.

The shared implementation accepts six explicit policy boundaries:

- `recordPolicy` creates, parses, and compares complete owner records.
- `pathPolicy` validates consumer-specific ancestry before lifecycle access.
- `stalePolicy` defines age and soft/hard expiry durations; PID and process-start identity evaluation remains shared.
- `recoveryPolicy` optionally serializes reclaim through a sentinel using the same lifecycle with recursive recovery disabled.
- `retryPolicy` chooses elapsed timeout/backoff or bounded attempts/fixed delay.
- `releasePolicy` chooses whether missing or changed owners are ignored or rejected.

Heartbeat, record-size bounds, diagnostics, retirement-mode capability, and the four race hooks remain explicit options. Malformed transaction records continue to fail closed because an owner cannot be bound; the previous comment claiming they became reclaimable was inaccurate. Failed exclusive writes are now removed by the shared primitive so a partial record is never left by a live failed acquisition.

## Consumer contracts

Transaction locks keep loose JSON parsing, a 16 KiB bound, mtime-only age, 60-second soft expiry, 15-minute hard expiry, elapsed 30-second retry with existing backoff, heartbeat, and permissive missing/changed-owner handling before the release race hook.

Managed-scope locks keep strict `format: 1` and `owner: "muster"` parsing, full owner comparison, ordinary configuration ancestry, no practical record-size limit, `max(createdAt, mtime)` age, five-minute soft expiry, 15-minute hard expiry, no heartbeat, exactly 1,000 attempts by default at 10 ms, strict release errors, and `.recover` serialization. The recovery sentinel uses the same shared lifecycle without recursive recovery; sentinel reclaim suppresses main-lock quarantine/validation hooks but retains retirement hooks and guaranteed release.

## Security invariants

Every destructive operation is preceded by inode and full-owner binding and followed by validation inside an inode-bound private retirement directory. A changed retirement directory, weak permissions, replaced quarantine file, replaced owner, symlink, or ambiguous restoration state fails closed. The final owner check immediately before unlink is mandatory and is mutation-tested through the managed-scope `afterRetirement` replacement case.
