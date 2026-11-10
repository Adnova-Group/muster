export const meta = {
  name: 'plan',
  description: 'Write and check a muster PLAN.md: planner, then plan-checker, revising at most 3 times',
  whenToUse: 'After `muster preflight` (and the interview, when the outcome is unclear). Returns the plan path and the checker verdict.',
  phases: [
    { title: 'Plan', detail: 'muster-planner writes or revises PLAN.md' },
    { title: 'Check', detail: 'muster-plan-checker, plan-lint first; stop on PASS, cap or stalled issue count' },
  ],
}

// Contract: docs/strategy/stage-2-contracts.md. Schemas mirror plugin/workflows/schemas.js.

const str = { type: 'string' }
const CHECK_RESULT = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'ISSUES'] },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: { dimension: str, severity: str, required_property: str, summary: str },
        required: ['dimension', 'severity', 'summary'],
      },
    },
  },
  required: ['verdict', 'issues'],
}
const PLAN_RESULT = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'blocked', 'error'] },
    planPath: str,
    taskCount: { type: 'integer' },
    summary: str,
  },
  required: ['status', 'planPath', 'taskCount', 'summary'],
}

const REVISION_CAP = 3

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v : { outcome: raw.trim() }
  } catch (e) {
    return { outcome: raw.trim() }
  }
}

function seat(cfg, name) {
  const m = (cfg.models && cfg.models[name]) || {}
  const o = {}
  if (m.model || cfg.model) o.model = m.model || cfg.model
  if (m.effort || cfg.effort) o.effort = m.effort || cfg.effort
  return o
}

