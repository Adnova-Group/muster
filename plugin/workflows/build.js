export const meta = {
  name: 'build',
  description: 'Build an approved muster plan: isolated executors per wave, review with a capped fix loop, one verifier',
  whenToUse: 'After PLAN.md is approved. The main thread passes the waves, then runs `muster merge-wave` on the result.',
  phases: [
    { title: 'Build', detail: 'one builder per task (muster-executor or the planned specialist), each in its own worktree' },
    { title: 'Review', detail: 'muster-reviewer verdict; fixer in the same worktree, at most 2 rounds' },
    { title: 'Verify', detail: 'muster-verifier once per run, against the integrated commits' },
  ],
}

// Contract: docs/strategy/stage-2-contracts.md. Everything between the <shared> markers
// is byte-identical in backlog.js (test/workflows.test.js enforces it).

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
    skillsApplied: {
      type: 'array',
      items: { type: 'object', properties: { id: str, how: str, quote: str }, required: ['id', 'how'] },
    },
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
// Executors started at once, i.e. worktrees being created at once. Simultaneous
// `git worktree add` calls can race on .git/config.lock (gsd #48); args.worktreeConcurrency
// overrides it (1 serializes the builders; reviews and fixes reuse existing worktrees).
const WORKTREE_CAP = 3
const EXECUTOR = 'muster:muster-executor'
const AGENT_TYPE_RE = /^muster:[a-z0-9][a-z0-9-]{0,80}$/

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

// Counting semaphore: at most n thunks in flight, the rest queue in call order.
function limiter(n) {
  let active = 0
  const queue = []
  const pump = () => {
    while (active < n && queue.length) {
      const job = queue.shift()
      active++
      job.fn().then(job.resolve, job.reject).then(() => { active--; pump() })
    }
  }
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump() })
}

// build-args resolves agent_hint to `agentType` only for a dispatchable plugin agent;
// anything else (absent, malformed, the executor itself) runs muster-executor.
function builderType(t) {
  return typeof t.agentType === 'string' && AGENT_TYPE_RE.test(t.agentType) ? t.agentType : EXECUTOR
}

const boundSkills = (t) => list(t.skills).filter((k) => k && typeof k.id === 'string' && typeof k.path === 'string')

function skillLines(t) {
  const skills = boundSkills(t)
  if (!skills.length) return []
  return [
    'REQUIRED SKILLS: before any other work, Read each file below in full and follow it for this task:',
    ...skills.map((k) => `- ${k.id}: ${k.path}`),
    'Return skillsApplied with one {id, how, quote} per skill: how = one line on how this task applied it; quote = one line copied verbatim from the file, proving you read it. A skill that turns out not to apply still gets read; say why in how.',
  ]
}

// Specialist agents (wsh-*, surgeon) do not carry muster-executor's protocol, so the brief does.
function contractLines(tag) {
  return [
    'You are building one task for muster. Your own agent instructions do not know muster\'s executor contract; where they conflict, these rules win:',
    '- Stay on your worktree branch: git rev-parse --abbrev-ref HEAD must be an agent-*, worktree-agent-* or worktree-wf_* branch, never main/master/develop or a detached HEAD; otherwise return status "blocked" without committing.',
    '- Never reset, rebase, push, update-ref or force anything. Stage files one at a time (never git add . or git add -A).',
    `- Commit as <type>(<taskId>): <summary> ${tag}, with a conventional type (feat, fix, test, docs, refactor, chore).`,
    '- Do not install new packages (return "blocked" naming the package). An architectural choice the plan leaves open is "blocked" too, with the options.',
    '- Create new files with Write, or with Bash (cat > path <<\'EOF\') when Write is not among your tools.',
    '- Return the ExecResult object: status done|blocked|error; selfCheck PASSED only when every verify command passed and git log shows your tagged commit, otherwise FAILED; deviations lists anything you did beyond or instead of the plan.',
  ]
}

function emptyExec(t, status, why) {
  return { taskId: t.taskId, status, branch: '', commit: '', worktree: '', filesChanged: [], testsRun: [], testsPassed: false, selfCheck: 'FAILED', deviations: [why] }
}

