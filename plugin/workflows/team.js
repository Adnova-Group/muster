export const meta = {
  name: 'team',
  description: 'Build an approved muster plan with a dev team: test-first split, specialist review seats, wave integration check, scoped fix loop',
  whenToUse: 'Instead of muster:build when the plan has tdd tasks, waves of 2+ tasks or risky diffs. Same args and result as muster:build plus args.topology; the main thread then runs merge-wave.',
  phases: [
    { title: 'Red', detail: 'muster-test-writer commits the failing tests of each tdd task' },
    { title: 'Build', detail: 'one builder per task in its own worktree (muster-executor or the planned specialist); tdd tasks go green in the red worktree' },
    { title: 'Review', detail: 'muster-reviewer plus up to 2 specialist seats picked by the diff; scoped re-review, at most 2 fix rounds' },
    { title: 'Integrate', detail: 'muster-integration-checker on each wave of 2+ tasks; one routed fix round' },
    { title: 'Verify', detail: 'muster-verifier once per run, against the integrated commits' },
  ],
}

// Contract: docs/strategy/stage-2-contracts.md (build) + docs/strategy/dev-team-topologies.md.
// Everything between the <build-shared> markers is build.js's <shared> block from its first
// line up to (not including) reviewLoop, byte for byte: schemas, specialist dispatch, bound
// skills, the worktree limiter and the executor, review, fix and verify briefs. Workflow
// scripts cannot import, so test/workflows-team.test.js enforces the copy; when build.js
// changes, paste the same slice here. The team stages follow the block.

// <build-shared>
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
    consulted: strList,
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
// cap. Whether a claimed commit exists is merge-wave's check: it can run git, this cannot. An
// empty filesChanged is not a gap: a verification-only task commits --allow-empty (live e2e).
const TURN_LIMIT_RE = /without calling StructuredOutput|max(imum)?[ _-]?turns|turn limit/i
const SHA_RE = /^[0-9a-f]{7,64}$/i
const filled = (v) => (Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim() !== '' : v != null)
const gapOf = (r, keys, claim) => {
  const empty = keys.filter((k) => !filled(r[k]))
  return empty.length ? `${claim} without ${empty.join(', ')}` : ''
}
const execGap = (r) => (r.status !== 'done' ? '' : SHA_RE.test(String(r.commit || '')) ? gapOf(r, ['branch', 'worktree', 'testsRun'], 'done') : 'done without a commit sha')
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

// Project policy (live run 8: the reviewer skipped CLAUDE.md and .claude/skills, and a file that
// broke a documented project rule merged; executors were never told to read project skills).
// build-args records the project's instruction files and skills as args.project; every builder,
// fixer and reviewer brief names them, and a review PASS must list them in consulted.
const SAFE_REL = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\/-]{1,200}$/
const oneLine = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)

function projectFiles(cfg) {
  const p = cfg.project && typeof cfg.project === 'object' ? cfg.project : {}
  const instructions = list(p.instructions).filter((f) => typeof f === 'string' && SAFE_REL.test(f))
  const skills = list(p.skills).filter((k) => k && typeof k.path === 'string' && SAFE_REL.test(k.path))
  return { instructions, skills, paths: [...instructions, ...skills.map((k) => k.path)] }
}

function projectLines(cfg, role) {
  const p = projectFiles(cfg)
  if (!p.paths.length) return []
  const files = [...p.instructions, ...p.skills.map((k) => (oneLine(k.about) ? `${k.path} (${oneLine(k.about)})` : k.path))].join('; ')
  if (role === 'review') {
    return [
      `PROJECT RULES: before reviewing, Read each of these project files and check the diff against every rule in them: ${files}.`,
      'A broken project rule is a finding at the severity the rule sets (a rule that calls a violation a blocker makes it a blocker). Set consulted to the paths you read, exactly as listed here.',
    ]
  }
  return [`PROJECT RULES: before working, Read each of these project files and follow them like PLAN.md (a conflict with the plan goes in deviations): ${files}.`]
}

