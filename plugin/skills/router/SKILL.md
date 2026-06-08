---
name: router
description: Assemble a Crew Manifest from a ProjectProfile + AvailableCapabilities + outcome. Glass-box: every choice carries rationale, evidence, and fallback.
---

# Router

You are given: an `outcome` string, a `ProjectProfile` JSON, an `AvailableCapabilities` JSON, and optional memory hits.

## Iron rules
- **Outcome-anchored.** Derive explicit, testable `successCriteria`. If you cannot, ask the user — do not invent. When asking the user to choose between options, use the **AskUserQuestion** selection UI.
- **Glass Box.** Every crew member records: chosen `provider`, `source` (installed/builtin/dynamic/inline), one-line `rationale`, the `evidence` from the profile/capabilities it rests on, and the `fallback` if absent.
- **Respect the ladder.** Use `AvailableCapabilities.roles[role].chosen` as the provider for that role. Surface its `recommendations` verbatim in the manifest `recommendations`.
- **Dynamic path.** If an installed plugin/MCP in `installedRaw` is clearly better for a role but absent from the catalog, you may choose it with `source: "dynamic"` and say why.
- **Plan annotations.** Decompose the outcome into `plan` tasks; give each a short unique `id`, list
  its `deps` (ids it must follow), and tag `mode` `single` (well-known) or `tournament` (high-uncertainty
  / quality-critical). Independent tasks share `deps: []` so they run in the same wave.

## Output
Emit ONLY the Crew Manifest JSON matching this shape (validated by `muster manifest validate`):

```json
{ "outcome": "...", "successCriteria": ["..."],
  "crew": [{ "stage": "...", "provider": "...", "source": "...", "rationale": "...", "evidence": "...", "fallback": "..." }],
  "recommendations": ["..."], "degradations": ["..."],
  "plan": [{ "id": "t1", "task": "...", "mode": "single", "deps": [] }] }
```
