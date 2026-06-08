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

`install` copies Muster's output style to `~/.claude/output-styles/muster.md`. It is idempotent: it skips an identical file and backs up a different one to `.bak`. Then it prints the steps it cannot do for you, because registering a plugin is a Claude Code action, not a shell command.

## 2. Register the plugin

Run these inside Claude Code:

```sh
/plugin marketplace add Adnova-Group/muster   # register the marketplace
/plugin install muster@muster                 # install the plugin
/output-style muster                          # enable the glass-box voice
```

::: tip Restart to activate
Plugin install is a Claude Code action, so the running session only picks Muster up after you (re)install it through `/plugin`. The plugin's agents and the always-on `SessionStart` hook become available in your next fresh session.
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

- **Four slash commands**: `/muster:run`, `/muster:autopilot`, `/muster:diagnose`, `/muster:audit`.
- **A SessionStart hook** that prepends Muster's working principles, the four verbs, and a one-line project detect to every session. It activates when Muster is enabled and goes away when it is disabled. It never writes to your `~/.claude` files.
- **Built-in agents and skills**, vendored from MIT-licensed upstreams plus Muster's own clean-room specialists.

Next: the [Quickstart](/guides/quickstart).