// Specialist agents (wsh-*, surgeon) do not carry muster-executor's protocol, so the brief does.
function contractLines(tag) {
  return [
    'You are building one task for muster. Your own agent instructions do not know muster\'s executor contract; where they conflict, these rules win:',
    '- Stay on your worktree branch: git rev-parse --abbrev-ref HEAD must be an agent-*, worktree-agent-* or worktree-wf_* branch, never main/master/develop or a detached HEAD; otherwise return status "blocked" without committing.',
    '- Never reset, rebase, push, update-ref or force anything. Stage files one at a time (never git add . or git add -A).',
    `- Commit as <type>(<taskId>): <summary> ${tag}, with a conventional type (feat, fix, test, docs, refactor, chore).`,
    '- Do not install new packages (return "blocked" naming the package). An architectural choice the plan leaves open is "blocked" too, with the options.',
    '- Create new files with Write.',
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

// selfCheck PASSED needs every verify command passed, so any status but done reads FAILED, with a
// deviation saying so (live run 7: a blocked executor returned selfCheck PASSED).
function settleSelfCheck(ex) {
  if (!ex || ex.status === 'done' || ex.selfCheck === 'FAILED') return ex
  return { ...ex, selfCheck: 'FAILED', deviations: [...list(ex.deviations), `[muster] selfCheck ${ex.selfCheck || '(none)'} corrected to FAILED: status is ${ex.status}, and PASSED needs done`] }
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
    ...projectLines(cfg, 'build'),
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
    ...projectLines(cfg, 'review'),
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
    ...projectLines(cfg, 'build'),
    'Return the ExecResult for the new HEAD (same branch and worktree).',
  ].filter(Boolean).join('\n')
}

function verifyBrief(cfg, tasks) {
  const wt = `.claude/worktrees/verify-${cfg.runId}`
  return [
    `Verify run ${cfg.runId} goal-backward against .muster/runs/${cfg.runId}/PLAN.md (and CONTEXT.md when present).`,
    `The work is not merged yet. Integrate it in a scratch worktree: git worktree add --detach ${wt} ${cfg.base || 'HEAD'} (reuse it if it already exists), then inside it run git merge --no-ff --no-edit for each commit in order: ${tasks.map((t) => t.commit).join(' ')}`,
    `Check every must-have against that tree and run the verify commands there: ${tasks.flatMap((t) => list(t.verify)).join(' ; ') || '(see PLAN.md)'}`,
    `This brief is the current build attempt's record. Never read the run folder's build-result.json, attempts/ or merge-refusal.json: they describe earlier attempts and merge-wave's state, not these commits.`,
    `Write your report to .muster/runs/${cfg.runId}/VERIFICATION.md relative to your starting directory (the main checkout, not the scratch worktree), then remove the scratch worktree with git worktree remove --force ${wt}.`,
    'ABSTAIN when you cannot gather the evidence; never guess PASS.',
  ].join('\n')
}

// A review PASS must show the project files were read (consulted). One retry names the unread
// ones; a PASS that still leaves one unread becomes ABSTAIN: no PASS on unread project rules.
function unreadRules(cfg, r) {
  const want = projectFiles(cfg).paths
  if (!want.length || !r || r.verdict !== 'PASS') return []
  const got = list(r.consulted).map((c) => String(c).trim().replace(/\\/g, '/'))
  return want.filter((f) => !got.some((g) => g === f || g === `./${f}` || g.endsWith(`/${f}`)))
}

async function reviewCall(cfg, prompt, opts) {
  const r = await call(prompt, opts)
  const unread = unreadRules(cfg, r)
  if (!unread.length) return r
  log(`${opts.label}: PASS without consulting ${unread.join(', ')}; retrying once`)
  const again = await call(`${prompt}\nYour previous review returned PASS without listing these project files in consulted: ${unread.join(', ')}. Read each one now, check the diff against its rules, and list every file you read in consulted.`, { ...opts, label: `${opts.label} rules` })
  const still = unreadRules(cfg, again)
  if (!still.length) return again
  return { ...again, verdict: 'ABSTAIN', findings: [...list(again.findings), { severity: 'blocker', file: still[0], summary: `review returned PASS without reading the project rules in ${still.join(', ')}` }] }
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

// </build-shared>

const RED_RESULT = {
  type: 'object',
  properties: {
    taskId: str,
    status: { type: 'string', enum: ['done', 'blocked', 'error'] },
    branch: str,
    commit: str,
    worktree: str,
    testFiles: strList,
    testsRun: strList,
    failingAsExpected: { type: 'boolean' },
    failures: {
      type: 'array',
      items: { type: 'object', properties: { test: str, reason: str }, required: ['test', 'reason'] },
    },
    deviations: strList,
  },
  required: ['taskId', 'status', 'branch', 'commit', 'worktree', 'testFiles', 'testsRun', 'failingAsExpected', 'failures', 'deviations'],
}
const INTEGRATION_RESULT = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL', 'ABSTAIN'] },
    commitsChecked: strList,
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: { severity: str, taskIds: strList, file: str, line: { type: 'integer' }, summary: str },
        required: ['severity', 'taskIds', 'file', 'summary'],
      },
    },
    testsRun: strList,
    testsPassed: { type: 'boolean' },
  },
  required: ['verdict', 'commitsChecked', 'findings', 'testsRun', 'testsPassed'],
}

// Turn-limit evidence (F15, see call()) for the team-only results. A seat does not re-run the
// verify commands, so its PASS needs only the commit it reviewed.
EVIDENCE.set(RED_RESULT, (r) => (r.status !== 'done' ? '' : SHA_RE.test(String(r.commit || '')) ? gapOf(r, ['branch', 'worktree', 'testFiles', 'testsRun'], 'done') : 'done without a commit sha'))
EVIDENCE.set(INTEGRATION_RESULT, (r) => (r.verdict === 'PASS' ? gapOf(r, ['testsRun'], 'PASS') : ''))
const seatGap = (r) => (r.verdict === 'PASS' ? gapOf(r, ['commitReviewed'], 'PASS') : '')

const MAX_SEATS = 4
const TEST_WRITER = 'muster:muster-test-writer'
const REVIEWER = 'muster:muster-reviewer'
// A seat's agent type: a plugin agent (muster:prt-pr-test-analyzer) or a bare project or user
// agent (house-style-reviewer, from .claude/agents/). A safe name charset only: the value becomes
// the agent() call's agentType, never brief text (src/plan-lint.js REVIEW_SEAT_RE matches it).
const SEAT_AGENT_RE = /^(?:[a-z0-9][a-z0-9-]{0,62}:)?[a-z0-9][a-z0-9-]{0,80}$/

