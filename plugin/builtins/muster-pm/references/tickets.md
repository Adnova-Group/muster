# To Tickets

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-POS-001, ANTH-FMT-001, GUARD-IDK-001: adapted upstream skill body (mattpocock/skills to-tickets), kept close to upstream so `muster vendor update` can 3-way merge it; /muster:pm tickets supplies the role and output format. -->

<!-- Adapted from mattpocock/skills (MIT, Copyright (c) 2026 Matt Pocock) at 4ae2317
(v1.3.2-3-g4ae2317): skills/engineering/to-tickets/SKILL.md. Changes: no frontmatter; the source
is a muster SPEC and every ticket cites the acceptance-criterion IDs it delivers; the
/setup-matt-pocock-skills tracker step is replaced by muster's backlog (`.muster/backlog.md`,
written only through `muster backlog-publish`), so the local-file and issue-tracker forms and
their templates become one backlog-line form. vendor/manifest.yaml tracks the upstream file
(mattpocock-skills). -->

Break a SPEC into a set of **tickets**: tracer-bullet vertical slices, each declaring the tickets that **block** it, each citing the spec IDs it delivers.

## Process

### 1. Gather context

Work from the SPEC the user passed (`docs/specs/<slug>/SPEC.md`, or `…/SPEC.md#REF-02` for one requirement). Read its full body: requirements and their acceptance criteria, invariants, EV rows, decisions and execution contract. Run `muster spec-lint` on it first; a spec with blockers is not ready to split, so report them and stop.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Ticket titles and descriptions should use the project's domain glossary vocabulary, and respect ADRs and the spec's decisions in the area you're touching.

Look for opportunities to prefactor the code to make the implementation easier. "Make the change easy, then make the easy change."

### 3. Draft vertical slices

Break the work into **tracer bullet** tickets.

<vertical-slice-rules>

- Each slice cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests): vertical, NOT a horizontal slice of one layer
- A completed slice is demoable or verifiable on its own
- Each slice is sized to fit in a single fresh context window
- Any prefactoring should be done first

</vertical-slice-rules>

**Coverage.** Every in-scope acceptance criterion (`REF-01.2`), invariant (`INV-01`) and EV row (`EV-03`) is cited by at least one ticket, and no ticket cites an ID the spec does not define. A criterion tagged `[SUGGESTED]` or out of scope gets no ticket. An invariant is cited by the ticket whose change could break it.

Give each ticket its **blocking edges**: the other tickets that must complete before it can start. A ticket with no blockers can start immediately.

**Wide refactors are the exception to vertical slicing.** A **wide refactor** is one mechanical change (rename a column, retype a shared symbol) whose **blast radius** fans across the whole codebase, so a single edit breaks thousands of call sites at once and no vertical slice can land green. Don't force it into a tracer bullet; sequence it as **expand–contract**. First expand: add the new form beside the old so nothing breaks. Then migrate the call sites over in batches sized by blast radius (per package, per directory), each batch its own ticket blocked by the expand, keeping CI green batch to batch because the old form still exists. Finally contract: delete the old form once no caller remains, in a ticket blocked by every migrate batch. When even the batches can't stay green alone, keep the sequence but let them share an integration branch that all block a final integrate-and-verify ticket; green is promised only there.

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each ticket, show:

- **Title**: short descriptive name
- **Covers**: the spec IDs it delivers
- **Blocked by**: which other tickets (if any) must complete first
- **What it delivers**: the end-to-end behaviour this ticket makes work

Then list any in-scope ID no ticket covers (it must be empty before publishing). Ask the user, in one AskUserQuestion round:

- Does the granularity feel right? (too coarse / too fine)
- Are the blocking edges correct: does each ticket only depend on tickets that genuinely gate it?
- Should any tickets be merged or split further?

Iterate until the user approves the breakdown.

### 5. Publish the tickets to the backlog

Publish the approved tickets to `.muster/backlog.md` in dependency order (blockers first), one line per ticket, appended after any existing lines (never remove, reorder or rewrite one):

```
- [ ] <What it delivers, one sentence> (covers REF-01.1, REF-01.2; verify per the spec) {id: <slug>-<nn>} {deps: <blocking ids> | none} {spec: docs/specs/<slug>/SPEC.md#REF-01}
```

- `{id}` is a short kebab label; `{deps}` lists the blocking tickets' ids, or `none` explicitly (an item without `{deps}` waits for every line above it).
- `{spec}` points at the spec and the requirement the ticket serves; `/muster:plan` and `/muster:go` read it to plan from the spec.
- The text names a measurable outcome (the acceptance criteria are), so `muster assess` reads it as clear.
- Skip a ticket whose text (annotations stripped) already exists in the backlog, checked or unchecked, and report the skip.
- Write the file only with `muster backlog-publish .muster/backlog.md --expect <sha256|absent>`, the complete new file on stdin. On a changed-before-publication refusal, reread, redo the duplicate check and the append, and retry.

Work the **frontier**: any ticket whose blockers are all done. For a purely linear chain that means top to bottom.

Do NOT edit the spec. A gap you find while splitting (an unclear criterion, a missing invariant) is reported back as a proposed open question, not fixed in the spec.

Avoid specific file paths or code snippets in ticket text: they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), name the decision and point at the spec's D-NN that records it.
