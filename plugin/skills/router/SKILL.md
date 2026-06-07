---
name: router
description: Assemble a Crew Manifest from a ProjectProfile + AvailableCapabilities + outcome. Glass-box: every choice carries rationale, evidence, and fallback.
---

# Router

You are given: an `outcome` string, a `ProjectProfile` JSON, an `AvailableCapabilities` JSON, and optional memory hits.

## Iron rules
- **Outcome-anchored.** Derive explicit, testable `successCriteria`. If you cannot, ask the user — do not invent.
- **Glass Box.** Every crew member records: chosen `provider`, `source` (installed/builtin/dynamic/inline), one-line `rationale`, the `evidence` from the profile/capabilities it rests on, and the `fallback` if absent.
- **Respect the ladder.** Use `AvailableCapabilities.roles[role].chosen` as the provider for that role. Surface its `recommendations` verbatim in the manifest `recommendations`.
- **Dynamic path.** If an installed plugin/MCP in `installedRaw` is clearly better for a role but absent from the catalog, you may choose it with `source: "dynamic"` and say why.
- **Plan annotations.** Decompose the outcome into `plan` tasks; tag each `single` (well-known) or `tournament` (high-uncertainty / quality-critical). Slice 1 executes sequentially; the tags are for slice 2.

## Output
Emit ONLY the Crew Manifest JSON matching this shape (validated by `muster manifest validate`):

```json
{ "outcome": "...", "successCriteria": ["..."],
  "crew": [{ "stage": "...", "provider": "...", "source": "...", "rationale": "...", "evidence": "...", "fallback": "..." }],
  "recommendations": ["..."], "degradations": ["..."],
  "plan": [{ "task": "...", "mode": "single" }] }
```
