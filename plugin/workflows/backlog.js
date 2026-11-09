export const meta = {
  name: 'backlog',
  description: 'Build several planned backlog items one after another through the muster build stages',
  whenToUse: 'Backlog scope: every item already has an approved plan. Run `muster merge-wave` per item afterwards.',
  phases: [
    { title: 'Build', detail: 'one muster-executor per task, each in its own worktree' },
    { title: 'Review', detail: 'muster-reviewer verdict; fixer in the same worktree, at most 2 rounds' },
    { title: 'Verify', detail: 'muster-verifier once per item' },
  ],
}

// Contract: docs/strategy/stage-2-contracts.md. Workflow nesting is one level only, so the
// build stages are inlined: the <shared> block is byte-identical to build.js
// (test/workflows.test.js enforces it). Items run sequentially; each branches from HEAD
// independently, and a failed item does not stop the next one.

// <shared>
const str = { type: 'string' }
const strList = { type: 'array', items: str }
const EXEC_RESULT = {
  type: 'object',
  properties: {
    taskId: str,
    status: { type: 'string', enum: ['done', 'blocked', 'error'] },
    branch: str,
    commit: str,
    worktree: str,
    filesChanged: strList,
    testsRun: strList,
    testsPassed: { type: 'boolean' },
    selfCheck: { type: 'string', enum: ['PASSED', 'FAILED'] },
    deviations: strList,
  },
  required: ['taskId', 'status', 'branch', 'commit', 'worktree', 'filesChanged', 'testsRun', 'testsPassed', 'selfCheck', 'deviations'],
}
const REVIEW_RESULT = {
  type: 'object',
  properties: {
    taskId: str,
    verdict: { type: 'string', enum: ['PASS', 'FAIL', 'ABSTAIN'] },
    commitReviewed: str,
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: { severity: str, file: str, line: { type: 'integer' }, summary: str },
        required: ['severity', 'file', 'summary'],
      },
    },
    testsRun: strList,
    testsPassed: { type: 'boolean' },
  },
  required: ['taskId', 'verdict', 'commitReviewed', 'findings', 'testsRun', 'testsPassed'],
}
const VERIFY_RESULT = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'GAPS', 'ABSTAIN'] },
    truths: {
      type: 'array',
      items: {
        type: 'object',
        properties: { claim: str, status: str, evidence: str },
        required: ['claim', 'status', 'evidence'],
      },
    },
    gaps: strList,
  },
  required: ['verdict', 'truths', 'gaps'],
}

const REVIEW_CAP = 2 // fix rounds per task; review runs at most REVIEW_CAP + 1 times

// Slash-command text arrives as one string; a tool call passes an object.
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

// model/effort per seat come from args.models[seat] (computed by `muster preflight`),
// falling back to args.model / args.effort. Unset keys are omitted so the agent inherits.
function seat(cfg, name) {
  const m = (cfg.models && cfg.models[name]) || {}
  const o = {}
  if (m.model || cfg.model) o.model = m.model || cfg.model
  if (m.effort || cfg.effort) o.effort = m.effort || cfg.effort
  return o
}

// One schema failure (agent() throws after its retry cap) or a skipped/dead agent
// (agent() returns null) becomes {status:'error'} instead of killing the run.
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

const list = (xs) => (Array.isArray(xs) ? xs : xs ? [xs] : [])

function emptyExec(t, status, why) {
  return { taskId: t.taskId, status, branch: '', commit: '', worktree: '', filesChanged: [], testsRun: [], testsPassed: false, selfCheck: 'FAILED', deviations: [why] }
}

function execBrief(cfg, t, prior) {
  const tag = `[${cfg.runId}/${t.taskId}]`
  const steps = [
    `Run ${cfg.runId}, task ${t.taskId}: ${t.title || ''}`,
    `Your task is defined in .muster/runs/${cfg.runId}/PLAN.md; that file is the source of truth.`,
    t.agentHint ? `Domain lens for this task: ${t.agentHint}.` : '',
    `Files in scope: ${list(t.files).join(', ') || '(see PLAN.md)'}`,
    `Verify commands: ${list(t.verify).join(' ; ') || '(see PLAN.md)'}`,
    'You are in a fresh, isolated git worktree. This brief may be replayed after a crash, so:',
    `1. Check git state first: git status --short; git log --oneline ${cfg.base || 'HEAD~20'}..HEAD. If a commit whose message contains ${tag} already exists and the tree is clean, do not redo the work: re-run the verify commands and report that commit.`,
    cfg.base ? `2. Run git merge-base --is-ancestor ${cfg.base} HEAD. If it fails, stop and return status "blocked".` : '2. (no base commit given; skip the base check)',
    prior.length
      ? `3. Integrate the earlier waves first. For each commit C of ${prior.map((p) => p.commit).join(' ')}: git merge-base --is-ancestor C HEAD || git merge --no-ff --no-edit C`
      : '3. (first wave: nothing to integrate)',
    `4. Implement the task, run the verify commands, write .muster/runs/${cfg.runId}/SUMMARY-${t.taskId}.md, and commit everything with a message containing ${tag}.`,
    'Return: branch = git rev-parse --abbrev-ref HEAD, commit = full git rev-parse HEAD, worktree = pwd, testsRun = the exact commands you ran, plus testsPassed, selfCheck and deviations.',
  ]
  return steps.filter(Boolean).join('\n')
}

