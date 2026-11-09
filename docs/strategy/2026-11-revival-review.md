# Revival review — 2026-11-09

Whole-codebase review after ~3 months idle (last release 0.7.1, 2026-08-12). Five read-only
reviews ran in parallel: GitHub upstreams, Claude Code 2.1.220→2.1.321, Claude Desktop
(Chat/Cowork merge), performance, and hookless long-run orchestration. Installed Claude Code:
2.1.319. `muster doctor`: all green. Nothing below has been changed yet.

## Verdict

Muster works in Claude Code today, but it is carrying three months of drift:

1. **Always-on cost is the core problem, and it is now solvable.** Every session in every project
   pays for muster's hooks, the prompt nudge, a stray `muster-cowork` MCP registration and
   ~5–7k tokens of skill/agent listings, whether or not muster is wanted. Claude Code now has
   skill-frontmatter hooks (registered only when a verb is invoked), plugin-shipped Workflows,
   `/goal`, and background sessions. Together they can carry an hours/days run with no
   always-on hooks.
2. **Claude Desktop can now run the Claude Code plugin directly.** The MCP-only Cowork design is
   obsolete.
3. **The real latency is model round-trips, not CLI time.** Each tool round-trip is 8–10 s p50;
   `/muster:go` makes ~14+2N of them before the first builder starts.
4. **Vendored upstreams are 89–2,536 commits behind**, including three correctness/security
   fixes. `muster vendor` cannot do the update: it overwrites local adaptations.

## Owner decisions (2026-11-09)

- **Hooks: remove** every always-on hook. Only run-scoped gates survive, declared in verb frontmatter.
- **Output style: stop forcing it.**
- **Start Stage 0 now.**
- **gsd-core is used in its entirety**, not maintained as an older mechanism port. This supersedes the "stay divergent" recommendation in Stage 3.
- **Provenance everywhere**: every skill, agent, builtin and pipeline derived from an external repo (including the humanizer and prompt-smith families) states which repo it is based on.
- **Native first, aggressively**: remove any custom muster mechanism that Claude Code or Desktop now does natively.
- **The orchestrator skill must fit**: the always-hold rules go within the 5,000-token post-compaction budget, with the rest moved into on-demand references.
- **Round-trips are the cost metric**: cut the turns a muster run spends before and between real work.

## Breakages on current Claude Code

| # | Change | Muster impact | Fix |
|---|---|---|---|
| B1 | 2.1.268: Task* / TodoWrite tools "offered only on Claude 3.x, Opus 4.0–4.7, Sonnet 4.0–4.6, Haiku 4.5" | On Opus 5.x / Sonnet 5.5 / Fable the task board is absent. The orchestrator's board path and `task-completed-gate.js` go silently inert | Detect from the tool list; make the STATE no-board path the default |
| B2 | 2.1.277: TaskOutput removed | Stale refs at `plugin/skills/orchestrator/SKILL.md:131`, `docs/native-workflow-dispatch.md:104` | Use Read on the output file |
| B3 | 2.1.292: Agent tool gained `effort` | `src/claude.js:15-24` says it has none, so the effort ladder only reaches Workflow | Extend the ladder; add `effort:` to agent frontmatter |
| B4 | PowerShell is the primary Windows shell (since 2.1.126) | `hooks.json` matcher omits PowerShell, so Windows shell writes bypass the guards | Add the matcher (moot if those hooks are deleted, see Stage 1) |
| B5 | Workflow consent is per-run in manual/accept-edits modes | `orchestrator/SKILL.md:194` claims a muster skill counts as the opt-in | Reword; a plugin workflow gets "don't ask again" |

## Always-on cost today