function execBrief(cfg, t, prior) {
  const tag = `[${cfg.runId}/${t.taskId}]`
  const specialist = builderType(t) !== EXECUTOR
  const steps = [
    `Run ${cfg.runId}, task ${t.taskId}: ${t.title || ''}`,
    `Your task is defined in .muster/runs/${cfg.runId}/PLAN.md; that file is the source of truth.`,
    t.agentHint && !specialist ? `Domain lens for this task: ${t.agentHint}.` : '',
    ...(specialist ? contractLines(tag) : []),
    ...skillLines(t),
    `Files in scope: ${list(t.files).join(', ') || '(see PLAN.md)'}`,
    `Verify commands: ${list(t.verify).join(' ; ') || '(see PLAN.md)'}`,
    'You are in a fresh, isolated git worktree. This brief may be replayed after a crash, so:',
    `1. Check git state first: git status --short; git log --oneline ${cfg.base || 'HEAD~20'}..HEAD. If a commit whose message contains ${tag} already exists and the tree is clean, do not redo the work: re-run the verify commands and report that commit.`,
    cfg.base ? `2. Run git merge-base --is-ancestor ${cfg.base} HEAD. If it fails, stop and return status "blocked".` : '2. (no base commit given; skip the base check)',
    prior.length
      ? `3. Integrate the earlier waves first. For each commit C of ${prior.map((p) => p.commit).join(' ')}: git merge-base --is-ancestor C HEAD || git merge --no-ff --no-edit C`
      : '3. (first wave: nothing to integrate)',
    `4. Implement the task, run the verify commands, and commit with a message containing ${tag}. Do not write a SUMMARY file: merge-wave records SUMMARY-${t.taskId}.md from your result, so put anything a reader needs in deviations.`,
    'Return: branch = git rev-parse --abbrev-ref HEAD, commit = full git rev-parse HEAD, worktree = pwd, testsRun = the exact commands you ran, plus testsPassed, selfCheck and deviations.',
  ]
  return steps.filter(Boolean).join('\n')
}

function reviewBrief(cfg, t, ex, prior) {
  const not = [cfg.base, ...prior.map((p) => p.commit)].filter(Boolean).join(' ')
  const skills = boundSkills(t)
  const used = list(ex.skillsApplied).map((u) => `${u.id}: ${u.how}`)
  return [
    `Review task ${t.taskId} of run ${cfg.runId}: ${t.title || ''}`,
    `The task is defined in .muster/runs/${cfg.runId}/PLAN.md.`,
    `Code: branch ${ex.branch}, commit ${ex.commit}, worktree ${ex.worktree}.`,
    `Review only this task's own commits: git log -p --no-merges ${ex.commit}${not ? ` --not ${not}` : ''}`,
    `Re-run the verify commands inside the worktree (cd ${ex.worktree} && ...): ${list(t.verify).join(' ; ') || '(see PLAN.md)'}`,
    ...(skills.length ? [
      `The task is bound to these skills; Read each and check the diff against its rules: ${skills.map((k) => `${k.id} (${k.path})`).join(', ')}.`,
      `The builder reports skillsApplied: ${used.join('; ') || '(none)'}.`,
      'Not following a bound skill is a FAIL finding (cite the rule); so is a bound skill missing from skillsApplied.',
    ] : []),
    'Read only: do not edit files or commit.',
    `Set taskId to ${t.taskId} and commitReviewed to the full sha you reviewed (it must be ${ex.commit}).`,
    'verdict PASS only when no blocker remains; FAIL with one finding per problem; ABSTAIN when you cannot review.',
  ].filter(Boolean).join('\n')
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
    `3. Re-run the verify commands (${list(t.verify).join(' ; ') || 'see PLAN.md'}) and commit with a message containing ${tag}.`,
    boundSkills(t).length ? `The task is bound to these skills; keep the fix consistent with them: ${boundSkills(t).map((k) => `${k.id} (${k.path})`).join(', ')}` : '',
    'Return the ExecResult for the new HEAD (same branch and worktree).',
  ].filter(Boolean).join('\n')
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
    current = { ...fx, taskId: t.taskId, branch: current.branch, worktree: current.worktree, skillsApplied: current.skillsApplied }
  }
  return { current, reviews }
}

async function finishTask(cfg, t, w, ex, prior) {
  const base = { title: t.title || '', wave: w + 1, verify: list(t.verify), agentType: builderType(t) }
  // Evidence for the main thread: bound skills the builder did not prove it read.
  const proven = new Set(list(ex && ex.skillsApplied).filter((u) => u && u.how).map((u) => u.id))
  const missing = boundSkills(t).map((k) => k.id).filter((id) => !proven.has(id))
  if (missing.length) base.skillsMissing = missing
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
  const startBuilder = limiter(Math.max(1, Math.floor(Number(cfg.worktreeConcurrency)) || WORKTREE_CAP))
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
      (t) => startBuilder(() => call(execBrief(cfg, t, before), {
        label: `${pre}build ${t.taskId}`, phase: 'Build', schema: EXEC_RESULT, agentType: builderType(t), isolation: 'worktree', ...seat(cfg, 'executor'),
      })),
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
if (!cfg.runId || !Array.isArray(cfg.waves)) {
  return { status: 'error', error: 'build needs args {runId, waves:[[{taskId, title, agentHint, agentType, skills, files, verify}]], base, worktreeConcurrency}' }
}
return await runBuild(cfg)
