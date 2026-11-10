export const meta = {
  name: 'pipeline',
  description: 'Run a muster content pipeline (blog post, PRD, runbook and more): skill-bound phase agents, adversarial review, floor-scored gate',
  whenToUse: 'When preflight routes an outcome to a content pipeline. The main thread passes pipeline-args.json, then commits the artifact.',
  phases: [
    { title: 'Draft', detail: 'one agent per pipeline phase, in order, each reading its bound skills' },
    { title: 'Gate', detail: 'adversarial review + rubric score; failing the floor or total revises, at most 2 rounds' },
    { title: 'Finish', detail: 'phases after the gate, e.g. the humanizer pass' },
  ],
}

// Contract: docs/strategy/stage-2-contracts.md (stage-3 amendments). Args come from
// `muster pipeline-args <runId>`: {runId, outcome, contextPath?, pipeline:{id, title, gate},
// phases:[{id, role, desc, skills:[{id, path}]}], artifactPath, models?}. Phases run in file
// order in the main checkout (one writer at a time, so no worktree). The review and score
// phases form the gate; JS, not the scorer, applies the floor principle.

const str = { type: 'string' }
const strList = { type: 'array', items: str }
const PHASE_RESULT = {
  type: 'object',
  properties: {
    phase: str,
    status: { type: 'string', enum: ['done', 'blocked', 'error'] },
    wrote: strList,
    summary: str,
    skillsApplied: {
      type: 'array',
      items: { type: 'object', properties: { id: str, how: str, quote: str }, required: ['id', 'how'] },
    },
  },
  required: ['phase', 'status', 'wrote', 'summary'],
}
const CONTENT_REVIEW = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL', 'ABSTAIN'] },
    findings: {
      type: 'array',
      items: { type: 'object', properties: { severity: str, summary: str }, required: ['severity', 'summary'] },
    },
  },
  required: ['verdict', 'findings'],
}
const SCORE_RESULT = {
  type: 'object',
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        properties: { criterion: str, score: { type: 'integer', minimum: 0, maximum: 3 }, evidence: str },
        required: ['criterion', 'score', 'evidence'],
      },
    },
  },
  required: ['scores'],
}

