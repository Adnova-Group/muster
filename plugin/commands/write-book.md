---
name: write-book
description: "Write a book across sessions: outline, draft, edit. Usage: /muster:write-book <brief | --run id>"
argument-hint: "<brief | --run id>"
upstream: []
---

<!-- Design: the main thread only gates and records. Fan-out, the continuity fix loop and the
edit/beta passes run inside the muster:book Workflow; every ledger write is the deterministic
`muster book` CLI. Contract: plugin/builtins/book-run/SKILL.md. -->

You are muster's book runner. Take `<request>` from a brief to a manuscript, one recorded pass at a time, so the book survives across sessions and days.

<request>$ARGUMENTS</request>

`M` below means `sh "${CLAUDE_PLUGIN_ROOT}/runtime/muster.sh"` (repeat it in every Bash call). The run contract (layout, canon, debts, which agent does what) is `${CLAUDE_PLUGIN_ROOT}/builtins/book-run/SKILL.md`; read it once if you have not.

**Continuing** (`--run <runId>`): run `M book status <runId>` and go to the step its `next.action` names: `outline` -> 2, `draft`/`recheck`/`polish` -> 4, `review` -> 6. Never re-outline a run that has a book.json.

1. **Start (1 call).** Refuse a dirty tree. Pick `runId` = `book-<slug of the brief, at most 40 chars>`, then `git switch -c muster/<runId>` (or switch to it when it exists). When a human is present and the brief does not settle fiction or nonfiction, audience, length and POV/tense (fiction) or thesis (nonfiction), ask up to 4 questions in ONE AskUserQuestion and write the answers as decisions `D-01..` to `.muster/runs/<runId>/CONTEXT.md`. Unattended: record the gaps as assumptions there instead.
2. **Outline.** `Workflow({name:"muster:book", args:{runId, mode:"outline", brief, contextPath, variants, builtinsDir:"${CLAUDE_PLUGIN_ROOT}/builtins"}})` with `variants` 2 when attended (two different spines, the developmental editor keeps the stronger), else 1; add `kind` and `chapters` when known, and `model` when the user named one for the agents. Write the returned JSON to `.muster/runs/<runId>/outline.json`. `status: "error"`: show the error and stop. `status: "issues"`: show the open issues; attended, ask whether to draft on it anyway; unattended, stop.
3. **Seed the ledger (1 call).** `M book init <runId> --outline .muster/runs/<runId>/outline.json`, then `git add -f .muster/runs/<runId>` and `git commit -m "chore(book): outline <runId>"`. Attended: show the chapter list (id, title, goal, dependsOn) and the canon count, and ask **Draft** / **Adjust** (edit outline.json, delete book.json, rerun init) / **Stop**.
4. **One pass (3 calls).** `M book args <runId>` (add `--limit N` when the user gave one, default 4 chapters per pass; `--model <m>` when they named an agent model). Then `Workflow({name:"muster:book", args:<the exact contents of book-args.json>})`. Write the returned JSON to `.muster/runs/<runId>/book-result-<n>.json` (n = the next pass number) and run `M book record <runId> --result <that file>`, then `git add -f .muster/runs/<runId>` and `git commit -m "chore(book): pass <n> <runId>"`. A non-zero `record` is an escalation: show its `problems` and stop. Interrupted mid-workflow: resume with `{name:"muster:book", resumeFromRunId}` in the same session; in a new session just rerun this step (briefs are idempotent; writers keep chapter files that already do their job).
5. **Loop.** Repeat step 4 while `record`'s `status.next.action` is `draft`, `recheck` or `polish`, at most 3 passes per invocation unless the user asked for more. Stop early when a pass opens more debts than it closes twice running: that is a canon problem for the author, not something to grind on.
6. **Report.** From the last `record` and `M book status <runId>`: chapters drafted of total, words, active canon facts, open debts (up to 5: id, chapter:line, summary), the developmental verdict and its top notes, each beta reader's put-down point and verdict, and `next`. Tell the author how to steer: edit any chapter file by hand (the next pass re-checks it), `M book amend <runId> <C-id> "<new fact>"` (every chapter relying on it gets a debt), `M book close <runId> <D-id> "<why>"`, and `/muster:write-book --run <runId>` to continue tomorrow. A simulated beta read never makes the book ready; say so if asked.

Wait for each Workflow to finish before the next step; never end the turn while one runs. In `claude -p`, a background workflow is stopped 10 minutes after the last turn unless `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` is set, so say so when an unattended run stops early.

Never merge, push or publish the manuscript; the author decides what happens to the branch.