// Specialist review seats, chosen by path/title pattern: the script has no diff text, so it
// matches the builder's filesChanged, the task's files and its title. First matching rules
// win, at most topology.maxSeats per task. Agent types are the agents' frontmatter names
// (wsh-security-auditor runs as backend-development-security-auditor). The prt-* seats are the
// pr-review-toolkit agents vendored by the complements track; a seat whose agent is not
// installed errors, and an errored seat is recorded as NOT_COUNTED, never as a pass or fail.
const SEAT_RULES = [
  { seat: 'security', agentType: 'muster:backend-development-security-auditor', pattern: '(auth|login|session|token|passw|secret|crypt|permission|oauth|jwt|csrf|cors|saniti[sz])', focus: 'security: injection, broken authorization, secrets, unsafe input handling' },
  { seat: 'silent-failure', agentType: 'muster:prt-silent-failure-hunter', pattern: '(error|retry|fallback|catch|handler|client|adapter|queue|worker)', focus: 'silent failures: swallowed errors, empty catch blocks, fallbacks that hide a broken path' },
  { seat: 'types', agentType: 'muster:prt-type-design-analyzer', pattern: '(\\.d\\.ts$|(^|/)types?/|schema|(^|/)models?/)', focus: 'type design: invariants the new types fail to express or enforce' },
  { seat: 'tests', agentType: 'muster:prt-pr-test-analyzer', pattern: '((^|/)(test|tests|__tests__|spec)/|\\.(test|spec)\\.)', focus: 'test quality: behavior actually asserted, missing edge and error cases', skipTdd: true },
  { seat: 'ux', agentType: 'muster:intent-vigil', pattern: '\\.(tsx|jsx|vue|svelte|css|scss|html)$', focus: 'UX and accessibility: empty, error and loading states, keyboard and screen-reader paths, WCAG 2.2' },
]

const pick = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt)

function topologyOf(cfg) {
  const t = cfg.topology && typeof cfg.topology === 'object' ? cfg.topology : {}
  return {
    testFirst: pick(t.testFirst, ['auto', 'all', 'off'], 'auto'),
    seats: pick(t.seats, ['auto', 'off'], 'auto'),
    maxSeats: Number.isInteger(t.maxSeats) && t.maxSeats >= 0 ? Math.min(t.maxSeats, MAX_SEATS) : 2,
    integrate: pick(t.integrate, ['auto', 'all', 'off'], 'auto'),
    escalate: t.escalate !== false,
    seatRules: Array.isArray(t.seatRules) ? t.seatRules : SEAT_RULES,
  }
}

const isTdd = (top, t) => top.testFirst === 'all' || (top.testFirst === 'auto' && (t.tdd === true || t.tdd === 'true'))
const isBlocker = (f) => /^(blocker|critical|high)$/i.test(String((f && f.severity) || ''))
const findingLine = (f) => `- ${f.severity} ${f.file}${f.line ? `:${f.line}` : ''}: ${f.summary}`

// Same sync rule as execBrief step 2 (findings F1, amendment 14): the red worktree is isolated too.
function syncStep(cfg) {
  return cfg.base
    ? `2. Sync and base check. If .muster/runs/${cfg.runId}/PLAN.md is missing or git merge-base --is-ancestor ${cfg.base} HEAD fails, and git merge-base --is-ancestor HEAD ${syncRef(cfg)} succeeds, run git merge --ff-only ${syncRef(cfg)}. Then git merge-base --is-ancestor ${cfg.base} HEAD must succeed; otherwise stop and return status "blocked" with "base mismatch: HEAD <sha>, base ${cfg.base}". Never reset or rebase.`
    : '2. (no base commit given; skip the base check)'
}

function redBrief(cfg, t, prior) {
  const tag = `[${cfg.runId}/${t.taskId} red]`
  return [
    `Run ${cfg.runId}, task ${t.taskId}: ${t.title || ''}`,
    'Mode: red. Write the failing tests for this task. Another agent implements it afterwards and may not change your tests.',
    `The task is defined in .muster/runs/${cfg.runId}/PLAN.md (its <behavior> and <done>); that file is the source of truth.`,
    `Files the implementation will touch (read-only for you): ${list(t.files).join(', ') || '(see PLAN.md)'}`,
    `Verify commands the implementer will run: ${list(t.verify).join(' ; ') || '(see PLAN.md)'}`,
    ...projectLines(cfg, 'build'),
    ISOLATION_LINE,
    'You are in a fresh, isolated git worktree. This brief may be replayed after a crash, so:',
    `1. Check git state first: git status --short; git log --oneline ${cfg.base || 'HEAD~20'}..HEAD. If a commit whose message contains ${tag} already exists and the tree is clean, do not redo it: re-run the tests and report that commit.`,
    syncStep(cfg),
    prior.length
      ? `3. Integrate the earlier waves first. For each commit C of ${prior.map((p) => p.commit).join(' ')}: git merge-base --is-ancestor C HEAD || git merge --no-ff --no-edit C`
      : '3. (first wave: nothing to integrate)',
    `4. Write the tests, run them, confirm each fails for the right reason, and commit only test files with a message containing ${tag}.`,
    'Return RedResult: branch, commit = full git rev-parse HEAD, worktree = pwd, testFiles, testsRun, failingAsExpected, failures and deviations.',
  ].join('\n')
}