function reviewBrief(cfg, t, ex, prior) {
  const not = [cfg.base, ...prior.map((p) => p.commit)].filter(Boolean).join(' ')
  return [
    `Review task ${t.taskId} of run ${cfg.runId}: ${t.title || ''}`,
    `The task is defined in .muster/runs/${cfg.runId}/PLAN.md.`,
    `Code: branch ${ex.branch}, commit ${ex.commit}, worktree ${ex.worktree}.`,
    `Review only this task's own commits: git log -p --no-merges ${ex.commit}${not ? ` --not ${not}` : ''}`,
    `Re-run the verify commands inside the worktree (cd ${ex.worktree} && ...): ${list(t.verify).join(' ; ') || '(see PLAN.md)'}`,
    'Read only: do not edit files or commit.',
    `Set taskId to ${t.taskId} and commitReviewed to the full sha you reviewed (it must be ${ex.commit}).`,
    'verdict PASS only when no blocker remains; FAIL with one finding per problem; ABSTAIN when you cannot review.',
  ].join('\n')
}

function fixBrief(cfg, t, ex, review, round) {
  const tag = `[${cfg.runId}/${t.taskId} fix ${round}]`
  const findings = list(review.findings).map((f) => `- ${f.severity} ${f.file}${f.line ? `:${f.line}` : ''}: ${f.summary}`)
  return [
    `Fix review findings for task ${t.taskId} of run ${cfg.runId} (round ${round}).`,
    `Work in the builder's worktree ${ex.worktree}: prefix every shell command with cd ${ex.worktree} && . Do not create a new worktree or branch.`,
    `1. Check git state first: git rev-parse --abbrev-ref HEAD must print ${ex.branch}, otherwise return status "blocked". If git log --oneline ${ex.commit}..HEAD already shows a commit containing ${tag}, do not redo it: re-run the verify commands and report it.`,
    '2. Address exactly these findings, nothing else:',
    ...findings,
    `3. Re-run the verify commands (${list(t.verify).join(' ; ') || 'see PLAN.md'}), update SUMMARY-${t.taskId}.md, and commit with a message containing ${tag}.`,
    'Return the ExecResult for the new HEAD (same branch and worktree).',
  ].join('\n')
}

function verifyBrief(cfg, tasks) {
  const wt = `.claude/worktrees/verify-${cfg.runId}`
  return [
    `Verify run ${cfg.runId} goal-backward against .muster/runs/${cfg.runId}/PLAN.md (and CONTEXT.md when present).`,
    `The work is not merged yet. Integrate it in a scratch worktree: git worktree add --detach ${wt} ${cfg.base || 'HEAD'} (reuse it if it already exists), then inside it run git merge --no-ff --no-edit for each commit in order: ${tasks.map((t) => t.commit).join(' ')}`,
    `Check every must-have against that tree and run the verify commands there: ${tasks.flatMap((t) => list(t.verify)).join(' ; ') || '(see PLAN.md)'}`,
    `Write your report to .muster/runs/${cfg.runId}/VERIFICATION.md relative to your starting directory (the main checkout, not the scratch worktree), then remove the scratch worktree with git worktree remove --force ${wt}.`,
    'ABSTAIN when you cannot gather the evidence; never guess PASS.',
  ].join('\n')
}

