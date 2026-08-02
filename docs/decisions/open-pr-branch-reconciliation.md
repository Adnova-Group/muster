# Open PR branch reconciliation

This record reconciles PRs 145–152, 166–176, and 185 as observed at `2026-08-02T03:40:35.000Z` against base commit `248f556c790ff1b9765c053c89a7d7e1669a4419`. The machine-readable authority is [open-pr-branch-reconciliation.json](open-pr-branch-reconciliation.json).

Every PR was still open when inspected. Consequently, every entry is `awaiting-disposition`: an implementation or review receipt did not make the backlog item complete while its promised external disposition remained undone. No GitHub state was changed by this reconciliation.

| PR | Proposed disposition | Reason / owner |
|---:|---|---|
| 145 | active backlog owner | `@rnbennett` — rebase and isolate the missing MCP-specific runtime pin |
| 146 | close with rationale | Accepted research rejects `--strict-config` as an unsafe doctor primitive |
| 147 | active backlog owner | `@rnbennett` — obtain durable exact-head code/security review receipts despite green CI |
| 148 | active backlog owner | `@rnbennett` — reconcile the process wave with the later isolation lane |
| 149 | close with rationale | Canonical thread ceiling landed and evolved on main |
| 150 | close with rationale | Current event-driven watcher supersedes the stale branch |
| 151 | close with rationale | Its own benchmark rejected adoption and prohibited production routing |
| 152 | close with rationale | Current provider-aware follow-up loop supersedes the module |
| 166 | active backlog owner | `@rnbennett` — repair failed/cancelled CI and obtain exact-head re-review |
| 167 | active backlog owner | `@rnbennett` — refresh desktop contracts against current init/CLI |
| 168 | active backlog owner | `@rnbennett` — rebase the CLI handler split |
| 169 | active backlog owner | `@rnbennett` — rebase the Codex dispatch split and retain Kimi parity |
| 170 | active backlog owner | `@rnbennett` — refresh the census consumer migration |
| 171 | active backlog owner | `@rnbennett` — rerun the Kimi builtin reachability census |
| 172 | active backlog owner | `@rnbennett` — repair failed/cancelled CI and obtain exact-head re-review |
| 173 | active backlog owner | `@rnbennett` — repair failed/cancelled CI and obtain exact-head re-review |
| 174 | active backlog owner | `@rnbennett` — repair failed/cancelled CI and obtain exact-head re-review |
| 175 | active backlog owner | `@rnbennett` — repair failed/cancelled CI and obtain exact-head re-review |
| 176 | active backlog owner | `@rnbennett` — rebase the post-consolidation walker migration and repair CI |
| 185 | active backlog owner | `@rnbennett` — refresh launcher protocol and generated docs |

The dispatcher coordinates every later action; only the human performs merges or destructive closes. Before any action, the live PR head must equal the ledger's full `observedHeadSha`. A merge additionally requires green current checks and a passing review at that exact head. Active owners own branch repair and re-review; they do not own permission to mutate `main`.