// The green phase: the planned builder (specialist or muster-executor) continues in the red
// worktree, with the same contract and skill lines execBrief gives it.
function greenBrief(cfg, t, red) {
  const tag = `[${cfg.runId}/${t.taskId}]`
  const specialist = builderType(t) !== EXECUTOR
  return [
    `Run ${cfg.runId}, task ${t.taskId}: ${t.title || ''} (green brief: the test-first split).`,
    `Your task is defined in .muster/runs/${cfg.runId}/PLAN.md; that file is the source of truth.`,
    t.agentHint && !specialist ? `Domain lens for this task: ${t.agentHint}.` : '',
    ...(specialist ? contractLines(tag) : []),
    ...skillLines(t, cfg),
    ...projectLines(cfg, 'build'),
    `Work in the test writer's worktree ${red.worktree}: prefix every shell command with cd ${red.worktree} && . Do not create a new worktree or branch.`,
    `Failing tests are committed at the red commit ${red.commit} (${list(red.testFiles).join(', ') || 'see git show --stat'}). They are the spec: make them pass. Never edit, delete, skip or loosen them; if one is wrong, return "blocked" naming it.`,
    `Files in scope: ${list(t.files).join(', ') || '(see PLAN.md)'}`,
    `Verify commands: ${list(t.verify).join(' ; ') || '(see PLAN.md)'}`,
    `1. Check git state first: git rev-parse --abbrev-ref HEAD must print ${red.branch}, otherwise return status "blocked". If git log --oneline ${red.commit}..HEAD already shows a commit containing ${tag} and the tree is clean, do not redo it: re-run the verify commands and report it.`,
    `2. Implement the task, run the verify commands (the red tests must now pass), and commit with a message containing ${tag}. Do not write a SUMMARY file: merge-wave records SUMMARY-${t.taskId}.md from your result.`,
    `3. Run git diff --name-only ${red.commit}..HEAD. Any red test file it lists goes in deviations as [TestEdit] <file>.`,
    `Return the ExecResult: branch, commit = full git rev-parse HEAD, worktree = ${red.worktree}, testsRun = the exact commands you ran, plus testsPassed, selfCheck and deviations.`,
  ].filter(Boolean).join('\n')
}

const scopeLine = (cfg, ex, prior) => {
  const not = [cfg.base, ...prior.map((p) => p.commit)].filter(Boolean).join(' ')
  return `git log -p --no-merges ${ex.commit}${not ? ` --not ${not}` : ''}`
}

function redGuard(red) {
  if (!red) return []
  return [`Test-first task: the tests at red commit ${red.commit} (${list(red.testFiles).join(', ')}) were written by an independent test writer and are the spec. Run git diff ${red.commit} HEAD -- ${list(red.testFiles).join(' ')} in the worktree: a deleted, skipped or loosened assertion is a blocker.`]
}

// build.js's review brief plus the test-first guard.
function teamReviewBrief(cfg, t, ex, prior, red) {
  const edits = list(ex.deviations).filter((d) => /^\[TestEdit\]/.test(d))
  return [
    reviewBrief(cfg, t, ex, prior),
    ...redGuard(red),
    edits.length ? `The builder reported editing red tests: ${edits.join('; ')}` : '',
  ].filter(Boolean).join('\n')
}

function seatBrief(cfg, t, ex, prior, s) {
  return [
    `Specialist review seat "${s.seat}" for task ${t.taskId} of run ${cfg.runId}: ${t.title || ''}`,
    `Review ONLY for ${s.focus}. A primary reviewer covers everything else; do not repeat general findings.`,
    `Code: branch ${ex.branch}, commit ${ex.commit}, worktree ${ex.worktree}. The task is defined in .muster/runs/${cfg.runId}/PLAN.md.`,
    `Review only this task's own commits: ${scopeLine(cfg, ex, prior)}`,
    'Read only: do not edit files or commit.',
    `Set taskId to ${t.taskId} and commitReviewed to the full sha you reviewed (it must be ${ex.commit}).`,
    'verdict FAIL only for a concrete problem in your focus, with file and line and severity blocker or high; PASS with an empty findings list when you find none; ABSTAIN when you cannot review. Never pad findings.',
  ].join('\n')
}

// Scoped re-review (superpowers subagent-driven-development, fix-loop.md): the reviewer judges
// each open finding ADDRESSED / NOT ADDRESSED from the fix diff only, plus new breakage in it.
// `boundary` ({files, cross}) scopes an integration fix to the task's own planned files.
function rereviewBrief(cfg, t, ex, prevCommit, open, round, red, boundary) {
  const rules = projectFiles(cfg).paths
  return [
    `Re-review task ${t.taskId} of run ${cfg.runId} after fix round ${round} (scoped re-review): ${t.title || ''}`,
    'Open findings from the last review:',
    ...open.map(findingLine),
    `Fix diff: cd ${ex.worktree} && git log -p --no-merges ${prevCommit}..${ex.commit}`,
    `Re-run the verify commands inside the worktree: ${list(t.verify).join(' ; ') || '(see PLAN.md)'}`,
    'For each open finding decide ADDRESSED or NOT ADDRESSED from the fix diff, and report any new breakage the fix diff introduces. Do not re-review unchanged code.',
    rules.length ? `Project rules apply to the fix diff too (${rules.join(', ')}): a fix that breaks one is a new finding.` : '',
    ...(boundary ? boundaryLines(ex, prevCommit, boundary) : []),
    ...redGuard(red),
    'Read only: do not edit files or commit.',
    `Set taskId to ${t.taskId} and commitReviewed to ${ex.commit}.`,
    'verdict PASS only when every open finding is addressed and the fix adds no blocker; FAIL with one finding per NOT ADDRESSED item or new problem; ABSTAIN when you cannot review.',
  ].filter(Boolean).join('\n')
}

