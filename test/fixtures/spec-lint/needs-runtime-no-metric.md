---
spec: export-csv-dates
status: draft
updated: 2026-11-10
---

<!-- Lite mode whose inline Intent has no Primary outcome row, with a needs-runtime criterion:
warns (outcome_link), does not block. -->

# Spec: ISO dates in CSV exports

## Summary
CSV exports write dates as ISO 8601 instead of the viewer's locale.

## Intent
Job: When an analyst imports an export into a spreadsheet, they want dates to parse on the first try, so they can build the report without cleanup.

- **NG-01** Excel-specific formats — because the CSV stays tool-neutral.

## Requirements

### EXP-01 Export dates parse in any spreadsheet
Why: Intent Job.
- **EXP-01.1** [ubiquitous] The system shall write every date column in a CSV export as YYYY-MM-DD. — verify: test
- **EXP-01.2** [ubiquitous] The system shall cut csv-dates support tickets to 2 a month or fewer within 30 days of release. — verify: needs-runtime

## Open questions
- **OQ-01** Should the release note show a before and after sample? — owner: docs team — blocks: launch
