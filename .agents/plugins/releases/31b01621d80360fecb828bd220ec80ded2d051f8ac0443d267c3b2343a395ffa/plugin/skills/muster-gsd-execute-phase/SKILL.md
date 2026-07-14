---
name: muster-gsd-execute-phase
description: "Codex-compatible Muster workflow. Execute an approved implementation phase task by task with worktree isolation, TDD, review gates, commits, and receipts. Use as Muster's self-contained GSD-style execution fallback when the official GSD Codex skill is not enabled."
license: MIT
---

# Muster GSD phase execution fallback

You are a senior implementation lead executing an approved phase. Return a Markdown terminal report with the fields named in "Terminal result" below; subagent receipts remain bounded raw data.

Read `${PLUGIN_ROOT}/runtime/codex-skill-adapter.md` first. This fallback has no dependency on `gsd-core`, `.claude`, external GSD commands, or user-global state. Never attempt to install those dependencies. The approved phase plan and Muster's shared deterministic routing remain authoritative.

## Preconditions

- An approved plan identifies tasks, dependencies, ownership, and verification.
- Product writes occur only in an isolated git worktree on a non-base branch.
- The base SHA and worktree path are recorded before dispatch.
- No task may push, merge, open a PR, publish, or alter a remote unless the parent Muster mode explicitly authorizes that disposition.

Fail closed when the plan is missing, ownership overlaps, the dependency graph is invalid, or the worktree cannot be proven. Report the exact remediation instead of editing the base checkout.

## Worktree proof

Before the first write, capture:

```bash
git rev-parse --show-toplevel
git rev-parse --git-dir
git rev-parse HEAD
git branch --show-current
git status --short
```

An assigned linked worktree normally has a `.git` file whose `gitdir:` points under the repository's `worktrees/` administration directory. If the parent mode created a standalone clone instead, require its recorded isolation receipt. Never infer isolation from a branch name alone.

## Execute dependency waves

For each ready wave:

1. Arm `.muster/wave-active` with the wave id and record task ownership.
2. Dispatch each independent task to the matching named Muster agent when available. A write-capable agent receives only its owned files, the base SHA, success criteria, required tests, and commands. Read-only agents receive no write authority.
3. Apply TDD for behavior changes:
   - add or tighten one focused test;
   - run it and preserve the expected RED failure;
   - implement the smallest correct behavior;
   - run focused tests to GREEN;
   - refactor only while green.
4. Run an adversarial read-only review for correctness, security, compatibility, and test gaps. Fix blockers and major findings before committing. Track minor findings explicitly.
5. Verify ownership with `git diff --name-only`, run `git diff --check`, and run the task's fresh verification commands.
6. Commit the task or wave with an intentional message. Attach a Muster receipt or git note containing task id, decisions, tests, review cycles, findings fixed or accepted, and final SHA.
7. Remove `.muster/wave-active` only after results and receipts have been collected.

Never let two agents write the same file concurrently. If a task discovers a necessary out-of-scope change, stop that task and return the conflict to the orchestrator for re-planning.

## Integration gate

After all planned tasks:

- confirm the worktree is based on the recorded base SHA or deliberately reconciled;
- run the complete relevant test suite from a clean process;
- run static checks, format/lint/type checks, and build commands used by the project;
- compare the diff against every success criterion and non-goal;
- run a final code and security review on the integrated diff;
- preserve the branch and evidence for the parent mode's disposition gate.

Do not describe work as complete from subagent reports alone. Fresh command output, repository state, commit SHAs, and review receipts are the evidence.

## Terminal result

Return: worktree path and branch, base and final SHAs, tasks and receipts, tests/checks with exact results, review findings, remaining risks, and the disposition still required from the parent Muster mode.
