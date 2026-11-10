export const meta = {
  name: 'build',
  description: 'Build an approved muster plan: isolated executors per wave, review with a capped fix loop, one verifier',
  whenToUse: 'After PLAN.md is approved. The main thread passes build-args.json, then runs merge-wave on the result.',
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
    verdict: { type: 'string', enum: ['PASS', 'GAPS', 'HUMAN_NEEDED', 'ABSTAIN'] },
    truths: {
      type: 'array',
      items: {
        type: 'object',
        properties: { claim: str, status: str, evidence: str },
        required: ['claim', 'status', 'evidence'],
      },
    },
    gaps: strList,
    human: strList,
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
//
// Turn limits (findings F15). An agent() result carries no stop reason or turn-limit marker:
// with a schema it is the validated StructuredOutput object, null for a skipped agent or a
// terminal API error, and a throw when the subagent ends without calling StructuredOutput,
// which is how one stopped at its maxTurns surfaces (Claude Code 2.1.319). So a throw of that
// shape, or a done/PASS claim whose evidence is empty (EVIDENCE), is {status:'error',
// reason:'max_turns'}: never done, never PASS. An agent that works in place is retried once;
// an isolated builder is not, since it would start over in a fresh worktree under the same
// cap. Whether a claimed commit exists is merge-wave's check: it can run git, this cannot.
const TURN_LIMIT_RE = /without calling StructuredOutput|max(imum)?[ _-]?turns|turn limit/i
const SHA_RE = /^[0-9a-f]{7,64}$/i
const filled = (v) => (Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim() !== '' : v != null)
const gapOf = (r, keys, claim) => {
  const empty = keys.filter((k) => !filled(r[k]))
  return empty.length ? `${claim} without ${empty.join(', ')}` : ''
}
const execGap = (r) => (r.status !== 'done' ? '' : SHA_RE.test(String(r.commit || '')) ? gapOf(r, ['branch', 'worktree', 'filesChanged', 'testsRun'], 'done') : 'done without a commit sha')
const reviewGap = (r) => (r.verdict === 'PASS' ? gapOf(r, ['commitReviewed', 'testsRun'], 'PASS') : '')
// HUMAN_NEEDED (gsd's human_needed: zero gaps, items only a human can sign off) carries the
// same evidence burden as PASS, plus the items themselves.
const verifyGap = (r) => (r.verdict !== 'PASS' && r.verdict !== 'HUMAN_NEEDED' ? ''
  : !filled(r.truths) ? `${r.verdict} without truths`
  : r.truths.some((x) => !x || !filled(x.evidence)) ? `${r.verdict} with a truth that has no evidence`
  : r.verdict === 'HUMAN_NEEDED' && !filled(r.human) ? 'HUMAN_NEEDED without human items' : '')
const EVIDENCE = new Map([[EXEC_RESULT, execGap], [REVIEW_RESULT, reviewGap], [VERIFY_RESULT, verifyGap]])

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
    return { status: 'error', reason: turns ? 'max_turns' : 'agent_error', error: `${opts.label}: ${msg}${turns ? ' (max_turns: raise the agent\'s maxTurns or split the task)' : ''}` }
  }
}