| Surface | Fires | Measured cost | Plan |
|---|---|---|---|
| `muster-cowork` MCP at user scope in WSL `~/.claude.json` | Every Claude Code session | ~3.5 KB of instructions plus 30 deferred tools; tells the model "No skills or slash commands", contradicting the plugin | Unregister from the CLI (it is meant for Desktop) |
| `UserPromptSubmit` nudge | Imperative prompt after ≥1 edited file | Context injection; tripped on a one-file test fix today | Delete |
| `SessionStart` | Every session | ~55 ms, one line, marker cleanup | Delete; runs clean up on start |
| `PreToolUse` border counter (`pre-tool-use.js`, `inline-budget.js`, `bash-write-target.js`, `guidance.js`) | ~90–97% of tool calls | ~55 ms p50 each (42 ms is node startup), per-session temp files, nudges | Delete |
| `PreToolUse` action fence (`action-guard.js`) | Every matched call; acts only during a run | spawn cost | Keep, moved into verb frontmatter with `if:` filters |
| `TaskCompleted` gate | Every task completion | small; inert on 5.x models (B1) | Prose-lane fallback, in frontmatter |
| Skill/agent/command listings + forced output style | Every session | ~19 KB (~4.8k tok) measured; `claude plugin details` says ~6.8k tok | Hide internal skills (`user-invocable: false`), one-line `wsh-*` agent descriptions, move `audit-pattern-*` out of `skills/`, un-force the output style |

The orchestrator skill (~10.9k tok) is also larger than the 5,000-token budget a skill gets back
after compaction, so its enforcement rules are lost mid-run today.

## Staged plan

### Stage 0: get running (S each, ~1 day)

- [ ] Unregister `muster-cowork` from WSL Claude Code (`claude mcp remove muster-cowork -s user`). Owner action.
- [ ] Desktop: Customize → Plugins → Add marketplace `Adnova-Group/muster`. The Windows checkout behind `claude_desktop_config.json` is at 0.7.1 (`9273ffd`) with 5 modified files: inspect before removing or updating that entry.
- [ ] Fix B1–B3, B5.
- [ ] Vendor correctness fixes, hand-ported:
  - `sp-debug` diagnostic prints a secret's value (`plugin/builtins/sp-debug/SKILL.md:101,105`).
  - `sp-review` uses `awk '{print $1}'`, which Claude Code substitutes.
  - `wsh-signed-audit-trails-recipe` wires `$TOOL_NAME` / `$TOOL_INPUT` (never set) and uses unpinned `protect-mcp@latest`.
  - `sp-brainstorm` `server.cjs:425` `$&` replacement bug.
- [ ] Test suite: shrink the `test/init.test.js` fixtures (421 s of a 751 s serial total; one test is 336 s). That takes CI from ~6.5 to ~2 min per Node version. Then:
  - give the doctor test `noNetworkExec` (11.9 → ~1 s);
  - skip the Kimi live probe on "no credential configured";
  - add `npm run test:fast` (3,134 tests in 10 s).

### Stage 1: zero cost until invoked (M)

- [ ] Probe skill-frontmatter hooks: do they re-register after `--resume`, and do they fire for subagent and worktree tool calls? The docs don't say.
- [ ] Move the action fence and the task gate into `go` / `go-backlog` / `runner` frontmatter `hooks:` with `if:` filters. `plugin/hooks/hooks.json` becomes empty.
- [ ] Delete `session-start.js`, `user-prompt-submit.js`, `inline-budget.js`, `bash-write-target.js`, the border half of `pre-tool-use.js`, the `guidance.js` nudges, the `run-active` lease renewal/expiry, and their tests.
- [ ] Trim always-on context (table above). Keep the orchestrator's must-hold rules within its first 5k tokens. Add a CI size budget, because `go.md` (13.2K→26.4K chars) and `orchestrator/SKILL.md` (13.8K→29.6K) regrew after `docs/speed-tuning.md`.
- [ ] Owner decision: stop forcing the output style. Claude Code 2.1.237 ships a built-in "Concise" style.

### Stage 2: native orchestration (M–L)

- [ ] Ship `plugin/workflows/wave.js`: manifest as `args`, `parallel()` of `agent()` with `isolation: "worktree"`, a review loop until `verdict === 'PASS'` or the iteration cap, and `schema`-validated receipts (fixes the fabricated-count class). Human stops sit between workflows (plan → approve → build → merge). Run it live once on a two-task wave; it has never been invoked live.
- [ ] Collapse CLI round-trips:
  - one `preflight` verb (scope, assess, fast-path, detect, capabilities, validate);
  - one `crew-check` verb (gate-cadence, plan-checklist, wave, dispatch, isolation);
  - batched skill matching.

  Plan drops from 8 turns to 1–2 (~60 s); go with N=3 drops from ~20 turns to ~5 (~2 min).
