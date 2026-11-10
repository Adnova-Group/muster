---
run: fixture-threat-duplicate
type: execute
autonomous: true
decisions: [D-01]
must_haves:
  truths:
    - "POST /login with valid credentials returns 200 and a session cookie"
  artifacts:
    - src/login.js
  key_links:
    - "src/login.js calls src/session.js"
  prohibitions:
    - "src/app.js exports are unchanged"
---

<!-- plan-lint fixture: threat_model: T-01 names two register rows -->

<objective>
Add a login endpoint backed by a session store.

Purpose: users can sign in.
Output: src/login.js, src/session.js, a README section.
</objective>

<context>
@.muster/runs/fixture-clean/CONTEXT.md
@src/app.js
</context>

<tasks>

<task id="01" type="tracer" wave="1" agent_hint="wsh-backend-architect">
  <name>End-to-end login through one path only</name>
  <files>src/login.js, test/login.test.js</files>
  <action>Wire POST /login to a stub session and return a signed cookie. One entry point only.</action>
  <verify>
    <automated>node --test test/login.test.js</automated>
    <fails_when>non-zero exit, or any "not ok" line</fails_when>
  </verify>
  <done>The single happy path works end to end and is committed.</done>
</task>

<task id="02" type="auto" wave="2" depends_on="01" tdd="true">
  <name>Persist sessions</name>
  <reversibility rating="costly">Session record shape is read by the login route.</reversibility>
  <files>src/session.js, web/session.test.js</files>
  <behavior>
    - a created session can be read back by id
  </behavior>
  <action>Replace the stub with an in-memory store behind the same interface.</action>
  <verify>
    <automated>npm --prefix web run test</automated>
    <fails_when>non-zero exit</fails_when>
  </verify>
  <done>Sessions round-trip through the store.</done>
</task>

<task id="03" type="auto" wave="2" depends_on="01">
  <name>Document login</name>
  <files>README.md</files>
  <action>Add a "## Login" section describing the endpoint and cookie.</action>
  <verify>
    <automated>grep -q "## Login" README.md</automated>
    <fails_when>exit status 1 (the heading is absent)</fails_when>
  </verify>
  <done>README has a Login section.</done>
</task>

</tasks>

<threat_model>
## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-01 | Spoofing | src/login.js | high | mitigate | constant-time credential compare |
| T-01 | Information disclosure | src/session.js | medium | mitigate | opaque session ids |
| T-SC | Tampering | npm installs | high | mitigate | no new dependencies |
</threat_model>

<verification>
node --test test/login.test.js and npm --prefix web run test both pass after the last wave.
</verification>

<success_criteria>
A user can log in and the session persists for the process lifetime.
</success_criteria>
