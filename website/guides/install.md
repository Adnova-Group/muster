# Install

Muster has two parts that install together: a deterministic CLI (an npm package) and a Claude Code plugin. The CLI does the routing math; the plugin teaches Claude Code how to drive a run.

## Requirements

- [Claude Code](https://claude.com/claude-code)
- Node.js 20 or newer (`node --version`)

Model work uses the account or subscription of the active Claude Code session. Muster's CLI makes no model calls, so there is no separate model API, hosted runtime, or key to manage.

## 1. Run the installer

```sh
npx -y @adnova-group/muster@0.7.1 install
```

`install` mutates nothing in your `~/.claude`. It only prints the steps it cannot do for you, because registering a plugin is a Claude Code action, not a shell command.

## 2. Register the plugin

Run these inside Claude Code:

```sh
/plugin marketplace add Adnova-Group/muster   # register the marketplace
/plugin install muster@muster                 # install the plugin
```

Muster's glass-box output style ships **inside the plugin** but is not forced: a session keeps your own style unless you choose otherwise. To use it, open `/config`, select **Output style**, and pick **Muster**. (The old `/output-style <name>` command was removed from Claude Code in v2.1.91.)

::: tip Restart to activate
Plugin install is a Claude Code action, so the running session only picks Muster up after you (re)install it through `/plugin`. The plugin's agents, its two run-scoped hooks, and the selectable output style become available in your next fresh session (restart or `/clear`).
:::

::: tip Using another runtime?
Codex and Cowork have their own install and enforcement paths. Start with [Harness support](/guides/harnesses).
:::

## 3. Verify

Start a new Claude Code session and run:

```sh
/muster:plan Add rate limiting to the public API with tests
```

Muster detects your project, assembles a crew, and shows the glass-box manifest plus a plan, then stops for your approval. If you see the crew manifest, you are set.

You can also exercise the CLI directly in a terminal. Every verb is plain Node and prints JSON:

```sh
npx -y @adnova-group/muster detect
npx -y @adnova-group/muster capabilities
```

If the crew manifest does not appear, or `/muster:*` commands are missing, run `npx -y @adnova-group/muster doctor` and see [Troubleshooting](/guides/troubleshooting).

## What the plugin adds

Claude Code exposes all ten modes, including Design and Init.

- **Ten slash-command modes**: `/muster:plan`, `/muster:go`, `/muster:plan-backlog`, `/muster:go-backlog`, `/muster:diagnose`, `/muster:audit`, `/muster:design`, `/muster:runner`, `/muster:capture`, and `/muster:init`.
- **Two run-scoped hooks**, both declared in `plugin/hooks/hooks.json` and active only while Muster is enabled. Neither fires on session start or on a prompt, and nothing nudges you toward a verb: Muster costs nothing in a session that never invokes it. Enforcement follows the run's EXTERNAL effects, not the orchestrator's own in-repo edits.
  - **`PreToolUse`** (matcher `Bash|PowerShell|mcp__.*`) enforces the **action-class fence**: while a run is active and `.muster/forbidden-actions` lists a class, every payload is classified and a tool call that would perform a run-forbidden send/sign/submit/publish/purchase/delete-remote action is denied, controlled by `MUSTER_ACTION_GUARD` (`deny` / `warn` / `off`). A verb writes `.muster/run-active` when its run starts and removes it when the run ends; if an interrupted run leaves it behind, the next run overwrites it, or delete it by hand.
  - **`TaskCompleted`** is the second block surface. Muster writes `.muster/task-board.json` (one entry per native task it created) and flips an entry to `reviewGate: "pass"` only once the review gate actually passes that task. The hook **denies (exit 2) a completion tick on a tracked task with no recorded PASS**, so a task cannot be ticked done before it has been reviewed. If you see a completion refused mid-run, that is this gate: finish the review, or set `MUSTER_TASK_GATE=off` to disable it. It fails open for any task the board does not track.
- **Built-in agents and skills**, vendored from MIT-licensed upstreams plus Muster's own clean-room specialists.

## Uninstall

Because everything Muster adds lives **inside the plugin**, removal is mostly a matter of removing the plugin. Muster never writes to your `~/.claude/CLAUDE.md` or `settings.json`, so there is nothing tangled to unpick.

```sh
npx -y @adnova-group/muster@0.7.1 uninstall
```

`uninstall` prints the steps it cannot do for you, because removing a plugin is a Claude Code action:

```sh
/plugin uninstall muster@muster    # remove the plugin (and its style + hooks)
/plugin marketplace remove muster  # remove the marketplace
```

It also cleans up after older Muster versions: if an older install left a copied style at `~/.claude/output-styles/muster.md`, `uninstall` removes it (and restores the original it had displaced, if there is a `.bak`). On a current install there is nothing there to remove.

::: tip Everything leaves with the plugin
The output style and both hooks are plugin-native, so uninstalling the plugin removes them automatically. If you had picked the Muster style, pick another under `/config`. There is no global file or `CLAUDE.md` block to clean up by hand.
:::

Next: the [Quickstart](/guides/quickstart).