// An integration fix stays inside its own task (live run 8: the fixer for 02 merged sibling 01
// into its branch and edited 01's test file, and the scoped re-review passed it). The fixer edits
// only the task's planned files or declares the crossing as [CrossTask]; the re-review counts a
// sibling merge, a file outside the plan or a declared crossing as a blocker.
const CROSS_RE = /^\[CrossTask\]/

function boundaryLines(ex, prevCommit, boundary) {
  return [
    `This is an integration fix. The task's planned files are: ${boundary.files.join(', ') || '(see PLAN.md)'}. Run cd ${ex.worktree} && git log --merges --oneline ${prevCommit}..${ex.commit} and cd ${ex.worktree} && git diff --name-only ${prevCommit} ${ex.commit}: a merge commit (a sibling task merged in) or a changed file outside the planned files (.muster/runs/ excepted) is a blocker finding; the integration checker merges the wave itself.`,
    boundary.cross.length ? `The fixer declared these cross-task edits; each is a blocker finding: ${boundary.cross.join('; ')}` : '',
  ].filter(Boolean)
}

function integrateFixBrief(cfg, t, ex, findings) {
  const tag = `[${cfg.runId}/${t.taskId} integrate 1]`
  return [
    `Fix integration findings for task ${t.taskId} of run ${cfg.runId}: the task passed review alone but does not wire up with its wave siblings.`,
    `Work in the builder's worktree ${ex.worktree}: prefix every shell command with cd ${ex.worktree} && . Do not create a new worktree or branch.`,
    `1. Check git state first: git rev-parse --abbrev-ref HEAD must print ${ex.branch}, otherwise return status "blocked". If git log --oneline ${ex.commit}..HEAD already shows a commit containing ${tag}, do not redo it: re-run the verify commands and report it.`,
    '2. Address exactly these findings on your side of the connection, nothing else:',
    ...findings.map(findingLine),
    `Stay inside this task: edit only its planned files (${list(t.files).join(', ') || 'see PLAN.md'}). Never merge, cherry-pick or copy a sibling task's commits or files into this branch: the integration checker merges the wave again after your fix. Leave undone any part of a finding that needs another task's files, and record it as the deviation "[Deferred] <file>: <what>"; if no part of the findings lies in your files, return status "blocked". Editing a file outside the planned list anyway needs the deviation "[CrossTask] <file>: <why>", which the re-review counts as a blocker.`,
    ...projectLines(cfg, 'build'),
    `3. Re-run the verify commands (${list(t.verify).join(' ; ') || 'see PLAN.md'}) and commit with a message containing ${tag}.`,
    'Return the ExecResult for the new HEAD (same branch and worktree).',
  ].join('\n')
}

function integrateBrief(cfg, w, tasks, prior, round) {
  const wt = `.claude/worktrees/integrate-${cfg.runId}-w${w + 1}`
  return [
    `Integration check for wave ${w + 1} of run ${cfg.runId}${round ? ` (re-check after fix round ${round})` : ''}.`,
    'These tasks were built in parallel from the same base; no task saw the others\' code:',
    ...tasks.map((r) => `- ${r.taskId} ${r.title || ''}: branch ${r.branch}, commit ${r.commit}, files ${list(r.filesChanged).join(', ') || '(see PLAN.md)'}`),
    `The tasks are defined in .muster/runs/${cfg.runId}/PLAN.md.`,
    `Scratch worktree: git worktree add --detach ${wt} ${cfg.base || 'HEAD'} (reuse it if it exists), then inside it git merge --no-ff --no-edit, in order: ${[...prior.map((p) => p.commit), ...tasks.map((r) => r.commit)].join(' ')}`,
    `Run every verify command and the project's full test suite there: ${tasks.flatMap((r) => list(r.verify)).join(' ; ') || '(see PLAN.md)'}`,
    `Remove the scratch worktree with git worktree remove --force ${wt} before returning.`,
    'Read only on source. verdict PASS only when no blocker remains; every blocker names in taskIds the task(s) whose commit must change, and each task\'s fixer may edit only that task\'s planned files, so split a fix that spans two tasks\' files into one finding per task; ABSTAIN when you cannot build the merged tree.',
  ].join('\n')
}