async function call(prompt, opts, gap = EVIDENCE.get(opts.schema)) {
  const r = await attempt(prompt, opts, gap)
  if (r.reason !== 'max_turns' || opts.isolation) return r
  log(`${opts.label}: turn limit; retrying once`)
  return attempt(prompt, { ...opts, label: `${opts.label} retry` }, gap)
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

// What a behind-the-run worktree fast-forwards to: the work branch (its tip carries the plan
// commit, which build-args.json's own base cannot name), else the base itself.
const syncRef = (cfg) => (typeof cfg.branch === 'string' && /^[A-Za-z0-9._\/-]{1,200}$/.test(cfg.branch) ? cfg.branch : cfg.base)

const boundSkills = (t) => list(t.skills).filter((k) => k && typeof k.id === 'string' && typeof k.path === 'string')

// Bound builtins may run the muster CLI (spec-lint, prioritize, pick). `muster` is not on PATH in
// a user's project, so the brief carries the absolute prefix build-args copies from preflight.
const cliPrefix = (cfg) => (typeof cfg.cli === 'string' && /^[^\r\n]{1,1024}$/.test(cfg.cli.trim()) ? cfg.cli.trim() : 'sh "$CLAUDE_PLUGIN_ROOT/runtime/muster.sh"')

function skillLines(t, cfg) {
  const skills = boundSkills(t)
  if (!skills.length) return []
  return [
    'REQUIRED SKILLS: before any other work, Read each file below in full and follow it for this task:',
    ...skills.map((k) => `- ${k.id}: ${k.path}`),
    `Run muster CLI commands as: ${cliPrefix(cfg)} <verb> ... (the bare muster command is not on PATH).`,
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

// Claude Code refuses, in a worktree-isolated agent, shell it cannot prove stays inside the
// worktree (findings: heredocs, loops and chained git commands were refused in the first live
// run). The planned verify command is not ours to rewrite, and merge-wave re-runs it verbatim
// from the main checkout, so the builder runs its parts and says so.
const ISOLATION_LINE = 'Worktree isolation refuses shell it cannot prove stays in this tree (heredocs, loops, variables, ; or && chains around git): create files with Write or Edit and run each git command as its own call. If it refuses a compound verify command, run the same checks as separate plain commands, list those in testsRun and add the deviation "[Verify] <command> refused by isolation; ran its parts" (merge-wave re-runs the planned command).'

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
    ...skillLines(t, cfg),
    `Files in scope: ${list(t.files).join(', ') || '(see PLAN.md)'}`,
    `Verify commands: ${list(t.verify).join(' ; ') || '(see PLAN.md)'}`,
    ISOLATION_LINE,
    'You are in a fresh, isolated git worktree. This brief may be replayed after a crash, so:',
    `1. Check git state first: git status --short; git log --oneline ${cfg.base || 'HEAD~20'}..HEAD. If a commit whose message contains ${tag} already exists and the tree is clean, do not redo the work: re-run the verify commands and report that commit.`,
    cfg.base
      ? `2. Sync and base check. Claude Code starts isolated worktrees from the remote default branch unless worktree.baseRef is "head", so yours may lack the run's plan commit. If .muster/runs/${cfg.runId}/PLAN.md is missing or git merge-base --is-ancestor ${cfg.base} HEAD fails, and git merge-base --is-ancestor HEAD ${syncRef(cfg)} succeeds, run git merge --ff-only ${syncRef(cfg)}. Then git merge-base --is-ancestor ${cfg.base} HEAD must succeed; otherwise stop and return status "blocked" with "base mismatch: HEAD <sha>, base ${cfg.base}". Never reset or rebase.`
      : '2. (no base commit given; skip the base check)',
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

// One verifier per run. ABSTAIN means the verification could not run (a halted build, no
// tasks, a crashed or turn-limited verifier); judgment-only items are HUMAN_NEEDED, never
// ABSTAIN, so they reach the attended merge decision. gsd's decision tree ranks gaps first, so
// HUMAN_NEEDED with gaps is GAPS (the human items stay listed).
async function verifyRun(cfg, tasks, halted) {
  if (halted || !tasks.length) return { verdict: 'ABSTAIN', truths: [], gaps: [halted || 'no tasks to verify'] }
  const v = await call(verifyBrief(cfg, tasks), {
    label: `${cfg.labelPrefix || ''}verify ${cfg.runId}`, phase: 'Verify', schema: VERIFY_RESULT, agentType: 'muster:muster-verifier', ...seat(cfg, 'verifier'),
  })
  if (v.status === 'error') return { verdict: 'ABSTAIN', truths: [], gaps: [v.error], status: 'error', reason: v.reason }
  return v.verdict === 'HUMAN_NEEDED' && filled(v.gaps) ? { ...v, verdict: 'GAPS' } : v
}

// The Workflow tool inlines at most 8000 characters of a result and names its output file for
// the rest (findings: a 3-task team result was 16.6 KB). So the headline leads (a one-line
// summary, the verdict with its gaps and human items, the halt) and the per-task records come
// last; merge-wave reads the full result from that output file. VERIFICATION.md holds every
// truth's evidence and build-args.json each task's verify commands, so neither is repeated.
// argsDigest echoes the build-args digest this build ran with, for merge-wave to match.
function resultOf(cfg, tasks, verification, halted, extra) {
  const v = verification
  const ok = tasks.filter(passed).length
  const counts = [list(v.gaps).length ? `${list(v.gaps).length} gap(s)` : '', list(v.human).length ? `${list(v.human).length} human check(s)` : ''].filter(Boolean).join(', ')
  const summary = `${ok}/${tasks.length} task(s) done with review PASS; verifier ${v.verdict}${counts ? ` (${counts})` : ''}${halted ? `; halted: ${halted}` : ''}${filled(v.truths) ? `; details: .muster/runs/${cfg.runId}/VERIFICATION.md` : ''}`
  const truths = list(v.truths).map((x) => (x && x.status === 'VERIFIED' ? { claim: x.claim, status: x.status } : x))
  return {
    runId: cfg.runId, summary, verification: { ...v, truths }, halted,
    base: cfg.base || null, argsDigest: (cfg.digests && cfg.digests.args) || null, ...(extra || {}),
    tasks: tasks.map(({ verify, ...t }) => t),
  }
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
  if (!ex || ex.status === 'error') return { ...emptyExec(t, 'error', (ex && ex.error) || 'executor failed'), reason: (ex && ex.reason) || 'no_result', ...base, review: null }
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
  return resultOf(cfg, tasks, await verifyRun(cfg, tasks, halted), halted)
}
// </shared>

const cfg = parseArgs(args)
if (!cfg.runId || !Array.isArray(cfg.waves)) {
  return { status: 'error', error: 'build needs args {runId, waves:[[{taskId, title, agentHint, agentType, skills, files, verify}]], base, worktreeConcurrency}' }
}
return await runBuild(cfg)
