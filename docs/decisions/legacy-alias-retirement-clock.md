# Legacy alias retirement clock

- **Status:** Accepted
- **Date:** 2026-07-30
- **Deprecation date:** `2026-07-17`
- **Retirement target:** `muster 0.7.0`

## Context

The legacy `run`, `autopilot`, and `sprint` aliases entered deprecation with
notices saying they retire in muster 0.7.0. The repository is now on 0.6.0,
which made it unclear whether the notice described a release milestone or an
elapsed-time window.

Muster follows Semantic Versioning, and its release history advances through
tagged versions rather than a fixed calendar cadence. The notice therefore
already gives users a stable compatibility boundary: every version before
0.7.0 retains the aliases, while 0.7.0 is the first version allowed to omit
them.

## Decision

Reaffirm `muster 0.7.0`. The first shipped 0.7.0 release will retire all three
legacy aliases together. Releases in the 0.5.x and 0.6.x lines must continue to
ship the aliases with unchanged delegation behavior and the existing notice.

This is a release-based milestone. Calendar time does not advance this clock,
and time spent developing an unreleased version does not shorten the
compatibility window. If 0.7.0 is delayed, the aliases remain available until
0.7.0 actually ships.

## Consequences

- The current notices remain accurate and need no date or target rewrite.
- The removal change belongs to the 0.7.0 release and must remove all three
  aliases and their compatibility documentation together.
- `test/alias-deprecation.test.js` reads this record as the authority for the
  notice date and retirement target, preventing the decision and public
  surfaces from drifting independently.
