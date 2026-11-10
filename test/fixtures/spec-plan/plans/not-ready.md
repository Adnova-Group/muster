---
run: fixture-spec-draft
type: execute
autonomous: true
tracer: false
spec: docs/specs/draft/SPEC.md
requirements: [WIN-01]
decisions: [D-01]
must_haves:
  truths:
    - statement: "A refused refund shows the window length"
      ac: [WIN-01.1]
  artifacts:
    - src/window.js
  key_links: []
  prohibitions: []
---

<objective>
Show the refund window next to a refusal, from docs/specs/draft/SPEC.md.

Purpose: customers see why a refund is refused.
Output: src/window.js and its test.
</objective>

<tasks>

<task id="01" type="auto" wave="1" covers="WIN-01.1">
  <name>Show the window length on a refusal</name>
  <files>src/window.js, test/window.test.js</files>
  <action>Render the window length in calendar days (per D-01) next to an outside_window refusal.</action>
  <verify>
    <automated proves="WIN-01.1">node --test test/window.test.js</automated>
    <fails_when>non-zero exit</fails_when>
  </verify>
  <done>The refusal shows the window length.</done>
</task>

</tasks>
