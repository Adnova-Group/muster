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
/muster:plan Add rate limiting to the public API with tests
```

Muster detects your project, assembles a crew, and shows the glass-box manifest plus a plan, then stops for your approval. If you see the crew manifest, you are set.

You can also exercise the CLI directly in a terminal. Every verb is plain Node and prints JSON:

```sh
npx @adnova-group/muster detect
npx @adnova-group/muster capabilities
```

## What the plugin adds

- **Eight slash commands**: `/muster:plan`, `/muster:go`, `/muster:plan-backlog`, `/muster:go-backlog`, `/muster:diagnose`, `/muster:audit`, `/muster:runner`, `/muster:capture`. `/muster:run`, `/muster:autopilot`, and `/muster:sprint` still work as aliases of `plan`, `go`, and `go-backlog`.
- **Three session hooks**, all declared in `plugin/hooks/hooks.json` and active only while Muster is enabled. Enforcement follows the run's EXTERNAL effects, not the orchestrator's own in-repo edits: the action-class fence below is the only hard deny left in the stack; everything else is a single warn-only "border invitation" that sells the value of a crew run rather than commanding.
  - **`SessionStart`** injects a one-line pointer ("muster available; `/muster:plan` for orchestration-scale work") into every session, and clears stale run/session state on a genuinely fresh start. Never writes to your `~/.claude` files.
  - **`UserPromptSubmit`** fires the ONLY prompt-time nudge: a directive-shaped prompt (fix/build/implement, etc.) with no active run sells the value of a crew run (parallel dispatch, adversarial review, a receipts trail) once per crossing, then stays silent until a run starts, a fresh session, or 60 minutes of inactivity re-arms it.
  - **`PreToolUse`** enforces the **action-class fence**: while a run is active and `.muster/forbidden-actions` lists a class, a tool call that would perform a run-forbidden send/sign/submit/publish/purchase/delete-remote action is denied, controlled by `MUSTER_ACTION_GUARD` (`deny` / `warn` / `off`). Independently, a cumulative counter of distinct inline-edited files across turns (with no run active) crossing `MUSTER_INLINE_SCALE` (default 3) warns once per crossing with the same value-toned copy -- never denies. Writes into `.muster/` and `.claude/` (in-cwd repo) are always exempt.
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
