# Design note: a muster run pane as a Claude Code mod

Status: proposal, not built. Date: 2026-11-10. Sources and quotes:
[`docs/research/claude-cowork.md`](../research/claude-cowork.md) §8 and the Claude Code mods docs
(code.claude.com/docs/en/plugins/mods/overview.md, reference.md).

## What a mod would give muster

A mod is "a plugin that changes how Claude Code looks and behaves", made of JavaScript event
handlers that run inside Claude Code (added in Claude Code 2.1.287, 2026-10-01). The parts that
matter here:

- **A pane beside the transcript.** The `Pane` render site draws in the terminal, the Desktop
  Code tab and VS Code.
- **Deterministic reads.** `$.fs.read` (4 MiB per file), `$.clock.every` for polling, and
  `$.ui.invalidate('ui.render')` to redraw (throttled to 10 a second).
- **A command with no Claude turn.** `$.command.register` adds a `/command` that "runs your
  function at once, with no Claude turn, even while Claude is working".
- **In-process tool rules.** A `tool.check` hook can refuse a tool call without spawning a
  process.

## The proposal

Ship a separate plugin, `muster-pane`, in muster's marketplace. It holds one mod:

1. A dock pane, "muster run", that finds the newest `.muster/runs/<runId>/STATE.md` under
   `$.session.cwd()` and renders its derived head: run id, phase, current wave, each task's
   state, the last merge-wave verdict, and the next step from the Log.
2. A `/muster-pane:status` command that prints the same summary as text, for surfaces that do
   not draw (`claude -p`, cloud sessions, Remote Control clients).
3. Polling every 2 seconds while a run is active (`.muster/run-active` exists), idle otherwise.

It is read-only: it never writes STATE.md, which `merge-wave` and `muster next --run` own.

## Why it is worth having

- The Code tab already shows a checklist, but the model keeps it: it is Desktop's
  `mcp__ccd_turn__update_plan` list, maintained because the app's system prompt asks for it
  (observed 2026-11-10). It drifts when the model forgets, and it resets per turn. The pane
  reads the committed run record, so it is exact and survives compaction and restarts.
- It shows what the checklist cannot: per-task worktree state, review verdicts and the
  merge-wave result.
- It costs no model tokens and no Claude turns.

## Why a separate plugin

- Mods run in the CLI, the Code tab (not WSL sessions) and VS Code. Chat and Cowork do not
  draw them, and the plugin directory "lists a mod ... for Claude Code".
- Whether Chat and Cowork still install a plugin whose `hooks/hooks.json` names `modules` is
  not stated. The plugin is muster's Desktop route, so `muster` itself must stay installable
  there. Putting the mod in `muster-pane` keeps that risk out of the main plugin.
- Users who never open the Code tab or the CLI pay nothing.

## Mod or settings hook, for muster

Use the docs' rule: a mod when you "want a pane, a band above the prompt, a custom command, or
to rewrite an event"; a settings hook when you "want to block, allow, or log an event with a
script you already have". So:

- The run pane and the status command: mod.
- The action fence (`plugin/hooks/pre-tool-use.js`): keep it a settings hook. It is the only
  enforcement that also loads in Cowork, where mods are not documented to run. A later
  `tool.check` copy in `muster-pane` could remove the per-call `node` spawn in the Code tab
  (finding F18), but only alongside the hook, never instead of it.

## Open questions before building

- Does a Code-tab session on Windows render a dock pane from a plugin installed through
  Customize > Plugins? The overview says the Code tab draws mods "except elements the elements
  table marks terminal-only"; check the elements used against that table.
- Test with `claude plugin test` (fires events and presses buttons with no session).

## Recommendation

Build it after the stage-4 Desktop repackaging lands, as `muster-pane`, scoped to the pane and
the status command. Do not add a mod to `plugin/` itself.