async function call(prompt, opts) {
  try {
    const r = await agent(prompt, opts)
    if (r && typeof r === 'object') return r
    return { status: 'error', error: `${opts.label}: agent returned no result` }
  } catch (e) {
    log(`${opts.label} failed: ${(e && e.message) || e}`)
    return { status: 'error', error: `${opts.label}: ${(e && e.message) || e}` }
  }
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'run'

// Project pins (.muster/config, `muster skills pin`): build-args binds each one to every
// matching task whatever the plan says, so the planner plans with them instead of around them.
function pinLine(pins) {
  const valid = (Array.isArray(pins) ? pins : []).filter((p) => p && typeof p.id === 'string')
  if (!valid.length) return ''
  const list = valid.map((p) => `${p.id} (${p.role ? `tasks with role ${p.role}` : 'every task'})`).join(', ')
  return `Project-pinned skills, always bound at build time: ${list}. Bind each pinned builtin in its matching tasks' skills attribute (build-args adds any left out, and the project-installed ones) and plan those tasks to follow it.`
}

// A run planned from a SPEC.md (docs/plan-format.md "Planning from a spec"): plan-lint's
// spec_traceability checks every line of this brief, so the planner hears the rules up front.
function specLines(specPath) {
  if (typeof specPath !== 'string' || !specPath.trim()) return []
  return [
    `Spec: ${specPath}. Read it first; it outranks the outcome text. Write spec: ${specPath} and requirements: [the in-scope requirement IDs] in the PLAN.md frontmatter, and list every spec D-NN in decisions:.`,
    'Every in-scope AC, INV and EV ID appears in some task\'s covers="..."; never cover an ID you do not deliver in full.',
    'Each INV-NN becomes a must_haves.prohibitions entry with ac: [INV-NN]; each EV-NN gets an eval command; each test/check AC is named by the <automated proves="..."> command that proves it; each verify: judgment AC gets a checkpoint:human-verify task that covers it. needs-runtime ACs need no task.',
  ]
}

function planBrief(cfg, planPath, issues, revision) {
  const lines = [
    `Run ${cfg.runId}. Outcome: ${cfg.outcome || '(see CONTEXT.md)'}`,
    ...specLines(cfg.specPath),
    cfg.contextPath ? `Decisions and resolved gray areas: ${cfg.contextPath}. Honour every D-NN decision in it.` : '',
    cfg.candidates ? `Candidate specialists for each task's agent_hint: ${JSON.stringify(cfg.candidates)}` : '',
    cfg.skills ? `Candidate builtin skills for each task's skills attribute: ${JSON.stringify(cfg.skills)}${cfg.skillRoot ? `; every other builtin id is a directory name under ${cfg.skillRoot}` : ''}` : '',
    pinLine(cfg.pins),
  ]
  if (!issues) {
    lines.push(
      `Write the plan to ${planPath}.`,
      `Check the file first: this brief may be replayed. If ${planPath} already exists and covers this outcome, keep it and report it instead of rewriting it.`,
    )
  } else {
    lines.push(
      `Revision ${revision} of ${REVISION_CAP}: revise ${planPath} in place to resolve exactly these checker issues.`,
      'Do not reduce scope to make an issue disappear. If an issue conflicts with a D-NN decision, keep the decision and say so in summary.',
      ...issues.map((i) => `- [${i.severity}] ${i.dimension}${i.required_property ? ` (${i.required_property})` : ''}: ${i.summary}`),
    )
  }
  lines.push('Return status, planPath, taskCount and a one-paragraph summary.')
  return lines.filter(Boolean).join('\n')
}

function checkBrief(cfg, planPath) {
  return [
    `Check the plan at ${planPath} for run ${cfg.runId}. Outcome: ${cfg.outcome || '(see CONTEXT.md)'}`,
    cfg.contextPath ? `Decisions it must honour: ${cfg.contextPath}.` : '',
    cfg.specPath ? `Spec: ${cfg.specPath}. Dimension 1 covers its in-scope AC, INV and EV IDs too, and a task whose covers cites an ID must deliver that ID in full.` : '',
    `Run muster plan-lint ${planPath} first and carry every lint issue into your result unchanged.`,
    'Read only: do not edit the plan. verdict PASS only when no blocker remains.',
  ].filter(Boolean).join('\n')
}

const cfg = parseArgs(args)
if (!cfg.runId && !cfg.outcome) return { status: 'error', error: 'plan needs args {runId, outcome, contextPath, specPath, candidates, skills, skillRoot}' }
if (!cfg.runId) cfg.runId = slug(cfg.outcome)
const planPath = `.muster/runs/${cfg.runId}/PLAN.md`
const result = (verdict, revisions, issues, escalated, extra) => ({ runId: cfg.runId, planPath, verdict, revisions, issues, escalated, ...extra })

const planOpts = (r) => ({ label: `plan r${r}`, phase: 'Plan', schema: PLAN_RESULT, agentType: 'muster:muster-planner', ...seat(cfg, 'planner') })
// gsd revision-loop: the planner reports REVISION_CONFLICT when a checker issue contradicts a
// locked decision. That is the user's call, not a planner error.
const plannerFailure = (p, revisions, issues) => /^REVISION_CONFLICT\b/.test(String(p.summary || ''))
  ? result('ISSUES', revisions, issues, 'conflict', { conflict: p.summary })
  : result('ERROR', revisions, issues, 'planner', { error: p.error || p.summary })
let plan = await call(planBrief(cfg, planPath, null, 0), planOpts(0))
if (plan.status !== 'done') return plannerFailure(plan, 0, [])

// gsd's checker reports ISSUES on any issue, info included; only blockers and warnings bind a
// revision or count toward the stall rule.
const binding = (issues) => issues.filter((i) => /^(blocker|warning)$/i.test(String(i.severity || '')))
let revisions = 0
let lastCount = Infinity
for (;;) {
  const check = await call(checkBrief(cfg, planPath), {
    label: `check r${revisions}`, phase: 'Check', schema: CHECK_RESULT, agentType: 'muster:muster-plan-checker', ...seat(cfg, 'checker'),
  })
  if (check.status === 'error') return result('ERROR', revisions, [], 'checker', { error: check.error })
  const issues = Array.isArray(check.issues) ? check.issues : []
  const open = binding(issues)
  if (check.verdict === 'PASS' || !open.length) return result('PASS', revisions, issues, null)
  if (revisions >= REVISION_CAP) return result('ISSUES', revisions, issues, 'cap')
  if (open.length >= lastCount) {
    log(`blocking issue count stalled at ${open.length}; escalating`)
    return result('ISSUES', revisions, issues, 'stall')
  }
  lastCount = open.length
  revisions++
  plan = await call(planBrief(cfg, planPath, open, revisions), planOpts(revisions))
  if (plan.status !== 'done') return plannerFailure(plan, revisions, issues)
}
