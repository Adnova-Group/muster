# Claude Code live probes — 2026-11-09

Two live experiments on Claude Code 2.1.319, run with throwaway plugins (`--plugin-dir`) and
`claude -p`. Workflow agents ran on haiku. They decide the hook and lifecycle design in
`docs/strategy/2026-11-revival-review.md` and `docs/strategy/2026-11-gsd-gap-analysis.md`.

## 1. Skill/command frontmatter hooks (cost ~$0.45)

| Case | Result |
|---|---|
| Hook absent before the verb is invoked | Yes |
| Fires for main-thread tool calls after invocation; `permissionDecision: deny` works | Yes |
| Fires for subagent tool calls (background, foreground, `isolation: worktree`) | **No.** A plugin `hooks/hooks.json` hook does fire inside subagents. |
| Skill invoked inside a subagent | Its hook gates the **parent's** later calls, not the subagent's |
| Survives `claude --resume` | **No.** Hooks last for one process, not for the session id. |
| Survives `/compact` | Yes |
| Plugin `commands/*.md` frontmatter hooks | **Broken.** The skill "loads with no hooks", and the error only shows with `--debug`. Skills work. |
| `if:` filter | Prevents the spawn, but it matches command text best-effort: `sh -c '…'` bypasses it |
| Fires when the model invokes the skill itself (Skill tool) | Yes |

**Design consequence:** frontmatter can't carry the action fence. The fence stays the single
`hooks.json` registration, and it is a no-op unless `.muster/run-active` exists. Run scope comes from
on-disk state, never from hook registration.

## 2. Plugin Workflow scripts (cost ~$0.65)

| Capability | Result |
|---|---|
| Plugin `workflows/` script found and run by name | Yes: `Workflow({"name":"<plugin>:<name>"})`, and the slash command `/<plugin>:<name>` |
| Permission in `-p` | `Workflow` or `Workflow(<plugin>:<name>)` works; the un-namespaced `Workflow(<name>)` is denied. Project `.claude/settings.json` rules are ignored in an untrusted workspace. |
| `args` as an object | Yes, when passed as a tool argument. Slash-command text arrives as one string, so parse it defensively. |
| `parallel()` + `isolation: "worktree"` | Yes. Worktrees at `.claude/worktrees/wf_<run>-<n>`, branch `worktree-wf_<run>-<n>`, based on HEAD. Agents edit, test and commit. |
| Worktree cleanup | Only unchanged worktrees are removed. Changed ones persist; **the main thread merges and cleans up** (the script has no git or filesystem access). |
| `schema` returns | Validated JSON. If retries run out, the call **throws** (`StructuredOutput retry cap (2) exceeded`). A prose-minded agent forced into a schema **invented `{"verdict":"PASS"}`**. |
| Review loop with a cap | Works: round 0 FAIL, one fixer, round 1 PASS |
| Per-agent `model` / `effort` / plugin `agentType` | All honored |
| Main-session cost | 3 model calls (2 turns) for a 2-task wave with review. 62 s wall clock. $0.086. |
| Resume after SIGKILL | Completed agents replay from cache; a 100% cache hit on a second relaunch. `{name, resumeFromRunId}` stays covered by the named rule; `{scriptPath, resumeFromRunId}` is denied. |

Surprises:
- A killed agent's shell command keeps running, so resume can apply side effects twice. Builders must be idempotent.
- `-p` emits a first `result` before the workflow finishes.
- Workflow agents have **no Agent tool**, so there is no nested dispatch.
- Agents add a `Co-Authored-By` trailer to their commits.

**Design consequences for `plugin/workflows/`:**
- The main thread computes the manifest and calls `Workflow({name:"muster:build", args:{…}})`.
- The script owns fan-out, the builder → reviewer → fixer loop and the cap.
- A deterministic CLI step merges the branches back in manifest order, re-runs the tests and removes the worktrees. Fixers `cd` into the builder's kept worktree instead of taking a fresh isolated one.
- Verdicts carry evidence fields (`commitReviewed`, `testsRun`, `testsPassed`) that the main thread re-checks.
- Wrap each `agent()` call so one schema failure doesn't kill the run.
- Gitignore `.claude/worktrees/`.
- Offer the named allow rules `Workflow(muster:plan|build|backlog)`, not a bare `Workflow`.
- Resume always passes `{name, resumeFromRunId}`.