// Seats for one task: an explicit t.reviewSeats list (seat names or agent types, from PLAN.md's
// review_seats) wins; otherwise the first rules whose pattern matches a changed file, a task file
// or the title. A listed agent no rule names reviews by its own instructions.
function selectSeats(top, t, ex, tdd) {
  if (top.seats === 'off' || top.maxSeats === 0) return []
  const rules = top.seatRules
  const exclude = new Set([REVIEWER, builderType(t)])
  let chosen
  if (Array.isArray(t.reviewSeats)) {
    chosen = t.reviewSeats.map((s) => rules.find((r) => r.seat === s || r.agentType === s) || { seat: String(s), agentType: String(s), focus: 'the rules and the specialty your own agent instructions define' })
  } else {
    const hay = [...list(ex.filesChanged), ...list(t.files), String(t.title || '')]
    chosen = rules.filter((r) => {
      if (r.skipTdd && tdd) return false
      let re
      try { re = new RegExp(r.pattern, 'i') } catch (e) { return false }
      return hay.some((h) => re.test(h))
    })
  }
  const seen = new Set()
  return chosen.filter((r) => SEAT_AGENT_RE.test(String(r.agentType)) && !exclude.has(r.agentType) && !seen.has(r.agentType) && seen.add(r.agentType)).slice(0, top.maxSeats)
}

// The primary reviewer decides; a seat adds its blocker-grade findings only when it reviewed
// the right commit and returned FAIL. A seat's PASS never overrides the primary reviewer.
function combineReview(ex, primary, seatRuns) {
  const seats = seatRuns.map(({ s, r }) => {
    const ok = !!r && r.commitReviewed === ex.commit && ['PASS', 'FAIL', 'ABSTAIN'].includes(r.verdict)
    const blockers = ok && r.verdict === 'FAIL' ? list(r.findings).filter(isBlocker) : []
    const out = { seat: s.seat, agentType: s.agentType, verdict: ok ? r.verdict : 'NOT_COUNTED', counted: blockers.length > 0, findings: blockers }
    if (!ok) out.error = (r && r.error) || 'missing or mismatched commitReviewed'
    return out
  })
  if (!primary || !['PASS', 'FAIL', 'ABSTAIN'].includes(primary.verdict)) return { review: primary, seats }
  const extra = seats.flatMap((s) => s.findings.map((f) => ({ ...f, summary: `[${s.seat}] ${f.summary}` })))
  if (primary.verdict === 'ABSTAIN' || !extra.length) return { review: primary, seats }
  return { review: { ...primary, verdict: 'FAIL', findings: [...list(primary.findings), ...extra] }, seats }
}

// build.js's loop plus: specialist seats in round 0, scoped re-review in later rounds, a stall
// stop when the open-finding count does not fall, and the last fix round on models.escalate.
async function teamReviewLoop(cfg, top, t, ex, prior, red) {
  const pre = cfg.labelPrefix || ''
  let current = ex
  const reviews = []
  let seats = []
  let lastCount = Infinity
  let prevCommit = null
  for (let round = 0; ; round++) {
    let rv
    if (round === 0) {
      const chosen = selectSeats(top, t, current, !!red)
      const [primary, ...seatRvs] = await parallel([
        () => reviewCall(cfg, teamReviewBrief(cfg, t, current, prior, red), {
          label: `${pre}review ${t.taskId} r0`, phase: 'Review', schema: REVIEW_RESULT, agentType: REVIEWER, ...seat(cfg, 'reviewer'),
        }),
        ...chosen.map((s) => () => call(seatBrief(cfg, t, current, prior, s), {
          label: `${pre}seat ${s.seat} ${t.taskId}`, phase: 'Review', schema: REVIEW_RESULT, agentType: s.agentType, ...seat(cfg, 'reviewer'),
        }, seatGap)),
      ])
      const combined = combineReview(current, primary, chosen.map((s, i) => ({ s, r: seatRvs[i] })))
      rv = combined.review || { status: 'error', error: `review ${t.taskId}: no result` }
      seats = combined.seats
    } else {
      rv = await call(rereviewBrief(cfg, t, current, prevCommit, list(reviews[reviews.length - 1].findings), round, red), {
        label: `${pre}review ${t.taskId} r${round}`, phase: 'Review', schema: REVIEW_RESULT, agentType: REVIEWER, ...seat(cfg, 'reviewer'),
      })
    }
    reviews.push(rv)
    if (rv.verdict !== 'FAIL' || round >= REVIEW_CAP) break
    const open = list(rv.findings)
    if (round > 0 && open.length >= lastCount) {
      log(`${pre}${t.taskId}: open findings stalled at ${open.length}; stopping the fix loop`)
      break
    }
    lastCount = open.length
    const escalate = round + 1 === REVIEW_CAP && top.escalate && cfg.models && cfg.models.escalate
    const fx = await call(fixBrief(cfg, t, current, { findings: open }, round + 1), {
      label: `${pre}fix ${t.taskId} r${round + 1}`, phase: 'Review', schema: EXEC_RESULT, agentType: EXECUTOR, ...seat(cfg, escalate ? 'escalate' : 'executor'),
    })
    if (fx.status !== 'done') {
      current = { ...current, deviations: [...list(current.deviations), `fix round ${round + 1}: ${fx.error || fx.status}`] }
      break
    }
    prevCommit = current.commit
    current = { ...fx, taskId: t.taskId, branch: current.branch, worktree: current.worktree, skillsApplied: current.skillsApplied }
  }
  return { current, reviews, seats }
}

const passed = (r) => !!r && r.status === 'done' && r.selfCheck === 'PASSED' && !!r.review && r.review.verdict === 'PASS'

