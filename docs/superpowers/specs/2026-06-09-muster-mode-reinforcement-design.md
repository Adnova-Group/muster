# Muster Mode Reinforcement — Design

**Date:** 2026-06-09
**Status:** Implemented

> **Implemented.** Shipped in 0.2.3; this is the design record.

## Problem

A Claude session running under muster drifts back to default Claude behavior — working
inline, not invoking skills on its own — within a few turns. The muster principles and verbs
are injected once at `SessionStart` (`plugin/hooks/session-start.js`) and lose salience fast.
With 1M-context models, compaction (which would re-fire `SessionStart` and re-inject the full
payload) now happens exceptionally rarely, so it cannot be relied on to re-anchor the session.

## Goal

Periodically re-assert muster mode during a live session, cheaply, so adherence does not depend
on manual reminders or on compaction occurring. "Muster mode" includes a **default routing
posture**: in a muster-installed repo, actionable prompts should be driven through muster workflows
by default — the user should not have to prefix every task with `/muster`.

## Routing posture

The injected guidance carries a routing directive (`ROUTING_POLICY`), re-asserted on the same
cadence as the drift fix:

- **Directives and substantive questions** → route through the muster verbs
  (`/muster:run`, `:autopilot`, `:diagnose`, `:audit`) where applicable.
- **Conversational / trivial turns** → fall through to a normal response, no workflow.
- **Explicit `/muster` commands or verbs** → honored as given; auto-routing only applies to prompts
  that don't already invoke one.

This is a steering directive injected as text, not a hard gate — it biases the model's default
path, it does not intercept or block prompts. A hard-gate classifier is explicitly out of scope
(see below).

## Mechanism

A new `UserPromptSubmit` hook fires before each user turn and, on a turn cadence, injects
guidance via `hookSpecificOutput.additionalContext`. Two tiers:

- **Short nudge** every `N` turns (default `N = 3`).
- **Full principles + verbs** on every `K`th nudge (default `K = 3`), i.e. every `N·K = 9`
  turns the nudge is upgraded to the full payload instead of the short one.

Compaction still re-fires `SessionStart` with `source: compact`, re-injecting the full payload —
now a backstop, not the primary mechanism.

### Cadence example (N=3, K=3)

| Turn | Emit |
|------|------|
| 1, 2 | nothing |
| 3, 6 | short nudge |
| 9    | full principles + verbs |
| 12, 15 | short nudge |
| 18   | full principles + verbs |

Rule: at turn `t`, if `t % (N·K) === 0` emit full; else if `t % N === 0` emit short; else emit
nothing. Full supersedes short when both match.

## Components

### `plugin/hooks/guidance.js` (new, shared)

Single source of truth for the guidance text. Self-contained (node: builtins only), ships under
`plugin/hooks/`. Exports:

- `PRINCIPLES` — the 6 principle lines (string).
- `VERBS` — the verbs line (string).
- `ROUTING_POLICY` — the default-routing directive (string, below).
- `SHORT_NUDGE` — the one-paragraph nudge, which includes a condensed routing clause (below).
- `detect(cwd)` — project/git detection (moved verbatim from `session-start.js`).

`ROUTING_POLICY` text:

> Default routing: in this muster repo, drive actionable prompts through muster — route directives
> and substantive questions to the verbs (/muster:run · :autopilot · :diagnose · :audit) where
> applicable, and content/copy work through the muster content pipeline (humanizer). Let
> conversational or trivial turns fall through. Honor explicit /muster commands as given.

`SHORT_NUDGE` text (carries a condensed routing clause):

