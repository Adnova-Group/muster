#!/usr/bin/env bash
# Scaffold: a lite-mode SPEC.md (inline ## Intent, from test/fixtures/spec-lint/lite.md) with
# exactly one spec-lint blocker: EXP-01.2 is defined twice.
# Expected: spec-lint docs/specs/csv-dates/SPEC.md -> ISSUES (1 blocker, 0 warning, 0 info).
set -euo pipefail
mkdir -p docs/specs/csv-dates
cat > docs/specs/csv-dates/SPEC.md <<'EOF'
---
spec: export-csv-dates
status: draft
updated: 2026-11-10
---

# Spec: ISO dates in CSV exports

## Summary
CSV exports write dates as ISO 8601 instead of the viewer's locale. Analysts who import exports
into spreadsheets stop fixing dates by hand.

## Intent
Job: When an analyst imports an export into a spreadsheet, they want dates to parse on the first try, so they can build the report without cleanup.

| Kind | Metric | Baseline | Target | Window | Measured by |
|---|---|---|---|---|---|
| Primary | Support tickets tagged csv-dates per month | 12 | 2 | 30 days after release | helpdesk export, tag=csv-dates |
| Guardrail | Export failures per 1,000 exports | 0.3 | no worse than 0.3 | 30 days after release | export job metrics |

- **NG-01** Excel-specific formats — because the CSV stays tool-neutral.

## Scope
In: the CSV export. Out: NG-01; the PDF export — because its dates are for reading, not parsing.

## Requirements

### EXP-01 Export dates parse in any spreadsheet
Why: Intent Job.
- **EXP-01.1** [ubiquitous] The system shall write every date column in a CSV export as YYYY-MM-DD. — verify: test
- **EXP-01.2** [ubiquitous] The system shall write every timestamp column in a CSV export as ISO 8601 with a UTC offset. — verify: test
- **EXP-01.2** [ubiquitous] The system shall cut csv-dates support tickets to 2 a month or fewer within 30 days of release. — verify: needs-runtime

## Invariants (must keep working)
- **INV-01** The system shall continue to show dates in the viewer's locale on screen. — verify: test

## Decisions
- **D-01** Timestamps keep their stored UTC offset rather than converting to the viewer's zone. — reversibility: reversible — it matches the API.

## Open questions
- **OQ-01** Should the release note show a before and after sample? — owner: docs team — blocks: launch
EOF
