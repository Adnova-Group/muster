export const meta = {
  name: 'debug',
  description: 'Root-cause a bug with competing hypotheses: parallel investigators, a cross-examination round, deterministic arbitration',
  whenToUse: 'From /muster:diagnose once the failure reproduces and more than one cause is plausible. Read-only: it returns a root-cause verdict; the fix runs as a one-task tdd plan through muster:team.',
  phases: [
    { title: 'Hypothesize', detail: 'one wsh-team-debugger proposes 3-5 competing hypotheses (skipped when args.hypotheses is given)' },
    { title: 'Investigate', detail: 'one read-only investigator per hypothesis, in parallel' },
    { title: 'Challenge', detail: 'when 2+ hypotheses survive, a fresh investigator tries to disprove each survivor' },
  ],
}

// Contract: docs/strategy/dev-team-topologies.md. Schemas mirror plugin/workflows/schemas.js
// (test/workflows-team.test.js enforces it). Arbitration is deterministic script code, after
// wshobson parallel-debugging's result-arbitration protocol, so no agent grades its own theory.

const str = { type: 'string' }
const HYPOTHESES_RESULT = {
  type: 'object',
  properties: {
    hypotheses: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: str, statement: str, category: str, predicts: str },
        required: ['id', 'statement', 'category', 'predicts'],
      },
    },
  },
  required: ['hypotheses'],
}
const HYPOTHESIS_RESULT = {
  type: 'object',
  properties: {
    hypothesisId: str,
    status: { type: 'string', enum: ['CONFIRMED', 'PLAUSIBLE', 'FALSIFIED', 'INCONCLUSIVE'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        properties: { file: str, line: { type: 'integer' }, claim: str, supports: { type: 'boolean' } },
        required: ['file', 'claim', 'supports'],
      },
    },
    causalChain: str,
    reproduction: str,
    suggestedFix: str,
  },
  required: ['hypothesisId', 'status', 'confidence', 'evidence', 'causalChain', 'reproduction', 'suggestedFix'],
}

const INVESTIGATOR = 'muster:wsh-team-debugger'
const MAX_HYPOTHESES = 5 // Claude Code agent-teams guidance: start with 3-5 teammates
const STATUS_RANK = { CONFIRMED: 3, PLAUSIBLE: 2, INCONCLUSIVE: 1, FALSIFIED: 0 }
const CONF_RANK = { high: 2, medium: 1, low: 0 }

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v : { symptom: raw.trim() }
  } catch (e) {
    return { symptom: raw.trim() }
  }
}

function seat(cfg, name) {
  const m = (cfg.models && cfg.models[name]) || {}
  const o = {}
  if (m.model || cfg.model) o.model = m.model || cfg.model
  if (m.effort || cfg.effort) o.effort = m.effort || cfg.effort
  return o
}

// Turn limits (findings F15; build.js's call() has the full note). An agent() result carries
// no stop reason: a subagent stopped at its maxTurns throws (it never called StructuredOutput)
// or returns a schema-valid partial result. Either is {status:'error', reason:'max_turns'},
// never done or PASS, and is retried once: these agents work in place, so a rerun of the same
// idempotent brief continues the work.
const TURN_LIMIT_RE = /without calling StructuredOutput|max(imum)?[ _-]?turns|turn limit/i
const filled = (v) => (Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim() !== '' : v != null)
const gapOf = (r, keys, claim) => {
  const empty = keys.filter((k) => !filled(r[k]))
  return empty.length ? `${claim} without ${empty.join(', ')}` : ''
}
const EVIDENCE = new Map([
  [HYPOTHESES_RESULT, (r) => gapOf(r, ['hypotheses'], 'result')],
  [HYPOTHESIS_RESULT, (r) => (r.status === 'CONFIRMED' || r.status === 'PLAUSIBLE' ? gapOf(r, ['evidence', 'causalChain'], r.status) : '')],
])