- [ ] Bundle a runtime into the Claude plugin, reusing the esbuild step from `scripts/build-codex.mjs`. `npx -y` costs 530 ms p50 / 1.75 s cold and depends on the npm registry; bundled is 78 ms. No top-level `bin/` (Chat/Cowork refuse plugins that have one).
- [ ] `capabilities`: write to file and print a summary; add `--roles a,b`. Output is 105 KB today (`--roles-only` 21.9 KB).
- [ ] Per-agent `effort:`. Add a doctor warning for `CLAUDE_CODE_SUBAGENT_EFFORT` / `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL` overriding routing.
- [ ] Continuity:
  - `/muster:resume <run>`, reading `runs/<id>/STATE.md`;
  - a `/goal` wrapper for in-session runs;
  - the runner moves to cloud scheduled tasks.
- [ ] Hooks in exec form (`command: node`, `args: [...]`) with explicit `onFailure`.
- [ ] Optional: `/code-review` as a review-gate correctness seat; `subagentStatusLine`; `omitClaudeMd: true` on the investigator.

### Stage 3: upstream refresh (M)

- [ ] First fix the generator/test mismatch: `toAgent` uses `claudeProfileForAgentId` (since PR #172), but `test/agents.generated.test.js` uses `modelForRoles`, so `muster vendor` fails its own drift test.
- [ ] Do a 3-way merge per item: vendor at the old refs into scratch copy A, at the new refs into copy B, then `git merge-file`.
  - superpowers `284be59` (v6.0.0) → `22f0b46` (v7.0.2): all 9 items changed.
  - wshobson `cf6059d` → `9c61ab2`: 12 of 52 changed.
  - gsd: stay divergent. Port tracer-first planning, reversibility tagging, and PASSED-with-findings → ISSUES FOUND.
  - impeccable: no action.
- [ ] Unify `codex/upstreams.json` with `vendor/manifest.yaml` (they pin different SHAs). Update the renamed `book-genesis` repo (now `felipelobomotta-blip/book-genesis-studio`).
- [ ] Re-pin `test/claude-parity.test.js`. Fix `sp-tdd:362`, which points at the deleted `testing-anti-patterns.md`.
- [ ] Owner decision: adopt the rebuilt v7 `sp-brainstorm`? It overlaps the interview skill.

### Stage 4: Desktop repackaging (S–M)

- [ ] Make the plugin the documented Desktop route. Rewrite the `cowork/mcp-server.mjs` instructions as a fallback: if `/muster:*` skills are present, use them.
- [ ] Remove stale assumptions:
  - `src/harness.js:24-31,84-87`;
  - `src/capabilities.js:43-60`;
  - `cowork/README.md`;
  - `website/guides/cowork.md`;
  - `src/plan-surface.js:47-57`.
- [ ] Split the phase-3 gate: parallel subagents are documented in Cowork; per-call model override is still undocumented.
- [ ] Retire MCPB Route B: plugins replace it, and Cowork doesn't prompt for `${user_config}`.
- [ ] Add `doctor --desktop`: MSIX/config path, Windows checkout version, plugin present in the account list, new log path `%LOCALAPPDATA%\Claude\Logs`.
- [ ] Check by hand: which hook events Cowork fires; whether `npx` resolves in the Cowork sandbox; what "Plugins aren't available in WSL sessions" means for the Code tab.
- [ ] Research docs: add §13 to `claude-code-cli.md` (2.1.221–2.1.321); update `claude-cowork.md` and `claude-code-desktop.md`.

## Key sources

- Claude Code changelog 2.1.220–2.1.321 (`anthropics/claude-code` CHANGELOG.md) and code.claude.com docs: workflows, skills, hooks, goal, plugins.
- Desktop: support.claude.com release notes (2026-09-16 Unified Claude); claude.com/docs/cowork/changelog (2026-10-08 v2.31226.0, 2026-11-03); claude.com/docs/plugins/platform-support.
- Upstream comparisons: `gh api repos/<o>/<r>/compare/<pin>...HEAD`.
- Measurements: per-file test timings, hook p50/p95 over 20 runs, two real session transcripts for round-trip latency.
