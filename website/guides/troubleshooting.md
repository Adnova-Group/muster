# Troubleshooting

Almost every first-run failure is one command away from an answer:

```sh
npx @adnova-group/muster doctor
npx @adnova-group/muster doctor --codex
```

`doctor` is **read-only**. It reads the catalog, the pipelines, the installed plugin, and (on `--codex`) the managed Codex scopes, then reports. It never repairs, never writes, and never touches your `~/.claude` or `$CODEX_HOME` files. The fix is always a command you run afterwards.

## Reading doctor output

Output is `{ ok, checks }`, one entry per check:

```json
{ "name": "codex-thread-limits", "ok": true, "detail": "max_threads=12, max_depth=2 at ~/.codex/config.toml meet the Muster floor (>=12/>=2)" }
```

- **`name`** — the check id. There is no severity axis; a check either passes or it does not.
- **`ok: false`** is a red. It is always actionable: `detail` names the offending **path or scope** and the **remediation command**, in that order.
- **Exit code** is `0` when every check passes and `2` when any check fails, so `doctor` drops straight into CI or a pre-flight script.

A red is not always a broken install. `vendor-note-staleness` reports itself skipped when the remote check is unavailable offline, and `codex-path-shadow` deliberately fails **open** if its own probe errors, rather than failing the run incoherently.

## Symptoms

### The plugin is not picked up after install

Claude Code binds plugins **at session start**. A `/plugin install` in a running session does not retrofit into that session.

```sh
/plugin install muster@muster
```

Then **restart Claude Code or `/clear`**. The slash commands, the agents, the session hooks, and the forced output style all become active in the next fresh session. If they are still missing after a restart, run `muster doctor` and read `install-integrity` and `plugin-staleness`.

### An agent is not dispatchable, or a named profile is missing

A task that fails closed with a reinstall/new-session diagnostic means the running session's agent registry does not carry that `subagent_type` — usually because the plugin's agents were installed *after* the session started. Muster never silently falls back to a generic subagent there, because that would lose the pinned role and model policy.

Reinstall, then start a new session:

```sh
npx @adnova-group/muster install     # Claude Code
npx @adnova-group/muster install codex --scope project   # Codex
```

`doctor`'s `install-integrity` check confirms the plugin cache copy actually landed — a missing cache directory, or one without `hooks/hooks.json`, means the copy silently failed even though the version string still looks healthy. No check enumerates individual agent profiles, so if `install-integrity` is green the profile is on disk and the problem is session binding: only a fresh session makes it dispatchable.

### A stale `muster` on `PATH` is shadowing this package

A leftover global install (`npm i -g`) sits earlier on `PATH` than the copy you meant to run, so a bare `muster` silently serves outdated behavior — including missing verbs entirely.

```sh
npx @adnova-group/muster doctor --codex
```

The `codex-path-shadow` check names the exact file and what owns it. It establishes that identity by **reading the file and its sibling `package.json`** — it never executes the shadow. Remediation:

```sh
npm uninstall -g @adnova-group/muster
# or, to keep a global copy current:
npm i -g @adnova-group/muster@latest
```

### Codex scopes disagree, hooks are incoherent, or trust entries are stale

`doctor --codex` names the failing **scope** (the project `.codex` or the user `$CODEX_HOME` directory) and a normalized **cause** for each:

| Check | Reports |
| --- | --- |
| `codex-install-generation` | Installed profiles do not match the selected package version, or a pre-0.5.x manifest is still in place. |
| `codex-hooks` | Managed lifecycle hooks are stale or differ from their exact ownership manifest (runtime hash mismatch). |
| `codex-hooks-overlap` | More than one scope fires coherent hooks, so every advisory is emitted once per scope. |
| `codex-hook-interpreter` | The absolute Node interpreter pinned into the hook command no longer exists (a pruned nvm install, typically). |
| `codex-hook-state` | Codex's `config.toml` `[hooks.state]` retains stale or case-duplicate Muster hook trust entries. |
| `codex-plugin-cache-hooks` | The installed plugin cache ships firing hooks — the with-hooks Claude flavor, which would double-fire on top of the scoped install. |

All six reconcile the same way:

```sh
npx @adnova-group/muster install codex --scope user      # canonical for hooks
npx @adnova-group/muster install codex --scope project
```

Rerunning the project scope under a healthy user scope collapses to one firing scope — see [the canonical-scope hook collapse](/guides/codex#the-canonical-scope-hook-collapse).

### A subagent may not have run on the model its profile pins

Codex can silently let a spawned thread inherit the orchestrator's model instead of the profile's pin. That is invisible during the run, so it is audited afterwards against Codex's own rollout records:

```sh
npx @adnova-group/muster codex-conformance --days 3
```

Each spawned thread gets a verdict: `MATCH`, `MISMATCH`, `GENERIC` (no role recorded — the inheritance signature), `NO-PIN`, or `IDLE`. It exits `2` on any actionable mismatch. A range that crosses a profile retier legitimately contains historical mismatches; those rows are stamped `pinsNewerThanRollout`, and `--current-pins-only` excludes them from the **exit-code decision only** — the rows are always listed either way.

### A dead run stranded machine state

A crashed or killed run can leave provider processes, git worktrees, and backlog claims behind.

```sh
npx @adnova-group/muster hygiene           # report only
npx @adnova-group/muster hygiene --reap    # act
```

`hygiene` reports three things: orphaned `codex`/`claude` processes, live worktrees over the threshold (default 10) plus git-prunable candidates, and `.muster/backlog.md` claims whose heartbeat is stale (default 60 minutes).

Report-only is the default. `--reap` opts into exactly two actions: `SIGTERM` to processes already flagged reap-eligible (orphaned parent — a merely old process with a live parent is never killed on age alone), and rewriting the backlog to release stale claims. **Worktrees are never deleted**, with or without `--reap`; removing them stays a human decision.

## Still stuck

- A setting that seems to have no effect: check it against the [Configuration reference](/reference/configuration) — several variables fail closed to their default on an unrecognized value.
- A Codex-specific install question: see the [Codex guide](/guides/codex).
- Anything else: [open an issue](https://github.com/Adnova-Group/muster/issues) and paste the full `doctor` output.