async function attempt(prompt, opts, gap) {
  try {
    const r = await agent(prompt, opts)
    if (!r || typeof r !== 'object') return { status: 'error', reason: 'no_result', error: `${opts.label}: agent returned no result` }
    const why = gap ? gap(r) : ''
    if (!why) return r
    log(`${opts.label}: ${why}; read as a turn-limited partial result`)
    return { status: 'error', reason: 'max_turns', error: `${opts.label}: ${why} (max_turns: partial result)` }
  } catch (e) {
    const msg = (e && e.message) || String(e)
    log(`${opts.label} failed: ${msg}`)
    const turns = TURN_LIMIT_RE.test(msg)
    return { status: 'error', reason: turns ? 'max_turns' : 'agent_error', error: `${opts.label}: ${msg}${turns ? ' (max_turns: raise the agent\'s maxTurns or split the work)' : ''}` }
  }
}

async function call(prompt, opts, gap = EVIDENCE.get(opts.schema)) {
  const r = await attempt(prompt, opts, gap)
  if (r.reason !== 'max_turns') return r
  log(`${opts.label}: turn limit; retrying once`)
  return attempt(prompt, { ...opts, label: `${opts.label} retry` }, gap)
}

const list = (xs) => (Array.isArray(xs) ? xs : xs ? [xs] : [])
const valid = (r) => !!r && r.status !== 'error' && r.status in STATUS_RANK
const survives = (r) => valid(r) && (r.status === 'CONFIRMED' || r.status === 'PLAUSIBLE')

function context(cfg) {
  return [
    `Symptom: ${cfg.symptom}`,
    cfg.repro ? `Reproduction: ${cfg.repro}` : 'Reproduction: none given; reproduce it yourself if you can, read-only.',
    cfg.context ? `Context: ${cfg.context}` : '',
    'You are read-only: never edit files, never commit, write no files. You may run read-only commands, the reproduction and existing tests.',
  ].filter(Boolean)
}

function generateBrief(cfg, max) {
  return [
    'Mode: generate.',
    ...context(cfg),
    `Return ${Math.min(3, max)}-${max} competing, falsifiable hypotheses for the root cause, spread across different failure-mode categories (logic, data, state, integration, resource, environment), each with the observation that would confirm it in predicts. Ids H1, H2, ... Do not investigate yet.`,
  ].join('\n')
}

function investigateBrief(cfg, h) {
  return [
    'Mode: investigate.',
    ...context(cfg),
    `Your hypothesis ${h.id}: ${h.statement}`,
    h.predicts ? `It predicts: ${h.predicts}` : '',
    'Gather evidence to confirm or falsify this one hypothesis only. Cite file:line for every claim and include the evidence against it. A hypothesis you could not test is INCONCLUSIVE, never CONFIRMED.',
    `Set hypothesisId to ${h.id}.`,
  ].filter(Boolean).join('\n')
}

function challengeBrief(cfg, h, reports) {
  return [
    'Mode: challenge.',
    ...context(cfg),
    `Assigned hypothesis to disprove: ${h.id}: ${h.statement}`,
    'Every investigator\'s report from the first round:',
    ...reports.map((r) => `- ${r.hypothesisId} ${r.status} (${r.confidence}): ${r.causalChain || '(no chain)'}; evidence: ${list(r.evidence).map((e) => `${e.supports ? '+' : '-'} ${e.file}${e.line ? `:${e.line}` : ''} ${e.claim}`).join(' | ') || 'none'}`),
    `Try to disprove ${h.id}: find the contradicting evidence its investigator missed, test its causal chain against the reproduction, and check whether a rival explains the same symptom better. Return your verdict on ${h.id} in the same result shape, hypothesisId ${h.id}.`,
  ].join('\n')
}

// Deterministic arbitration (wshobson parallel-debugging, "Result Arbitration Protocol"):
// rank by status, then confidence, then supporting minus contradicting evidence.
function score(r) {
  const ev = list(r.evidence)
  const plus = ev.filter((e) => e.supports).length
  const minus = ev.length - plus
  return STATUS_RANK[r.status] * 100 + (CONF_RANK[r.confidence] || 0) * 10 + plus - 2 * minus
}

function arbitrate(results) {
  const ranked = results.filter(valid).slice().sort((a, b) => score(b) - score(a))
  const confirmed = ranked.filter((r) => r.status === 'CONFIRMED')
  if (confirmed.length === 1) return { verdict: 'ROOT_CAUSE', rootCause: confirmed[0], ranked }
  if (confirmed.length > 1) {
    const [a, b] = confirmed
    if (score(a) - score(b) >= 10) return { verdict: 'ROOT_CAUSE', rootCause: a, ranked }
    return { verdict: 'COMPOUND', rootCause: a, contributing: confirmed.slice(1), ranked }
  }
  return { verdict: 'INCONCLUSIVE', rootCause: null, ranked }
}

