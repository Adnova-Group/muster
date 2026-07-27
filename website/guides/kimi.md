# Kimi

Muster installs into Kimi Code CLI as native agents and skills. Kimi loads Claude-Code-format definitions, but its runtime contracts differ: model choice is a primary or secondary lane, hooks are not part of the install, and skills surface as slash commands.

## Install

```sh
npx -y @adnova-group/muster install kimi
```

The installer writes Muster-owned agents, builtin skills, and the nine mode skills under `$KIMI_CODE_HOME` or `~/.kimi-code`. Mode names use the `muster-` prefix, such as `/muster-plan`, `/muster-go`, and `/muster-init`, because Kimi owns names such as `/plan`.

Each installed agent gets a `model_preference` stamp derived from Muster's tier policy. Kimi does not offer a per-subagent model argument, so the stamp binds an agent to the configured primary or secondary lane. `muster capabilities --kimi` reports the resolved lane and concrete model.

## Support matrix

| Capability | Kimi support |
| --- | --- |
| Nine modes | Native `muster-`-namespaced skills |
| Agents and builtin skills | Installed natively |
| Parallel dispatch | Kimi process dispatch, with sequential fallback |
| Worktree isolation | Receipts-only harness floor; Muster creates worktrees before write-capable dispatch |
| Action fence | Native marker-delimited `[[permission.rules]]` deny rules |
| Hooks | Hooks-free install |
| Init | No proven callable native Init command; acknowledge the unavailable handoff |
| Model policy | Primary/secondary lane, with optional live model probe |

The native permission block covers the same external action classes as Muster's hook fence: send, sign, submit, publish, purchase, and delete-remote. It is a high-confidence rule set, not a general shell sandbox. Commands or tools outside those patterns still depend on the run brief and review gate.

## Probe the model service

```sh
npx -y @adnova-group/muster install kimi --probe
```

`--probe` performs a read-only models request and compares the served model IDs with Muster's lane policy. It uses the active Kimi service credentials. Skip it when an offline install is required.

## Preview and uninstall

```sh
npx -y @adnova-group/muster install kimi --dry-run
npx -y @adnova-group/muster uninstall kimi --dry-run
npx -y @adnova-group/muster uninstall kimi
```

Dry-run reports the owned-file and permission-rule plan without writing. Uninstall removes only files named by Muster's manifest and its marker-delimited permission block. User agents, skills, and configuration outside that block remain.

For shared tier settings and Kimi-specific environment variables, use [Configuration](/reference/configuration).