// Stage 1 of a task. Worktree-creating agents (builder, test writer) go through the limiter;
// the green phase reuses the red worktree.
async function buildTask(cfg, top, t, prior, startBuilder) {
  const pre = cfg.labelPrefix || ''
  if (!isTdd(top, t)) {
    const ex = await startBuilder(() => call(execBrief(cfg, t, prior), {
      label: `${pre}build ${t.taskId}`, phase: 'Build', schema: EXEC_RESULT, agentType: builderType(t), isolation: 'worktree', ...seat(cfg, 'executor'),
    }))
    return { ex, red: null }
  }
  const red = await startBuilder(() => call(redBrief(cfg, t, prior), {
    label: `${pre}red ${t.taskId}`, phase: 'Red', schema: RED_RESULT, agentType: TEST_WRITER, isolation: 'worktree', ...seat(cfg, 'testWriter'),
  }))
  if (red.status !== 'done' || red.failingAsExpected !== true || !red.commit || !red.worktree) {
    const why = red.error || list(red.deviations).join('; ') || 'tests did not fail as expected'
    return { ex: { ...emptyExec(t, red.status === 'error' ? 'error' : 'blocked', `red phase: ${why}`), ...(red.reason ? { reason: red.reason } : {}), branch: red.branch || '', worktree: red.worktree || '' }, red }
  }
  const ex = await call(greenBrief(cfg, t, red), {
    label: `${pre}build ${t.taskId}`, phase: 'Build', schema: EXEC_RESULT, agentType: builderType(t), ...seat(cfg, 'executor'),
  })
  if (ex.status !== 'done') return { ex, red }
  const moved = ex.branch && ex.branch !== red.branch ? [`green phase reported branch ${ex.branch}; the red branch is ${red.branch}`] : []
  return { ex: { ...ex, branch: red.branch, worktree: red.worktree, deviations: [...list(ex.deviations), ...moved] }, red }
}

async function teamFinishTask(cfg, top, t, w, built, prior) {
  let ex = built && built.ex
  const red = (built && built.red) || null
  const base = { title: t.title || '', wave: w + 1, verify: list(t.verify), agentType: builderType(t), red, seats: [] }
  const proven = new Set(list(ex && ex.skillsApplied).filter((u) => u && u.how).map((u) => u.id))
  const missing = boundSkills(t).map((k) => k.id).filter((id) => !proven.has(id))
  if (missing.length) base.skillsMissing = missing
  if (!ex || ex.status === 'error') return { ...emptyExec(t, 'error', (ex && (ex.error || list(ex.deviations)[0])) || 'executor failed'), reason: (ex && ex.reason) || 'no_result', ...base, review: null }
  ex = settleSelfCheck(ex)
  if (ex.status !== 'done' || ex.selfCheck !== 'PASSED') return { ...ex, taskId: t.taskId, ...base, review: null }
  const { current, reviews, seats } = await teamReviewLoop(cfg, top, t, ex, prior, red)
  return { ...current, ...base, seats, review: reviews[reviews.length - 1], reviewRounds: reviews.length, fixRounds: reviews.length - 1 }
}

// One wave of 2+ tasks: the integration checker merges them on a scratch worktree. Blockers
// route back to the named tasks' fixers (one round, scoped re-review each), then one re-check.
// PASS, ABSTAIN or an error is advisory (the verifier still gates the run); a FAIL that
// survives the fix round halts the run like a failed wave.
async function integrateWave(cfg, top, w, waveTasks, done, prior) {
  const pre = cfg.labelPrefix || ''
  if (top.integrate === 'off' || (top.integrate === 'auto' && done.length < 2)) return null
  const check = (round) => call(integrateBrief(cfg, w, done, prior, round), {
    label: `${pre}integrate w${w + 1} r${round}`, phase: 'Integrate', schema: INTEGRATION_RESULT, agentType: 'muster:muster-integration-checker', ...seat(cfg, 'integrator'),
  })
  const record = { wave: w + 1, checks: [], fixed: [], verdict: null }
  const blockersOf = (r) => (r.verdict === 'FAIL' ? list(r.findings).filter(isBlocker) : [])
  let ir = await check(0)
  record.checks.push(ir)
  let blockers = blockersOf(ir)
  if (!blockers.length) { record.verdict = ir.verdict || 'ABSTAIN'; return record }
  const targets = done.filter((r) => blockers.some((f) => list(f.taskIds).includes(r.taskId)))
  if (!targets.length) { record.verdict = 'FAIL'; record.reason = 'integration blockers name no task of this wave'; return record }
  const escalate = top.escalate && cfg.models && cfg.models.escalate
  const fixes = await parallel(targets.map((r) => async () => {
    const t = waveTasks.find((x) => x.taskId === r.taskId) || r
    const mine = blockers.filter((f) => list(f.taskIds).includes(r.taskId))
    const fx = await call(integrateFixBrief(cfg, t, r, mine), {
      label: `${pre}integrate-fix ${r.taskId}`, phase: 'Integrate', schema: EXEC_RESULT, agentType: EXECUTOR, ...seat(cfg, escalate ? 'escalate' : 'executor'),
    })
    if (fx.status !== 'done') return { taskId: r.taskId, ok: false, why: fx.error || fx.status }
    const next = { ...fx, taskId: r.taskId, branch: r.branch, worktree: r.worktree, skillsApplied: r.skillsApplied }
    const files = list(t.files)
    const cross = list(fx.deviations).filter((d) => CROSS_RE.test(String(d)))
    const rv = await call(rereviewBrief(cfg, t, next, r.commit, mine, 1, r.red, { files, cross }), {
      label: `${pre}review ${r.taskId} integrate`, phase: 'Integrate', schema: REVIEW_RESULT, agentType: REVIEWER, ...seat(cfg, 'reviewer'),
    })
    // A declared crossing fails the fix whatever the re-review says.
    if (rv.verdict === 'PASS' && cross.length) return { taskId: r.taskId, ok: false, next, review: rv, why: `cross-task edit: ${cross.join('; ')}` }
    return { taskId: r.taskId, ok: rv.verdict === 'PASS', next, review: rv, why: rv.verdict === 'PASS' ? null : `re-review ${rv.verdict || rv.error}` }
  }))
  for (const f of fixes) {
    if (!f) continue
    record.fixed.push({ taskId: f.taskId, ok: f.ok, why: f.why || null })
    if (!f.ok) continue
    const i = done.findIndex((r) => r.taskId === f.taskId)
    const keep = done[i]
    done[i] = { ...keep, ...f.next, title: keep.title, wave: keep.wave, verify: keep.verify, agentType: keep.agentType, red: keep.red, seats: keep.seats, review: f.review, reviewRounds: (keep.reviewRounds || 0) + 1, integrationFix: true }
  }
  if (record.fixed.length < targets.length || record.fixed.some((f) => !f.ok)) { record.verdict = 'FAIL'; record.reason = 'integration fix round did not pass'; return record }
  ir = await check(1)
  record.checks.push(ir)
  blockers = blockersOf(ir)
  record.verdict = blockers.length ? 'FAIL' : ir.verdict || 'ABSTAIN'
  if (blockers.length) record.reason = 'integration blockers survived the fix round'
  return record
}

