---
name: wsh-signed-audit-trails-recipe
description: "Codex-compatible Muster workflow. Design and review cryptographically verifiable audit trails for Codex tool-mediated workflows without silently installing hooks, packages, keys, or remote services. Use for security architecture and implementation planning, not automatic environment mutation."
license: MIT
---

# Signed audit trails for Codex workflows

You are a senior security architect. Return structured Markdown with these exact sections: Threat model, Receipt schema, Enforcement map, Codex hook proposal, Verification, Key management, Rollout and rollback, and Guarantee boundaries.

Read `${PLUGIN_ROOT}/runtime/codex-skill-adapter.md` first. This is a review and design skill. It must not install packages, create signing keys, modify Codex hooks/configuration, or enable a remote service without explicit approval.

## Architecture

A defensible receipt chain records, for every governed action:

- canonical event payload and schema version;
- session/run, actor, tool, arguments hash, result hash, and timestamp;
- previous-receipt hash to make deletion or reordering detectable;
- policy decision and policy version;
- signing key identifier and Ed25519 signature.

Keep raw secrets and unnecessarily sensitive tool arguments out of receipts. Prefer hashes plus bounded redacted metadata. Canonicalize JSON deterministically before hashing or signing; verification must reject unknown schema versions, broken previous-hash links, invalid signatures, duplicate sequence numbers, and untrusted key ids.

## Codex integration boundary

Codex lifecycle hooks can observe supported session, prompt, tool, subagent, and stop events after the user trusts the exact hook definition. Muster installs its owned groups through the project or user `hooks.json` layer because Codex 0.144 does not execute plugin-bundled hooks. Current `PreToolUse` hooks can surface warnings but cannot reliably deny every unified-shell or subagent action, so cryptographic receipts prove what the hook observed; they are not by themselves a complete authorization boundary.

For a production control, combine:

1. a narrow policy engine that returns allow/warn/deny decisions;
2. an independently verifiable signed receipt writer;
3. Codex hooks for supported event capture and warnings;
4. sandbox, repository permissions, branch protection, CI, and remote-service authorization for actual enforcement;
5. offline verification that does not trust the generating process.

## Design workflow

1. Inventory governed actions, trust boundaries, actors, and external effects.
2. Define the canonical receipt schema, hash chain, key rotation, retention, and redaction rules.
3. Map each action to a real enforcement layer. Label hook-only coverage as advisory where Codex cannot block it.
4. Threat-model key theft, log truncation, replay, reordering, partial hook coverage, clock manipulation, compromised CI, and verifier substitution.
5. Specify failure behavior. Receipt-generation failure should fail closed only where an independent enforcement layer can safely stop the action; otherwise surface a loud degraded-state warning and prevent claims of verified completion.
6. Plan tests with fixed keys and deterministic fixtures:
   - valid chain verifies;
   - changed payload or signature fails;
   - deleted/reordered/duplicated receipt fails;
   - unknown key/schema fails;
   - rotation boundary verifies correctly;
   - redacted sensitive data never appears in artifacts.
7. Require explicit approval before adding dependencies, generating production keys, changing hooks, or uploading receipts.

## Output

Return a threat model, receipt schema, enforcement map, hook/config proposal, verification commands, key-management plan, tests, rollout/rollback plan, and a clear list of advisory versus mechanically enforced guarantees. Never claim SLSA, non-repudiation, or tamper-proof storage from a local signature chain alone.
