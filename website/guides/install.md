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
Plugin install is a Claude Code action, so the running session only picks Muster up after you (re)install it through `/plugin`. The plugin's agents, the three session hooks, and the output style become active in your next fresh session (restart or `/clear`).
:::

## 3. Verify

Start a new Claude Code session and run:

```sh
/muster:run Add rate limiting to the public API with tests
```

Muster detects your project, assembles a crew, and shows the glass-box manifest plus a plan, then stops for your approval. If you see the crew manifest, you are set.

You can also exercise the CLI directly in a terminal. Every verb is plain Node and prints JSON:

```sh
npx @adnova-group/muster detect
npx @adnova-group/muster capabilities
```

## What the plugin adds

- **Five slash commands**: `/muster:run`, `/muster:autopilot`, `/muster:diagnose`, `/muster:audit`, `/muster:sprint`.
- **Four session hooks**, all declared in `plugin/hooks/hooks.json` and active only while Muster is enabled:
  - **`SessionStart`** prepends Muster's working principles, the four verbs, a routing-policy reminder, and a one-line project detect to every session. Never writes to your `~/.claude` files.
  - **`UserPromptSubmit`** injects periodic drift-reinforcement nudges (every `MUSTER_NUDGE_EVERY` turns) and full principle reminders (every `MUSTER_NUDGE_EVERY * MUSTER_PRINCIPLES_EVERY` turns) so sessions stay on-model after compaction or long runs. A directive-shaped prompt (fix/build/implement, etc.) with no active run also fires the routing-policy reminder immediately the first time it lands -- once per session, independent of the periodic cadence -- until `/clear` re-arms it.
  - **`PreToolUse`** enforces two gates. While a wave is active (`.muster/wave-active` present), file writes from the orchestrator main loop are blocked, with behaviour controlled by `MUSTER_WAVE_GUARD` (`deny` / `warn` / `off`). After a run ends (no wave marker), a per-turn post-run scale gate (`MUSTER_INLINE_SCALE`, default 3) denies the Nth distinct inline file write in a single turn and routes it to a verb instead -- closing the drift window the advisory nudge alone cannot hold. A cumulative counter also tracks distinct inline-edited files across turns, warning once per session (never denying) when the running total reaches the same threshold, so drift spread thinly across many turns doesn't go unnoticed. Writes into `.muster/` and `.claude/` (in-cwd repo) are always exempt so orchestrator bookkeeping and repo-local settings are never blocked.
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
The output style (`force-for-plugin`) and all three session hooks are plugin-native, so uninstalling the plugin removes them automatically. The forced style auto-reverts to whatever output style you had before. There is no global file or `CLAUDE.md` block to clean up by hand.
:::

Next: the [Quickstart](/guides/quickstart).