const cfg = parseArgs(args)
if (!cfg.symptom) return { status: 'error', error: 'debug needs args {symptom, repro?, context?, hypotheses?:[string], maxHypotheses?}' }
const max = Math.max(2, Math.min(Number.isInteger(cfg.maxHypotheses) ? cfg.maxHypotheses : 4, MAX_HYPOTHESES))

let hypotheses = list(cfg.hypotheses).map((h, i) => (typeof h === 'string' ? { id: `H${i + 1}`, statement: h, category: '', predicts: '' } : h)).filter((h) => h && h.statement)
let generated = null
if (!hypotheses.length) {
  generated = await call(generateBrief(cfg, max), { label: 'hypothesize', phase: 'Hypothesize', schema: HYPOTHESES_RESULT, agentType: INVESTIGATOR, ...seat(cfg, 'investigator') })
  hypotheses = list(generated.hypotheses).filter((h) => h && h.statement)
  if (!hypotheses.length) return { symptom: cfg.symptom, verdict: 'ERROR', error: generated.error || 'no hypotheses generated', hypotheses: [], investigations: [], challenges: [] }
}
hypotheses = hypotheses.slice(0, max).map((h, i) => ({ ...h, id: h.id || `H${i + 1}` }))
log(`investigating ${hypotheses.length} hypotheses in parallel`)

const first = await parallel(hypotheses.map((h) => () => call(investigateBrief(cfg, h), {
  label: `investigate ${h.id}`, phase: 'Investigate', schema: HYPOTHESIS_RESULT, agentType: INVESTIGATOR, ...seat(cfg, 'investigator'),
})))
const investigations = first.map((r, i) => (r && r.status !== 'error' ? { ...r, hypothesisId: hypotheses[i].id } : { hypothesisId: hypotheses[i].id, status: 'error', reason: (r && r.reason) || 'no_result', error: (r && r.error) || 'no result' }))

// The cross-examination round: Claude Code's agent-teams guidance names the debate as the
// mechanism that beats anchoring. Workflow agents cannot message, so each survivor gets one
// fresh adversarial investigator who sees every report. Run only when 2+ theories survive.
const survivors = investigations.filter(survives)
let challenges = []
const final = investigations.slice()
if (survivors.length >= 2) {
  log(`${survivors.length} hypotheses survive; cross-examining`)
  const reports = investigations.filter(valid)
  const out = await parallel(survivors.map((s) => () => call(challengeBrief(cfg, hypotheses.find((h) => h.id === s.hypothesisId), reports), {
    label: `challenge ${s.hypothesisId}`, phase: 'Challenge', schema: HYPOTHESIS_RESULT, agentType: INVESTIGATOR, ...seat(cfg, 'investigator'),
  })))
  challenges = out.map((r, i) => (r && valid(r) ? { ...r, hypothesisId: survivors[i].hypothesisId } : { hypothesisId: survivors[i].hypothesisId, status: 'error', reason: (r && r.reason) || 'no_result', error: (r && r.error) || 'no result' }))
  // A valid challenge replaces the first-round verdict: the survivor stands only if it
  // withstood the attempt to disprove it. A failed challenge keeps the original report.
  for (const c of challenges) if (valid(c)) final[final.findIndex((r) => r.hypothesisId === c.hypothesisId)] = c
}

const { verdict, rootCause, contributing, ranked } = arbitrate(final)
return {
  symptom: cfg.symptom,
  verdict,
  rootCause: rootCause ? { ...rootCause, statement: (hypotheses.find((h) => h.id === rootCause.hypothesisId) || {}).statement || '' } : null,
  contributing: (contributing || []).map((r) => r.hypothesisId),
  ranking: ranked.map((r) => ({ hypothesisId: r.hypothesisId, status: r.status, confidence: r.confidence, score: score(r) })),
  hypotheses,
  investigations,
  challenges,
  next: verdict === 'INCONCLUSIVE'
    ? 'No hypothesis was confirmed. Re-run with new hypotheses drawn from the evidence above, or escalate.'
    : 'Fix it test-first: a one-task PLAN.md with tdd="true" whose <behavior> reproduces the root cause, built through muster:team.',
}