> muster mode — drive directives through the muster verbs (don't default to plain inline work),
> route copy/content through the humanizer, keep reasoning glass-box. Conversational turns fall
> through. Verbs: /muster:run · /muster:autopilot · /muster:diagnose · /muster:audit.

### `plugin/hooks/session-start.js` (refactor)

Import `PRINCIPLES`, `VERBS`, `ROUTING_POLICY`, `detect` from `guidance.js` and compose
`[PRINCIPLES, VERBS, ROUTING_POLICY, detect(cwd)]`. The added `ROUTING_POLICY` line is the only
output change; existing `hook-session-start.test.js` assertions still hold (they match on verbs and
a principle keyword, which remain present). Remains fully self-contained and fail-safe.

### `plugin/hooks/user-prompt-submit.js` (new)

Same shape as `session-start.js`: node: builtins only, entire body in try/catch, always emit
valid JSON and exit 0. Logic:

1. Read stdin JSON → `session_id`. Missing/unparseable → emit `{}` payload, exit 0 (no nudge).
2. Counter file: `path.join(os.tmpdir(), 'muster-turns-' + session_id)`. Read int (default 0),
   increment, write back. Read/write failure → treat as no-nudge, exit 0.
3. `N` from `process.env.MUSTER_NUDGE_EVERY`, parsed as a positive int; junk/≤0 → default `3`.
4. `K` from `process.env.MUSTER_PRINCIPLES_EVERY`, parsed as a positive int; junk/≤0 → default `3`.
5. Emit:
   - `count % (N*K) === 0` → `additionalContext = PRINCIPLES + "\n" + VERBS + "\n" + ROUTING_POLICY`
   - else `count % N === 0` → `additionalContext = SHORT_NUDGE` (already carries the routing clause)
   - else → no `additionalContext`
   - `hookSpecificOutput.hookEventName = "UserPromptSubmit"` in all cases.

The full periodic payload is `PRINCIPLES + VERBS + ROUTING_POLICY` (no `detect` — project type does
not change mid-session and orientation is a session-start concern).

### `plugin/hooks/hooks.json` (edit)

Add a `UserPromptSubmit` registration alongside the existing `SessionStart` entry, invoking
`node "${CLAUDE_PLUGIN_ROOT}/hooks/user-prompt-submit.js"`.

## Data flow

```
user turn → UserPromptSubmit hook
  stdin {session_id} → read counter file → ++ → write
  N, K from env (defaults 3, 3)
  count % (N*K)==0 ? full : count % N==0 ? short : none
  → stdout hookSpecificOutput.additionalContext → injected into context
```

## Error handling

Both hooks are invoked on every turn / session start and must never break the session:

- Whole body wrapped in try/catch; on any error emit minimal valid JSON
  (`{ hookSpecificOutput: { hookEventName: <event> } }`) and exit 0.
- Missing `session_id`, unreadable/corrupt counter file, junk env values → degrade to no-nudge,
  never throw.
- No network, no non-builtin imports, only a few `fs` calls.

## Testing (TDD — tests written first)

### `test/hook-user-prompt-submit.test.js` (new)

Helper spawns the hook as a subprocess and pipes stdin JSON (extends the `session-start` test
helper, which only passes `cwd`). Each test uses a unique `session_id` so counter files do not
collide.

- Turns 1..N-1 → no `additionalContext`; turn N → short nudge present (counter persists across
  separate subprocess invocations keyed by a fixed `session_id`).
- Turn N·K → full payload (contains a principle keyword AND all four verbs); a short-only turn
  (e.g. N·2 when K=3) → short nudge, not the full principle lines.
- `MUSTER_NUDGE_EVERY=5` honored; `MUSTER_PRINCIPLES_EVERY=2` honored; junk values
  (`""`, `"abc"`, `"0"`, `"-1"`) fall back to defaults.
- Malformed/empty stdin → valid JSON, exit 0, no nudge.
- Short nudge text contains the four verbs and a "muster mode" marker, plus a routing marker
  (mentions the humanizer / "drive directives").
- Full payload (turn N·K) contains a routing marker (e.g. "Default routing" / humanizer) in
  addition to the principle keyword and verbs.

### `test/hook-session-start.test.js` (augment)

Add one assertion pinning the dependency: the hook emits the full payload (principles + all four
verbs) regardless of `source`, since the compact backstop relies on it.

## Configuration

| Env var | Meaning | Default |
|---------|---------|---------|
| `MUSTER_NUDGE_EVERY` | turns between short nudges (`N`) | `3` |
| `MUSTER_PRINCIPLES_EVERY` | nudges between full-principle upgrades (`K`) | `3` |

## Out of scope (YAGNI)

- Counter-file cleanup (tmp files are tiny; OS reaps `/tmp`).
- A `.muster` config file for cadence (env vars suffice).
- Reading turn count from the transcript (O(n) per turn → O(n²) over a session; the counter file
  is O(1)).
- Any change to `plugin.json` version — a separate release step, not part of this design.
- A hard-gate `UserPromptSubmit` classifier that decides conversational-vs-directive and
  blocks/rewrites prompts. The routing posture here is steering text only; a classifier is brittle
  and a larger build — its own future spec if wanted.