async function reviewLoop(cfg, t, ex, prior) {
  const pre = cfg.labelPrefix || ''
  let current = ex
  const reviews = []
  for (let round = 0; ; round++) {
    const rv = await call(reviewBrief(cfg, t, current, prior), {
      label: `${pre}review ${t.taskId} r${round}`, phase: 'Review', schema: REVIEW_RESULT, agentType: 'muster:muster-reviewer', ...seat(cfg, 'reviewer'),
    })
    reviews.push(rv)
    if (rv.verdict !== 'FAIL' || round >= REVIEW_CAP) break
    const fx = await call(fixBrief(cfg, t, current, rv, round + 1), {
      label: `${pre}fix ${t.taskId} r${round + 1}`, phase: 'Review', schema: EXEC_RESULT, agentType: 'muster:muster-executor', ...seat(cfg, 'executor'),
    })
    if (fx.status !== 'done') {
      current = { ...current, deviations: [...list(current.deviations), `fix round ${round + 1}: ${fx.error || fx.status}`] }
      break
    }
    current = { ...fx, taskId: t.taskId, branch: current.branch, worktree: current.worktree }
  }
  return { current, reviews }
}

async function finishTask(cfg, t, w, ex, prior) {
  const base = { title: t.title || '', wave: w + 1, verify: list(t.verify) }
  if (!ex || ex.status === 'error') return { ...emptyExec(t, 'error', (ex && ex.error) || 'executor failed'), ...base, review: null }
  if (ex.status !== 'done' || ex.selfCheck !== 'PASSED') return { ...ex, taskId: t.taskId, ...base, review: null }
  const { current, reviews } = await reviewLoop(cfg, t, ex, prior)
  return { ...current, ...base, review: reviews[reviews.length - 1], reviewRounds: reviews.length, fixRounds: reviews.length - 1 }
}

const passed = (r) => !!r && r.status === 'done' && r.selfCheck === 'PASSED' && !!r.review && r.review.verdict === 'PASS'

async function runBuild(cfg) {
  const pre = cfg.labelPrefix || ''
  const waves = Array.isArray(cfg.waves) ? cfg.waves.map(list) : []
  const tasks = []
  const prior = []
  let halted = null
  for (let w = 0; w < waves.length; w++) {
    const wave = waves[w]
    if (halted) {
      for (const t of wave) tasks.push({ ...emptyExec(t, 'blocked', `skipped: ${halted}`), title: t.title || '', wave: w + 1, verify: list(t.verify), review: null })
      continue
    }
    log(`${pre}wave ${w + 1}/${waves.length}: ${wave.length} task(s)`)
    const before = prior.slice()
    const results = await pipeline(
      wave,
      (t) => call(execBrief(cfg, t, before), {
        label: `${pre}build ${t.taskId}`, phase: 'Build', schema: EXEC_RESULT, agentType: 'muster:muster-executor', isolation: 'worktree', ...seat(cfg, 'executor'),
      }),
      (ex, t) => finishTask(cfg, t, w, ex, before),
    )
    const done = results.map((r, i) => r || { ...emptyExec(wave[i], 'error', 'pipeline dropped the task'), wave: w + 1, verify: list(wave[i].verify), review: null })
    tasks.push(...done)
    const bad = done.filter((r) => !passed(r))
    if (bad.length) halted = `wave ${w + 1} did not pass (${bad.map((r) => r.taskId).join(', ')})`
    else prior.push(...done.map((r) => ({ taskId: r.taskId, commit: r.commit })))
  }
  if (halted) log(`${pre}halted: ${halted}`)
  let verification
  if (halted || !tasks.length) {
    verification = { verdict: 'ABSTAIN', truths: [], gaps: [halted || 'no tasks to verify'] }
  } else {
    verification = await call(verifyBrief(cfg, tasks), {
      label: `${pre}verify ${cfg.runId}`, phase: 'Verify', schema: VERIFY_RESULT, agentType: 'muster:muster-verifier', ...seat(cfg, 'verifier'),
    })
    if (verification.status === 'error') verification = { verdict: 'ABSTAIN', truths: [], gaps: [verification.error], status: 'error' }
  }
  return { runId: cfg.runId, base: cfg.base || null, tasks, verification, halted }
}
// </shared>

const cfg = parseArgs(args)
const items = Array.isArray(cfg.items) ? cfg.items : []
if (!items.length) return { status: 'error', error: 'backlog needs args {items:[{itemId, runId, waves, base?}]}' }
const results = []
for (const item of items) {
  if (!item || !item.runId || !Array.isArray(item.waves)) {
    results.push({ itemId: item && item.itemId, status: 'error', error: 'item needs {itemId, runId, waves}' })
    continue
  }
  log(`item ${item.itemId} (run ${item.runId})`)
  const r = await runBuild({ ...cfg, items: undefined, ...item, labelPrefix: `${item.itemId} ` })
  results.push({ itemId: item.itemId, ...r })
}
return { items: results }
