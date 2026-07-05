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
  "recommendations": ["..."], "degradations": ["..."],
  "plan": [{ "id": "t1", "task": "...", "mode": "single", "deps": [] }] }
```