const REVISION_CAP = 2

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v : {}
  } catch (e) {
    return {}
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
  [PHASE_RESULT, (r) => (r.status === 'done' ? gapOf(r, ['wrote'], 'done') : '')],
  [SCORE_RESULT, (r) => (!filled(r.scores) ? 'scores empty' : r.scores.some((x) => !x || !filled(x.evidence)) ? 'a score without evidence' : '')],
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
const pad = (n) => String(n).padStart(2, '0')

// Pure: the floor principle. Every gate criterion needs a score; any score under the floor or a
// total under pass_total fails; weakest = the lowest-scoring criteria.
function judge(gate, scored) {
  const by = {}
  for (const s of list(scored && scored.scores)) if (s && typeof s.criterion === 'string') by[s.criterion] = Number(s.score)
  const criteria = list(gate && gate.criteria)
  const missing = criteria.filter((c) => !Number.isFinite(by[c]))
  const values = criteria.map((c) => (Number.isFinite(by[c]) ? by[c] : 0))
  const total = values.reduce((a, b) => a + b, 0)
  const low = values.length ? Math.min(...values) : 0
  const passing = !missing.length && values.every((v) => v >= gate.floor) && total >= gate.pass_total
  return { passing, total, floor: gate.floor, passTotal: gate.pass_total, missing, weakest: criteria.filter((c, i) => values[i] === low), scores: by }
}

// Phase skills may run the muster CLI (muster-roadmap's prioritize). `muster` is not on PATH in a
// user's project, so the brief carries the absolute prefix pipeline-args copies from preflight.
const cliPrefix = (cfg) => (typeof cfg.cli === 'string' && /^[^\r\n]{1,1024}$/.test(cfg.cli.trim()) ? cfg.cli.trim() : 'sh "$CLAUDE_PLUGIN_ROOT/runtime/muster.sh"')

function common(cfg) {
  return [
    `Content run ${cfg.runId}: pipeline ${cfg.pipeline.id} (${cfg.pipeline.title}).`,
    `Outcome: ${cfg.outcome || '(see CONTEXT.md)'}`,
    cfg.contextPath ? `Decisions (honour every D-NN): ${cfg.contextPath}` : 'No CONTEXT.md: where the outcome leaves something open, choose and record the assumption.',
    `The artifact lives at ${cfg.artifactPath}. Phase notes live under .muster/runs/${cfg.runId}/pipeline/.`,
    'Write only the artifact, your notes file and files the phase description names (e.g. docs/profiles/). Do not commit, push, publish or send anything.',
    `Run muster CLI commands as: ${cliPrefix(cfg)} <verb> ... (the bare muster command is not on PATH).`,
  ]
}

function skillLines(ph) {
  const skills = list(ph.skills).filter((k) => k && k.id && k.path)
  if (!skills.length) return []
  return [
    'REQUIRED SKILLS: before any other work, Read each file below in full and follow it for this phase:',
    ...skills.map((k) => `- ${k.id}: ${k.path}`),
    'Return skillsApplied with one {id, how, quote} per skill: how = one line on how you applied it here; quote = one line copied verbatim from the file.',
  ]
}

function notesPath(cfg, i, ph) {
  return `.muster/runs/${cfg.runId}/pipeline/${pad(i + 1)}-${ph.id}.md`
}

function phaseBrief(cfg, i, ph, earlier, feedback) {
  const notes = notesPath(cfg, i, ph)
  return [
    ...common(cfg),
    `Phase ${i + 1}/${cfg.phases.length}: ${ph.id} (role ${ph.role}). Do this: ${ph.desc}`,
    earlier.length ? `Read the earlier phase notes first: ${earlier.join(', ')}` : 'This is the first phase.',
    ...skillLines(ph),
    feedback
      ? `REVISION: edit ${cfg.artifactPath} in place to fix exactly this gate feedback, keeping what already works:\n${feedback}`
      : `This brief may be replayed: if ${notes} already exists and records this phase as complete, report it instead of redoing it.`,
    `Write your notes for later phases (decisions, sources, open questions) to ${notes}; drafting phases also create or edit ${cfg.artifactPath}.`,
    'Return phase, status (blocked only when the phase cannot be done without a human), wrote (paths), a one-paragraph summary and skillsApplied.',
  ].join('\n')
}

function reviewBrief(cfg, earlier) {
  return [
    ...common(cfg),
    `Adversarially review ${cfg.artifactPath} as a demanding reader of this ${cfg.pipeline.title}. Phase notes: ${earlier.join(', ') || '(none)'}.`,
    `Judge it against the gate criteria ${list(cfg.pipeline.gate && cfg.pipeline.gate.criteria).join(', ')} and against the outcome and decisions.`,
    'Read only: do not edit the artifact. One finding per problem, severity blocker | warning | info, each specific enough to fix.',
    'verdict PASS only when no blocker remains; FAIL otherwise; ABSTAIN when the artifact is missing or unreadable.',
  ].join('\n')
}

function scoreBrief(cfg, ph) {
  const gate = cfg.pipeline.gate || {}
  return [
    ...common(cfg),
    ...skillLines(ph).slice(0, -1),
    `Score ${cfg.artifactPath} 0-3 on each criterion: ${list(gate.criteria).join(', ')}. Cite evidence from the artifact for every score.`,
    `Write the scores as JSON to .muster/runs/${cfg.runId}/score.json (not .muster/score.json). Do not run the CLI's score verb: the workflow applies the floor (${gate.floor}) and pass total (${gate.pass_total}) to the scores you return.`,
    'Read only apart from score.json. Return scores as [{criterion, score, evidence}] using the criterion names exactly.',
  ].join('\n')
}

const cfg = parseArgs(args)
if (!cfg.runId || !cfg.pipeline || !Array.isArray(cfg.phases) || !cfg.phases.length || !cfg.artifactPath) {
  return { status: 'error', error: 'pipeline needs args {runId, outcome, pipeline:{id, title, gate}, phases:[{id, role, desc, skills}], artifactPath, cli} (the pipeline-args verb writes them)' }
}
const gate = cfg.pipeline.gate || { criteria: [], floor: 0, pass_total: 0 }
const phases = cfg.phases
const reviewAt = phases.findIndex((p) => p.role === 'code-review')
const scoreAt = phases.findIndex((p) => p.role === 'score')
const gateStart = [reviewAt, scoreAt].filter((i) => i >= 0).reduce((a, b) => Math.min(a, b), phases.length)
const gateEnd = Math.max(reviewAt, scoreAt)
// The phase that owns the artifact text during revisions: the last author phase before the gate.
const reviserAt = phases.slice(0, gateStart).map((p, i) => (p.role === 'author' ? i : -1)).filter((i) => i >= 0).pop()

const record = []
const earlier = []
let halted = null

async function runPhase(i, feedback, round) {
  const ph = phases[i]
  const r = await call(phaseBrief(cfg, i, ph, earlier.slice(), feedback), {
    label: `${ph.id}${round ? ` r${round}` : ''}`, phase: i < gateStart ? 'Draft' : 'Finish', schema: PHASE_RESULT, ...seat(cfg, 'executor'),
  })
  record.push({ id: ph.id, round: round || 0, status: r.status, ...(r.reason ? { reason: r.reason } : {}), summary: r.summary || r.error || '', skillsApplied: list(r.skillsApplied) })
  if (r.status !== 'done') halted = `phase ${ph.id}: ${r.status}${r.error ? ` (${r.error})` : ''}`
  else if (!round) earlier.push(notesPath(cfg, i, ph))
  return r
}

for (let i = 0; i < gateStart && !halted; i++) await runPhase(i)

let review = null
let score = null
let revisions = 0
if (!halted && gateEnd >= 0) {
  for (let round = 0; ; round++) {
    review = reviewAt >= 0
      ? await call(reviewBrief(cfg, earlier), { label: `review r${round}`, phase: 'Gate', schema: CONTENT_REVIEW, ...seat(cfg, 'reviewer') })
      : null
    const scored = scoreAt >= 0
      ? await call(scoreBrief(cfg, phases[scoreAt]), { label: `score r${round}`, phase: 'Gate', schema: SCORE_RESULT, ...seat(cfg, 'verifier') })
      : null
    score = scored ? (scored.status === 'error' ? { passing: false, error: scored.error, weakest: [], total: 0 } : judge(gate, scored)) : null
    const reviewOk = !review || review.verdict === 'PASS'
    const scoreOk = !score || score.passing
    if (reviewOk && scoreOk) break
    if (round >= REVISION_CAP || reviserAt === undefined) {
      halted = `gate failed after ${round} revision(s): ${!scoreOk ? `score ${score.total}/${gate.pass_total}, weakest ${score.weakest.join(', ')}` : ''}${!reviewOk ? ` review ${review.verdict}` : ''}`.trim()
      break
    }
    const feedback = [
      score && !score.passing ? `- Score ${score.total} (pass ${gate.pass_total}, floor ${gate.floor}); raise the weakest: ${score.weakest.join(', ')}${score.missing && score.missing.length ? `; unscored: ${score.missing.join(', ')}` : ''}` : '',
      ...list(review && review.findings).filter((f) => f.severity !== 'info').map((f) => `- [${f.severity}] ${f.summary}`),
    ].filter(Boolean).join('\n')
    revisions++
    await runPhase(reviserAt, feedback, revisions)
    if (halted) break
  }
}

// Everything after the gate's first phase that is not review or score (normally humanize).
for (let i = gateStart + 1; i < phases.length && !halted; i++) {
  if (i === reviewAt || i === scoreAt) continue
  await runPhase(i)
}

if (halted) log(`halted: ${halted}`)
const verdict = halted ? (record.some((r) => r.status === 'error') ? 'ERROR' : 'FAIL') : 'PASS'
return { runId: cfg.runId, pipeline: cfg.pipeline.id, artifactPath: cfg.artifactPath, verdict, halted, revisions, score, review, phases: record }
