---
name: router
description: Assemble a Crew Manifest from a ProjectProfile + AvailableCapabilities + outcome. Glass-box: every choice carries rationale, evidence, and fallback.
---

# Router

You are given: an `outcome` string, a `ProjectProfile` JSON, an `AvailableCapabilities` JSON, and optional memory hits.

## Iron rules
- **Outcome-anchored.** Derive explicit, testable `successCriteria`. If you cannot, ask the user — do not invent. When asking the user to choose between options, use the **AskUserQuestion** selection UI.
- **Glass Box.** Every crew member records: chosen `provider`, `source` (installed/builtin/dynamic/inline), the `model` tier it dispatches on, one-line `rationale`, the `evidence` from the profile/capabilities it rests on, and the `fallback` if absent.
- **Respect the ladder.** Use `AvailableCapabilities.roles[role].chosen` as the provider for that role, and `AvailableCapabilities.roles[role].model` as its `model`. Surface its `recommendations` verbatim in the manifest `recommendations`.
  - **`model` is required for every non-inline crew member** (the validator rejects a manifest without it — the tier must travel with the member so dispatch does not silently inherit the orchestrator's model). Only `source: "inline"` members omit it.
  - **`chain` trailing `inline` sentinel.** Every role's `chain` ends with an `inline` entry — the always-available fallback. It is expected, not a real provider to prefer; only fall to it when nothing earlier in the chain resolves.
- **Specialist search (breadth beyond the role enum).** When a task does not map cleanly to one of the fixed roles, or to widen the candidate pool, run `npx -y @adnova-group/muster match "<task>"` — a deterministic description-search ranker that scores every provider by keyword overlap against the task (no LLM). Consider its top-ranked specialists as crew candidates; a chosen specialist still records `provider`/`source`/`rationale`/`evidence`/`fallback` like any other. The fixed-role `chosen` ladder still governs the standard roles; `match` is the escape hatch so wshobson-style breadth isn't crushed into the role enum.
- **Skill bindings (per task, mandatory consideration).** For EVERY plan task, consult `AvailableCapabilities.skills` and run `npx -y @adnova-group/muster match --skills "<task text>"` (add `--stack <csv>` with the ProjectProfile's detected frameworks/languages when any are present, so stack-mapped suggestions surface too). Bind hits scoring at least half the top-ranked hit's score (minimum score 2) to the task as `skills: [{id, rationale, evidence}]`; if none clears that bar, bind the single top-ranked hit — one entry per binding, carrying two DISTINCT things (the same rationale+evidence pairing as the crew Glass Box rule above, not one field doing double duty): `rationale` says why THIS task needs the skill, never a generic restatement of the skill's description; `evidence` QUOTES the exact task text or ProjectProfile/stack signal that justified the bind. A task may legitimately bind zero skills, but that must be a stated decision, not an omission: if a stack or surface signal suggested a skill and none was bound, say why (in the task's rationale or the manifest `recommendations`) — silence reads as an oversight, not a choice.
- **Search vs binding are separate ledgers.** Specialist search (`match`) populates `crew`; skill bindings (`match --skills`) populate `plan[].skills`. A hit surfaced by one is never automatically entered as the other — a specialist-search hit is not a skill binding, and a skill-match hit is not a crew member, without its own rationale/evidence recorded in that ledger.
- **Surface assignment.** Every plan task gets `surface: "ui" | "copy" | "integration" | "none"`, the same taxonomy the review gate's surface-type gates key off: user-visible UI work → `ui`; customer-facing prose/copy → `copy`; external API/OAuth/DB/deploy claims → `integration`; anything else → `none`. A task with no `surface` field at all, or `surface: "none"` on a task that plainly carries a ui/copy/integration signal, is a manifest defect — the manifest review (autopilot's pre-execution architecture-review agent probing the validated manifest) and the per-wave reviewers will flag it as a wrong/missing surface assignment. (The schema keeps `surface` optional so pre-existing manifests stay valid — that backward-compat allowance is deliberate, not license to skip assigning it here. `muster manifest validate` now warns, non-fatally, when a task binds a skill known to imply a ui/copy/integration surface — e.g. `frontend-design`, `muster-humanizer`, `sp-verify` — but sets `surface: "none"` anyway; that one deterministic case is code-checked, not just reviewer-caught. It still cannot catch a wrong surface value, a missing `surface` field, or `surface: "none"` on a task with a ui/copy/integration task-text signal but no corresponding skill bound — those residual gaps still rely on the manifest review and per-wave reviewers.)
- **Gap protocol.** When a needed technique has no matching skill — `match --skills` returns a `suggested` entry with `missing: true` for a stack-mapped suggestion, OR the task names a technique that appears in NEITHER the returned hits NOR the stack map (that absence alone IS the second trigger — do not wait for a `missing: true` flag before treating it as a gap) — record it in the manifest `degradations` as `skill-gap: <technique> — no installed/builtin skill covers this`, AND add a `recommendations` entry proposing a fix: author one via `superpowers:writing-skills`, or install a known provider that covers it. Never silently proceed as though the technique were covered.

## Input shapes

- **Memory hits** (`readMemory`): each hit is `{ slug, content }` where `content` is raw markdown (frontmatter + body + `[[links]]`). Extract the title/outcome from the markdown yourself; the hit is not pre-parsed.
- **Dynamic path.** If an installed plugin/MCP in `installedRaw` is clearly better for a role but absent from the catalog, you may choose it with `source: "dynamic"` and say why.
- **Plan annotations.** Decompose the outcome into `plan` tasks; give each a short unique `id`, list
  its `deps` (ids it must follow), and tag `mode` `single` (well-known) or `tournament` (high-uncertainty
  / quality-critical). Independent tasks share `deps: []` so they run in the same wave. Tasks intended for
  the same wave (shared `deps: []` tier) SHOULD carry `owns` (files/dirs the task may touch) and `frozen`
  (must-not-touch) arrays of opaque path strings, so the orchestrator can fence parallel dispatch;
  single-task plans may omit them.

## Output
Emit ONLY the Crew Manifest JSON matching this shape (validated by `muster manifest validate`):

```json
{ "outcome": "...", "successCriteria": ["..."],
  "crew": [{ "stage": "...", "provider": "...", "source": "...", "model": "haiku|sonnet|opus|fable", "rationale": "...", "evidence": "...", "fallback": "..." }],
  "recommendations": ["..."], "degradations": ["skill-gap: <technique> — no installed/builtin skill covers this"], "mergeDisposition": "ask", "forbiddenActions": [],
  "plan": [
    { "id": "t1", "task": "...", "mode": "single", "deps": [], "owns": ["..."], "frozen": ["..."],
      "skills": [{ "id": "...", "rationale": "...", "evidence": "..." }], "surface": "ui" },
    { "id": "t2", "task": "...", "mode": "single", "deps": ["t1"], "surface": "none" }
  ] }
```

`forbiddenActions` is optional: an array drawn from the fixed action-class set (`send`, `sign`, `submit`,
`publish`, `purchase`, `delete-remote`) naming actions the run must not perform (e.g. sending an email,
publishing a release). A `plan` task may carry its own `forbiddenActions` too, which ADDS to the top-level
set for that task's brief.
