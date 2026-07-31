# Kimi

Muster installs into Kimi Code CLI as native agents and skills. Kimi loads Claude-Code-format definitions, but its runtime contracts differ: model choice is a primary or secondary lane, hooks are not part of the install, and skills surface as slash commands.

## Install

```sh
npx -y @adnova-group/muster@0.6.0 install kimi
```

This invokes the pinned reviewed release through npm and may download and execute package code from the configured registry. Review its provenance and release notes before changing the pin.

The installer writes Muster-owned agents, builtin skills, and the ten mode skills under `$KIMI_CODE_HOME` or `~/.kimi-code`. Mode names use the `muster-` prefix, such as `/muster-plan`, `/muster-go`, `/muster-design`, and `/muster-init`, because Kimi owns names such as `/plan`.

Each installed agent gets a `model_preference` stamp derived from Muster's tier policy. Kimi's per-subagent `model` argument accepts the symbolic lanes `primary` and `secondary`, not concrete provider model IDs. An explicit lane on a new dispatch overrides the installed `model_preference`; without one, Muster derives the agent's stamped lane. Resumed agents retain their existing model. `muster capabilities --kimi` reports the resolved lane and concrete model.

## Support matrix

| Capability | Kimi support |
| --- | --- |
| Ten modes, including Design and Init | Native `muster-`-namespaced skills |
| Agents and builtin skills | Installed natively |
| Parallel dispatch | In-session native subagents; the attended headless process lane is report-only |
| Worktree isolation | Receipts-only harness floor; Muster creates worktrees before write-capable dispatch |
| Action fence | Native marker-delimited `[[permission.rules]]` deny rules |
| Hooks | Hooks-free install |
| Init | No proven callable native Init command; acknowledge the unavailable handoff |
| Model policy | Primary/secondary lane, with optional live model probe |

The native permission block covers the same external action classes as Muster's hook fence: send, sign, submit, publish, purchase, and delete-remote. It is a high-confidence rule set, not a general shell sandbox. Commands or tools outside those patterns still depend on the run brief and review gate.

## Dispatch lanes

Kimi has two distinct dispatch paths:

- **In-session subagents** are the supported execution path for normal and wave-mode work. Their usage belongs to the parent session's `agents` tree, so token accounting uses `kimi-session-usage --session-dir <parent-session-dir>`. A worktree path is not a substitute for the parent session identity.
- **Headless process descriptors** come from `kimi-process-dispatch`. The descriptor records the intended `argv`, environment overrides, working directory, and primary/secondary lane, but it is data only. Do not manually spawn it.

The attended supervisor command `kimi-process-run` is currently **report-only on every platform**. It exits nonzero before process spawn or receipt setup because Muster has no trusted immutable, kernel-bound broker that could retain live process-group authority. Escalate that leg or use the in-session path; do not bypass the refusal.

Files under the dispatch-receipt store are diagnostic observations. They can help explain a PID/start-identity match or mismatch, but they never authorize `SIGTERM`, cleanup, or any other signal. Worktree location is diagnostic too. Persisted same-user files cannot recreate the live authority that a trusted broker would need.

## Probe the model service

```sh
npx -y @adnova-group/muster@0.6.0 install kimi --probe
```

`--probe` performs a read-only models request and compares the served model IDs with Muster's lane policy. It uses the active Kimi service credentials. Skip it when an offline install is required.

## Preview and uninstall

```sh
npx -y @adnova-group/muster@0.6.0 install kimi --dry-run
npx -y @adnova-group/muster@0.6.0 uninstall kimi --dry-run
npx -y @adnova-group/muster@0.6.0 uninstall kimi
```

Dry-run reports the owned-file and permission-rule plan without writing. Uninstall removes only files named by Muster's manifest and its marker-delimited permission block. User agents, skills, and configuration outside that block remain.

For shared tier settings and Kimi-specific environment variables, use [Configuration](/reference/configuration).
