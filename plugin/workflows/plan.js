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

function planBrief(cfg, planPath, issues, revision) {
  const lines = [
    `Run ${cfg.runId}. Outcome: ${cfg.outcome || '(see CONTEXT.md)'}`,
    cfg.contextPath ? `Decisions and resolved gray areas: ${cfg.contextPath}. Honour every D-NN decision in it.` : '',
    cfg.candidates ? `Candidate specialists for each task's agentHint: ${JSON.stringify(cfg.candidates)}` : '',
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
    `Run muster plan-lint ${planPath} first and carry every lint issue into your result unchanged.`,
    'Read only: do not edit the plan. verdict PASS only when no blocker remains.',
  ].filter(Boolean).join('\n')
}

const cfg = parseArgs(args)
if (!cfg.runId && !cfg.outcome) return { status: 'error', error: 'plan needs args {runId, outcome, contextPath, candidates}' }
if (!cfg.runId) cfg.runId = slug(cfg.outcome)
const planPath = `.muster/runs/${cfg.runId}/PLAN.md`
const result = (verdict, revisions, issues, escalated, extra) => ({ runId: cfg.runId, planPath, verdict, revisions, issues, escalated, ...extra })

const planOpts = (r) => ({ label: `plan r${r}`, phase: 'Plan', schema: PLAN_RESULT, agentType: 'muster:muster-planner', ...seat(cfg, 'planner') })
let plan = await call(planBrief(cfg, planPath, null, 0), planOpts(0))
if (plan.status !== 'done') return result('ERROR', 0, [], 'planner', { error: plan.error || plan.summary })

let revisions = 0
let lastCount = Infinity
for (;;) {
  const check = await call(checkBrief(cfg, planPath), {
    label: `check r${revisions}`, phase: 'Check', schema: CHECK_RESULT, agentType: 'muster:muster-plan-checker', ...seat(cfg, 'checker'),
  })
  if (check.status === 'error') return result('ERROR', revisions, [], 'checker', { error: check.error })
  const issues = Array.isArray(check.issues) ? check.issues : []
  if (check.verdict === 'PASS') return result('PASS', revisions, issues, null)
  if (revisions >= REVISION_CAP) return result('ISSUES', revisions, issues, 'cap')
  if (issues.length >= lastCount) {
    log(`issue count stalled at ${issues.length}; escalating`)
    return result('ISSUES', revisions, issues, 'stall')
  }
  lastCount = issues.length
  revisions++
  plan = await call(planBrief(cfg, planPath, issues, revisions), planOpts(revisions))
  if (plan.status !== 'done') return result('ERROR', revisions, issues, 'planner', { error: plan.error || plan.summary })
}