async function runTeam(cfg) {
  const pre = cfg.labelPrefix || ''
  const top = topologyOf(cfg)
  const waves = Array.isArray(cfg.waves) ? cfg.waves.map(list) : []
  // A --from-wave N rebuild starts at plan wave N: human-facing text uses plan numbering; the
  // per-task `wave` field stays relative (merge-wave offsets it by the committed fromWave).
  const planWave = (w) => w + (Number.isInteger(cfg.fromWave) && cfg.fromWave > 1 ? cfg.fromWave : 1)
  const tasks = []
  const integration = []
  const prior = []
  let halted = null
  const startBuilder = limiter(Math.max(1, Math.floor(Number(cfg.worktreeConcurrency)) || WORKTREE_CAP))
  for (let w = 0; w < waves.length; w++) {
    const wave = waves[w]
    if (halted) {
      for (const t of wave) tasks.push({ ...emptyExec(t, 'blocked', `skipped: ${halted}`), title: t.title || '', wave: w + 1, verify: list(t.verify), red: null, seats: [], review: null })
      continue
    }
    log(`${pre}wave ${planWave(w)}/${planWave(waves.length - 1)}: ${wave.length} task(s), ${wave.filter((t) => isTdd(top, t)).length} test-first`)
    const before = prior.slice()
    const results = await pipeline(
      wave,
      (t) => buildTask(cfg, top, t, before, startBuilder),
      (built, t) => teamFinishTask(cfg, top, t, w, built, before),
    )
    const done = results.map((r, i) => r || { ...emptyExec(wave[i], 'error', 'pipeline dropped the task'), wave: w + 1, verify: list(wave[i].verify), red: null, seats: [], review: null })
    if (!done.some((r) => !passed(r))) {
      const rec = await integrateWave(cfg, top, w, wave, done, before)
      if (rec) {
        integration.push(rec)
        if (rec.verdict === 'FAIL') halted = `wave ${w + 1} failed the integration check (${rec.reason || 'blockers'})`
      }
    }
    tasks.push(...done)
    const bad = done.filter((r) => !passed(r))
    if (bad.length && !halted) halted = `wave ${planWave(w)} did not pass (${bad.map((r) => r.taskId).join(', ')})`
    if (!halted) prior.push(...done.map((r) => ({ taskId: r.taskId, commit: r.commit })))
  }
  if (halted) log(`${pre}halted: ${halted}`)
  const { seatRules, ...topology } = top
  // The red record's failure list is the test writer's evidence for its reviewer, not for the
  // main thread; the result keeps what identifies the red commit.
  const slim = tasks.map((r) => (r.red ? { ...r, red: { status: r.red.status, commit: r.red.commit, testFiles: r.red.testFiles, failingAsExpected: r.red.failingAsExpected } } : r))
  return resultOf(cfg, slim, await verifyRun(cfg, tasks, halted), halted, { topology, integration })
}

const cfg = parseArgs(args)
if (!cfg.runId || !Array.isArray(cfg.waves)) {
  return { status: 'error', error: 'team needs args {runId, waves:[[{taskId, title, agentHint, agentType, skills, files, verify, tdd, reviewSeats}]], base, branch, models, topology, worktreeConcurrency}' }
}
return await runTeam(cfg)
