# Install

Muster has two parts that install together: a deterministic CLI (an npm package) and a Claude Code plugin. The CLI does the routing math; the plugin teaches Claude Code how to drive a run.

## Requirements

- [Claude Code](https://claude.com/claude-code)
- Node.js 20 or newer (`node --version`)

Muster runs on your interactive Claude Code subscription. There is no separate model API, no runtime to deploy, and no key to manage.

## 1. Run the installer

```sh
npx @adnova-group/muster install
```

`install` mutates nothing in your `~/.claude`. It only prints the steps it cannot do for you, because registering a plugin is a Claude Code action, not a shell command.

## 2. Register the plugin

Run these inside Claude Code:

```sh
/plugin marketplace add Adnova-Group/muster   # register the marketplace
/plugin install muster@muster                 # install the plugin
```

Muster's glass-box output style ships **inside the plugin** and applies automatically when the plugin is enabled (it sets `force-for-plugin: true`), so there is no style command to run. The old `/output-style <name>` command was removed from Claude Code in v2.1.91; auto-apply replaces it. To pick a different style at any time, use `/config` and select **Output style**.

::: tip Restart to activate
Plugin install is a Claude Code action, so the running session only picks Muster up after you (re)install it through `/plugin`. The plugin's agents, the four session hooks, and the output style become active in your next fresh session (restart or `/clear`).
:::

## 3. Verify

Start a new Claude Code session and run:

```sh
/muster:plan Add rate limiting to the public API with tests
```

Muster detects your project, assembles a crew, and shows the glass-box manifest plus a plan, then stops for your approval. If you see the crew manifest, you are set.

## Codex CLI and Desktop

From a project visible to both WSL and Windows, run `muster install codex --scope project`. The supported flow installs 27 profiles, 12 public skills plus 62 resolver-loaded internal skills, and 21 MCP tools. It also raises `[agents] max_threads` to at least 12 and `max_depth` to at least 2 in every detected CLI/Desktop global `config.toml`, without lowering higher values or rewriting unrelated settings.

Verify with `muster doctor --codex`. A split-state result includes an exact recovery command for each stale project or user scope. Refresh a WSL user scope with `CODEX_HOME="$HOME/.codex" muster install codex --scope user`; refresh the Windows Desktop user scope by running `muster install codex --scope user` in PowerShell. Refresh a project/worktree scope from that project directory, or run the matching uninstall there if the scope is intentionally retired. Restart Codex CLI and Desktop after recovery.

You can also exercise the CLI directly in a terminal. Every verb is plain Node and prints JSON:

```sh
npx @adnova-group/muster detect
npx @adnova-group/muster capabilities
```

## What the plugin adds

- **Eight slash commands**: `/muster:plan`, `/muster:go`, `/muster:plan-backlog`, `/muster:go-backlog`, `/muster:diagnose`, `/muster:audit`, `/muster:runner`, `/muster:capture`. `/muster:run`, `/muster:autopilot`, and `/muster:sprint` still work as aliases of `plan`, `go`, and `go-backlog`.
- **Four session hooks**, all declared in `plugin/hooks/hooks.json` and active only while Muster is enabled:
  - **`SessionStart`** prepends Muster's working principles, the seven verbs, a routing-policy reminder, and a one-line project detect to every session. Never writes to your `~/.claude` files. (Capture is deliberately not among the routed seven -- it is a backlog generator, not an outcome-runner.)
  - **`UserPromptSubmit`** injects periodic drift-reinforcement nudges (every `MUSTER_NUDGE_EVERY` turns) and full principle reminders (every `MUSTER_NUDGE_EVERY * MUSTER_PRINCIPLES_EVERY` turns) so sessions stay on-model after compaction or long runs. A directive-shaped prompt (fix/build/implement, etc.) with no active run also fires the routing-policy reminder immediately the first time it lands -- once per session, independent of the periodic cadence -- until `/clear` re-arms it. Every nudge tier also carries a one-line voice reminder (terse, decision-first, no recaps) so output style doesn't drift the way routing does.
  - **`PreToolUse`** enforces three gates. While a wave is active (`.muster/wave-active` present), file writes from the orchestrator main loop are blocked, with behaviour controlled by `MUSTER_WAVE_GUARD` (`deny` / `warn` / `off`). After a run ends (no wave marker), a per-turn post-run scale gate (`MUSTER_INLINE_SCALE`, default 3) denies the Nth distinct inline file write in a single turn and routes it to a verb instead -- closing the drift window the advisory nudge alone cannot hold. A cumulative counter also tracks distinct inline-edited files across turns, warning once per session (never denying) when the running total reaches the same threshold, so drift spread thinly across many turns doesn't go unnoticed. Independently of wave state, an **action-class fence** denies a tool call that would perform a run-forbidden send/sign/submit/publish/purchase/delete-remote action (declared via the manifest's `forbiddenActions`), controlled by `MUSTER_ACTION_GUARD` (`deny` / `warn` / `off`). Writes into `.muster/` and `.claude/` (in-cwd repo) are always exempt so orchestrator bookkeeping and repo-local settings are never blocked.
  - **`PreToolUse` on `Task`/`Agent`** enforces the todo-driving gate. During a live run (`.muster/run-active` present), a subagent-wave dispatch is denied unless a native todo list was written since the run started, so plan progress stays visible in Claude Code's todo UI. Controlled by `MUSTER_TODO_GATE` (`deny` / `warn` / `off`); biased hard toward allow -- any uncertainty allows.
- **Built-in agents and skills**, vendored from MIT-licensed upstreams plus Muster's own clean-room specialists.

## Uninstall

Because everything Muster adds lives **inside the plugin**, removal is mostly a matter of removing the plugin. Muster never writes to your `~/.claude/CLAUDE.md` or `settings.json`, so there is nothing tangled to unpick.

```sh
npx @adnova-group/muster uninstall
```

`uninstall` prints the steps it cannot do for you, because removing a plugin is a Claude Code action:

```sh
/plugin uninstall muster@muster    # remove the plugin (and its style + hook)
/plugin marketplace remove muster  # remove the marketplace
```

It also cleans up after older Muster versions: if a pre-`force-for-plugin` install left a copied style at `~/.claude/output-styles/muster.md`, `uninstall` removes it (and restores the original it had displaced, if there is a `.bak`). On a current install there is nothing there to remove.

::: tip Everything leaves with the plugin
The output style (`force-for-plugin`) and all four session hooks are plugin-native, so uninstalling the plugin removes them automatically. The forced style auto-reverts to whatever output style you had before. There is no global file or `CLAUDE.md` block to clean up by hand.
:::

Next: the [Quickstart](/guides/quickstart).
