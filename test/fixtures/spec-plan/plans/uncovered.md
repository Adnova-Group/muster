---
run: fixture-spec-uncovered
type: execute
autonomous: false
spec: docs/specs/refunds/SPEC.md
requirements: [REF-01, REF-02]
decisions: [D-01, D-02]
must_haves:
  truths:
    - statement: "A customer refunds an order delivered 30 days ago or less"
      ac: [REF-01.1]
    - statement: "An order delivered more than 30 days ago is refused with outside_window"
      ac: [REF-01.2]
  artifacts:
    - src/refunds.js
  key_links:
    - "src/refunds.js calls the payments service (D-01)"
  prohibitions:
    - statement: "Partial refunds issued by support agents still settle through the admin flow"
      verification: test
      ac: [INV-01]
---

<objective>
Self-serve refunds for delivered orders, built from docs/specs/refunds/SPEC.md.

Purpose: customers refund eligible orders without a support ticket.
Output: src/refunds.js, its tests and the reason eval.
</objective>

<tasks>

<task id="01" type="tracer" wave="1" covers="REF-01.1">
  <name>End-to-end refund request through one path only</name>
  <files>src/refunds.js, test/refunds.test.js</files>
  <action>Create a pending refund request for an order delivered within 30 days through the payments service (per D-01) and show its RF- id (per D-02).</action>
  <verify>
    <automated proves="REF-01.1">node --test test/refunds.test.js</automated>
    <fails_when>non-zero exit, or any "not ok" line</fails_when>
  </verify>
  <done>An eligible order gets a pending refund request with an RF- id.</done>
</task>

<task id="02" type="auto" wave="2" depends_on="01" covers="INV-01">
  <name>Refuse refunds outside the window, keep admin partial refunds</name>
  <files>src/window.js, test/window.test.js, test/admin-partial.test.js</files>
  <action>Refuse an order delivered more than 30 days ago with reason outside_window and create no request; leave the admin partial-refund flow untouched.</action>
  <verify>
    <automated>node --test test/window.test.js</automated>
    <fails_when>non-zero exit</fails_when>
    <automated proves="INV-01">node --test test/admin-partial.test.js</automated>
    <fails_when>non-zero exit</fails_when>
  </verify>
  <done>Late orders are refused; admin partial refunds still settle.</done>
</task>

<task id="03" type="auto" wave="2" depends_on="01" covers="EV-01 EV-02">
  <name>Reason classification and injection evals</name>
  <files>evals/refunds/run.js, evals/refunds/reason.jsonl, evals/refunds/injection.jsonl</files>
  <action>Run the reason and injection case sets against the classifier and fail below each pass rule.</action>
  <verify>
    <automated proves="EV-01 EV-02">node evals/refunds/run.js</automated>
    <fails_when>non-zero exit, or a pass rule missed in the summary line</fails_when>
  </verify>
  <done>Both eval sets meet their fixed pass rules.</done>
</task>

<task id="04" type="checkpoint:human-verify" wave="3" depends_on="02" covers="REF-02.2">
  <name>Confirm the confirmation copy</name>
  <what-built>The refund confirmation screen.</what-built>
  <how-to-verify>Compare the confirmation text with the support lead's copy deck.</how-to-verify>
  <resume-signal>Type "approved" or describe the differences.</resume-signal>
</task>

</tasks>

<verification>
node --test test/
</verification>

<success_criteria>
Every in-scope criterion of the spec is covered and proven.
</success_criteria>
