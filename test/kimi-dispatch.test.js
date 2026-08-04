// Kimi-native dispatch: AgentSwarm waves + /goal run loop.
// Constants here are pinned to the shipped kimi binary's own tool schema
// (v0.29.0, unstripped; re-verified on v0.30.0, 2026-07-29) -- notably {{item}}, the >=2-item floor, the 128 cap,
// the DISTINCT-prompts rule (absent from published docs), and
// GOAL_EXIT_CODES {complete:0, blocked:3, paused:6}.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trackedMkdtempSync as mkdtempSync } from "../test-support/helpers.js";
import {
  kimiSwarmCall, kimiAgentCall, kimiGoalInvocation, kimiProcessDispatch, withKimiProcessBriefFile, interpretKimiGoalExit, resolveKimiWaveDispatch,
  kimiResumeState,
  interpretKimiBackgroundCompletion, detectKimiQuotaFault, quotaFaultLines,
  KIMI_SWARM_PLACEHOLDER, KIMI_SWARM_MAX_SUBAGENTS, KIMI_GOAL_EXIT_CODES, KIMI_GOAL_MAX_OBJECTIVE, KIMI_PROCESS_MAX_BRIEF, KIMI_DISPATCH_MODES
} from "../src/kimi-dispatch.js";

test("Kimi resumes use parent evidence and cannot dispatch a 101st continuation", () => {
  const attempts = Array.from({ length: 100 }, (_, index) => ({
    candidateFingerprint: index.toString(16).padStart(64, "0"),
    errorFingerprint: (index + 100).toString(16).padStart(64, "0"),
  }));
  // Kimi resumes inherit the dispatch execution budget (progress-aware-execution-budgets):
  // a bare resume policy exhausts the total-attempts budget and reports it as such, rather
  // than running to the legacy 100-continuation recovery cap.
  assert.deepEqual(kimiResumeState({ attempts }), {
    retry: false, reason: "max-total-attempts", noProgressCount: 1,
  });
  assert.throws(() => kimiResumeState({ attempts: [{
    candidateFingerprint: "agent-selected", errorFingerprint: "also-untrusted",
  }] }), /parent-computed/);
  assert.throws(() => kimiResumeState({ attempts, outcomes: ["reset"] }), /unsupported.*outcomes/);
});
import { KIMI_LANES, kimiLaneEnv } from "../src/kimi.js";

// --- AgentSwarm -------------------------------------------------------------

test("kimiSwarmCall: builds the swarm packet with the exact binary placeholder", () => {
  assert.equal(KIMI_SWARM_PLACEHOLDER, "{{item}}");
  const call = kimiSwarmCall({
    promptTemplate: `Review ${KIMI_SWARM_PLACEHOLDER} for likely regressions.`,
    items: ["src/a.ts", "src/b.ts"],
    subagentType: "muster-reviewer",
    model: "primary"
  });
  assert.equal(call.tool, "AgentSwarm");
  assert.deepEqual(call.items, ["src/a.ts", "src/b.ts"]);
  assert.equal(call.subagent_type, "muster-reviewer");
  assert.equal(call.model, "primary");
  assert.equal(call.soleToolCall, true); // the binary enforces this contract
});

test("kimiSwarmCall: rejects a template without the placeholder", () => {
  assert.throws(() => kimiSwarmCall({ promptTemplate: "Review the code.", items: ["a", "b"] }), /must contain the \{\{item\}\}/);
});

test("kimiSwarmCall: enforces the >=2 item floor unless resuming", () => {
  assert.throws(() => kimiSwarmCall({ promptTemplate: "x {{item}}", items: ["only-one"] }), /at least 2 items/);
  // with resume_agent_ids a single item is legal
  const call = kimiSwarmCall({ promptTemplate: "x {{item}}", items: ["one"], resumeAgentIds: { "agent-0": "continue" } });
  assert.deepEqual(call.resume_agent_ids, { "agent-0": "continue" });
});

test("kimiSwarmCall: enforces the 128-subagent cap", () => {
  const items = Array.from({ length: KIMI_SWARM_MAX_SUBAGENTS + 1 }, (_, i) => `f${i}`);
  assert.throws(() => kimiSwarmCall({ promptTemplate: "x {{item}}", items }), /at most 128 subagents/);
});

test("kimiSwarmCall: catches DUPLICATE expanded prompts before dispatch (undocumented binary rule)", () => {
  // Kimi rejects the WHOLE swarm when two items expand to the same prompt.
  // Catching it here costs nothing; discovering it costs a wave round trip.
  assert.throws(
    () => kimiSwarmCall({ promptTemplate: "Audit {{item}} now.", items: ["src/a.ts", "src/a.ts"] }),
    /must expand to DISTINCT prompts/
  );
  // a template that ignores the item would collapse every prompt -- but that
  // is already caught by the placeholder rule, so distinctness only bites on
  // genuinely duplicated items.
  assert.doesNotThrow(() => kimiSwarmCall({ promptTemplate: "Audit {{item}}.", items: ["a", "b"] }));
});

test("kimiSwarmCall: model must be a lane, never a model id", () => {
  assert.throws(() => kimiSwarmCall({ promptTemplate: "x {{item}}", items: ["a", "b"], model: "kimi-code/k3" }), /must be one of primary\|secondary/);
});

// --- Agent calls ------------------------------------------------------------

test("kimiAgentCall: derives the lane from the shared manifest so dispatch matches the stamped file", () => {
  const judgment = kimiAgentCall({ agentId: "muster-reviewer", prompt: "Review the branch." });
  assert.equal(judgment.tool, "Agent");
  assert.equal(judgment.subagent_type, "muster-reviewer");
  assert.equal(judgment.model, "primary");   // opus tier

  const execution = kimiAgentCall({ agentId: "muster-surgeon", prompt: "Fix the typo." });
  assert.equal(execution.model, "secondary"); // sonnet tier
});

test("kimiAgentCall: an explicit model overrides the profile lane", () => {
  const call = kimiAgentCall({ agentId: "muster-surgeon", prompt: "x", model: "primary" });
  assert.equal(call.model, "primary");
});

test("kimiAgentCall: an unknown agent id dispatches with no lane rather than guessing", () => {
  const call = kimiAgentCall({ agentId: "not-in-manifest", prompt: "x" });
  assert.equal(call.model, undefined);
});

test("kimiAgentCall: background flag and required args", () => {
  assert.equal(kimiAgentCall({ agentId: "muster-reviewer", prompt: "x", background: true }).run_in_background, true);
  assert.throws(() => kimiAgentCall({ prompt: "x" }), /agentId is required/);
  assert.throws(() => kimiAgentCall({ agentId: "muster-reviewer" }), /prompt is required/);
});

// --- Background legs (run_in_background) -------------------------------------

test("kimiAgentCall: background construction -- the packet shape with background: true", () => {
  // An independent read-only leg (a reviewer the current wave does not barrier
  // on) dispatches background: the full packet is the normal typed call plus
  // run_in_background, lane derivation untouched.
  const bg = kimiAgentCall({ agentId: "muster-reviewer", prompt: "Review the previous wave's diff.", background: true });
  assert.equal(bg.tool, "Agent");
  assert.equal(bg.subagent_type, "muster-reviewer");
  assert.equal(bg.prompt, "Review the previous wave's diff.");
  assert.equal(bg.model, "primary"); // lane derivation is unaffected by backgrounding
  assert.equal(bg.run_in_background, true);

  // Foreground is the default and OMITS the key -- anything the wave's barrier
  // or the review gate depends on dispatches foreground, so the barrier still
  // means done.
  const fg = kimiAgentCall({ agentId: "muster-reviewer", prompt: "Review this wave." });
  assert.ok(!("run_in_background" in fg), "a foreground dispatch must not carry run_in_background");

  // The resume retry of a backgrounded leg keeps the flag (and still drops
  // subagent_type/model, per the resume contract).
  const retry = kimiAgentCall({ resume: "agent-7", prompt: "previous attempt failed: timeout", background: true });
  assert.equal(retry.resume, "agent-7");
  assert.equal(retry.run_in_background, true);
  assert.equal(retry.subagent_type, undefined);
});

test("interpretKimiBackgroundCompletion: a completed receipt folds back as the whole handoff", () => {
  // The completion arrives as a synthetic user message whose body IS the
  // subagent's final message -- same return contract as a foreground leg.
  const done = interpretKimiBackgroundCompletion({ status: "completed", result: "verdict: PASS; no findings" });
  assert.equal(done.status, "complete");
  assert.equal(done.terminal, true);
  assert.equal(done.result, "verdict: PASS; no findings");
  assert.match(done.reason, /synthetic user message/);
});

test("interpretKimiBackgroundCompletion: a failed leg re-enters progress-aware recovery, never a silent drop", () => {
  const failed = interpretKimiBackgroundCompletion({ status: "failed", terminalReason: "timed_out" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.terminal, true);
  assert.match(failed.reason, /progress-aware fingerprint/);
  assert.match(failed.reason, /never a silent drop/);

  for (const status of ["stopped", "timed_out"]) {
    assert.equal(interpretKimiBackgroundCompletion({ status }).status, "failed");
  }
});

test("interpretKimiBackgroundCompletion: no receipt yet is pending -- the barrier does not cover it", () => {
  for (const input of [{}, { status: "running" }]) {
    const pending = interpretKimiBackgroundCompletion(input);
    assert.equal(pending.status, "pending");
    assert.equal(pending.terminal, false);
    assert.match(pending.reason, /barrier does not cover it/);
  }
});

// --- Resume-after-failure (orchestrator step 4a's Kimi re-dispatch-once path) ---

test("kimiAgentCall: resume models the failure retry -- prior context kept, only the error appended", () => {
  // The FIRST dispatch is a normal typed call with the full brief...
  const first = kimiAgentCall({ agentId: "muster-builder", prompt: "Implement the feature. OWNS: src/foo.js" });
  assert.equal(first.subagent_type, "muster-builder");
  assert.equal(first.resume, undefined);

  // ...it fails; the retry RESUMES the failed subagent with the error as the
  // only new context, instead of paying the full prompt/context cost again.
  const retry = kimiAgentCall({ resume: "agent-7", prompt: "previous attempt failed: ReferenceError in src/foo.js" });
  assert.equal(retry.tool, "Agent");
  assert.equal(retry.resume, "agent-7");
  assert.equal(retry.subagent_type, undefined); // Kimi: resume is mutually exclusive with subagent_type
  assert.equal(retry.model, undefined);         // ignored when resuming -- resumed subagents keep their model
  assert.match(retry.prompt, /previous attempt failed/);
  assert.ok(!retry.prompt.includes("Implement the feature.")); // not a fresh full brief
});

test("kimiAgentCall: resume is mutually exclusive with agentId, and the error prompt is still required", () => {
  assert.throws(() => kimiAgentCall({ resume: "agent-7", agentId: "muster-builder", prompt: "x" }), /mutually exclusive/);
  assert.throws(() => kimiAgentCall({ resume: "agent-7" }), /prompt is required/);
  assert.throws(() => kimiAgentCall({ resume: "", prompt: "x" }), /resume must be the failed subagent's agent id/);
});

test("kimiSwarmCall: resumeAgentIds retries failed swarm members with only the error context", () => {
  // A uniform wave dispatched as a swarm loses members; the retry packet
  // resumes THOSE members -- no items, no template, no fresh full prompts
  // (which is also why the >=2-item floor lifts when resuming).
  const retry = kimiSwarmCall({ resumeAgentIds: { "agent-3": "previous attempt failed: timeout running npm test" } });
  assert.equal(retry.tool, "AgentSwarm");
  assert.deepEqual(retry.resume_agent_ids, { "agent-3": "previous attempt failed: timeout running npm test" });
  assert.equal(retry.items, undefined);
  assert.equal(retry.prompt_template, undefined);
  assert.equal(retry.soleToolCall, true); // still the sole-tool-call contract
});

test("kimiSwarmCall: resumeAgentIds must pair prior agent ids with their resume prompts", () => {
  assert.throws(() => kimiSwarmCall({ resumeAgentIds: ["agent-3"] }), /must be a map of prior agent id/);
  assert.throws(() => kimiSwarmCall({ resumeAgentIds: { "": "continue" } }), /keys must be prior agent ids/);
  assert.throws(() => kimiSwarmCall({ resumeAgentIds: { "agent-3": "" } }), /must be the resume prompt/);
  assert.throws(() => kimiSwarmCall({ resumeAgentIds: { "agent-3": 42 } }), /must be the resume prompt/);
});

// --- /goal ------------------------------------------------------------------

test("interpretKimiGoalExit: maps the binary's exit codes onto run dispositions", () => {
  assert.deepEqual(KIMI_GOAL_EXIT_CODES, { complete: 0, blocked: 3, paused: 6 });

  const complete = interpretKimiGoalExit(0);
  assert.equal(complete.status, "complete");
  assert.equal(complete.terminal, true);
  assert.equal(complete.escalate, false);

  const blocked = interpretKimiGoalExit(3);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.escalate, true); // muster's escalation signal

  const paused = interpretKimiGoalExit(6);
  assert.equal(paused.status, "paused");
  assert.equal(paused.resumable, true);
});

test("interpretKimiGoalExit: a non-goal exit code is a FAULT, never a clean stop", () => {
  const crashed = interpretKimiGoalExit(1);
  assert.equal(crashed.status, "failed");
  assert.equal(crashed.escalate, true);
  assert.match(crashed.reason, /not a \/goal terminal state/);
});

// --- Quota/balance fail-fast (kimi 0.30.0) -----------------------------------

test("detectKimiQuotaFault: matches exactly the signature the 0.30.0 binary classifies on", () => {
  // The stream-json error event's wire payload keeps the error class name.
  assert.equal(detectKimiQuotaFault('{"type":"error","code":"api_error","name":"APIProviderQuotaExhaustedError","retryable":false}'), "APIProviderQuotaExhaustedError");
  // The structured provider codes (binary: KIMI_QUOTA_EXHAUSTED_ERROR_CODES +
  // isOpenAIInsufficientQuotaCode).
  assert.equal(detectKimiQuotaFault('{"error":{"type":"exceeded_current_quota_error"}}'), "exceeded_current_quota_error");
  assert.equal(detectKimiQuotaFault("Error: insufficient_quota"), "insufficient_quota");
  // The binary's five verbatim wording patterns (it lowercases before testing).
  assert.equal(detectKimiQuotaFault("Exceeded your current quota, please check your account balance."), "exceeded your current (?:token )?quota");
  assert.equal(detectKimiQuotaFault("exceeded your current token quota"), "exceeded your current (?:token )?quota");
  assert.equal(detectKimiQuotaFault("please check your account balance"), "check your account balance");
  assert.equal(detectKimiQuotaFault("insufficient balance"), "insufficient balance");
  assert.equal(detectKimiQuotaFault("recharge your account"), "recharge your account|please recharge");
  assert.equal(detectKimiQuotaFault("Please recharge to continue."), "recharge your account|please recharge");
  assert.equal(detectKimiQuotaFault("account is in arrears"), "account (?:is )?in arrears");
  assert.equal(detectKimiQuotaFault("your account in arrears"), "account (?:is )?in arrears");
  // Negative: an ordinary rate-limit 429 is NOT a billing fault -- the binary
  // keeps it on the retryable rate_limit path, and so does muster.
  assert.equal(detectKimiQuotaFault('{"type":"error","code":"rate_limit","message":"429 too many requests"}'), null);
  assert.equal(detectKimiQuotaFault(""), null);
  assert.equal(detectKimiQuotaFault(null), null);
  assert.equal(detectKimiQuotaFault(undefined), null);
});

test("interpretKimiGoalExit: a quota/balance fault is a BILLING escalation, never a retry", () => {
  const quotaStream = '{"type":"error","code":"api_error","name":"APIProviderQuotaExhaustedError","message":"Exceeded your current quota, please check your account balance","retryable":false}\n';

  // 6 paused carrying the signature: NOT treated as a resumable model/runtime
  // pause -- the binary marks the fault retryable: false, so an unattended
  // resume only re-pays a guaranteed-fail round trip until a human recharges.
  const paused = interpretKimiGoalExit(6, quotaStream);
  assert.equal(paused.status, "paused");
  assert.equal(paused.kind, "billing");
  assert.equal(paused.escalate, true);
  assert.equal(paused.resumable, false);
  assert.match(paused.reason, /BILLING escalation/);
  assert.match(paused.reason, /recharge/);

  // A non-goal exit code carrying the signature: billing, not a generic fault.
  const crashed = interpretKimiGoalExit(1, quotaStream);
  assert.equal(crashed.status, "failed");
  assert.equal(crashed.kind, "billing");
  assert.equal(crashed.escalate, true);
  assert.match(crashed.reason, /BILLING escalation/);

  // The same exits WITHOUT the signature keep the pre-0.30.0 dispositions.
  assert.equal(interpretKimiGoalExit(6, '{"type":"error","code":"rate_limit"}').resumable, true);
  assert.equal(interpretKimiGoalExit(6, '{"type":"error","code":"rate_limit"}').kind, undefined);
  assert.equal(interpretKimiGoalExit(1, "some unrelated crash").kind, undefined);

  // A complete exit is never reclassified: the goal's own evidence was
  // satisfied; a quota string in its output is incidental.
  const complete = interpretKimiGoalExit(0, quotaStream);
  assert.equal(complete.status, "complete");
  assert.equal(complete.kind, undefined);
  assert.equal(complete.escalate, false);
});

test("quotaFaultLines: keeps only error-surface lines (stream-json error events + raw error: lines)", () => {
  const stdout = '{"role":"meta","type":"system.version","version":"0.30.0"}\n' +
    '{"role":"assistant","content":"please check your account balance"}\n' +
    '{"type":"error","code":"api_error","name":"APIProviderQuotaExhaustedError","retryable":false}\n' +
    'error: insufficient_quota\n' +
    'some raw noise line\n';
  const scoped = quotaFaultLines(stdout);
  assert.equal(scoped,
    '{"type":"error","code":"api_error","name":"APIProviderQuotaExhaustedError","retryable":false}\n' +
    'error: insufficient_quota');
  assert.equal(quotaFaultLines(""), "");
  assert.equal(quotaFaultLines(null), "");
  assert.equal(quotaFaultLines(undefined), "");
});

test("interpretKimiGoalExit: quota wording ONLY in assistant/tool text is NOT a billing fault (scoped match)", () => {
  // Injected or merely topical billing text (a payments codebase discussing
  // balances) must not flip a resumable pause into a non-resumable billing
  // escalation -- the match is scoped to error-surface lines, as in the eval
  // harness's quotaFaultLines rule.
  const billingTalk = '{"role":"assistant","content":"You should check your account balance regularly."}\n' +
    '{"role":"assistant","tool_calls":[{"type":"function","function":{"name":"refund","arguments":"{\\"reason\\":\\"please recharge\\"}"}}]}\n';

  const paused = interpretKimiGoalExit(6, billingTalk);
  assert.equal(paused.status, "paused");
  assert.equal(paused.resumable, true);
  assert.equal(paused.escalate, false);
  assert.equal(paused.kind, undefined);

  const crashed = interpretKimiGoalExit(1, billingTalk);
  assert.equal(crashed.status, "failed");
  assert.equal(crashed.kind, undefined);
  assert.match(crashed.reason, /not a \/goal terminal state/);
});

test("interpretKimiGoalExit: quota wording in an error-surface line DOES reclassify as billing", () => {
  // Raw `error:`-prefixed line (non-stream-json capture) carrying the wording.
  const rawError = "error: Exceeded your current quota, please check your account balance\n";
  const paused = interpretKimiGoalExit(6, rawError);
  assert.equal(paused.kind, "billing");
  assert.equal(paused.resumable, false);
  assert.equal(paused.escalate, true);

  // Stream-json {"type":"error"} event carrying only the wording (no error
  // class name or provider code) still matches -- the line is error-surface.
  const errorEvent = '{"type":"error","code":"api_error","message":"insufficient balance"}\n';
  const crashed = interpretKimiGoalExit(1, errorEvent);
  assert.equal(crashed.kind, "billing");
  assert.match(crashed.reason, /BILLING escalation/);

  // The same wording on a NON-error stream-json line never reclassifies.
  const assistantEcho = '{"type":"assistant","message":"insufficient balance"}\n';
  assert.equal(interpretKimiGoalExit(1, assistantEcho).kind, undefined);
});

test("kimiGoalInvocation: builds argv + the per-process lane env", () => {
  const inv = kimiGoalInvocation({ objective: "Fix the failing checkout test and run the suite" });
  assert.deepEqual(inv.argv.slice(0, 2), ["-p", "/goal Fix the failing checkout test and run the suite"]);
  assert.deepEqual(inv.argv.slice(-2), ["-m", KIMI_LANES.primary]);
  // the env pair binds the lanes without touching the user's config.toml
  assert.equal(inv.env.KIMI_CODE_EXPERIMENTAL_FLAG, "1");
  assert.equal(inv.env.KIMI_SECONDARY_MODEL, KIMI_LANES.secondary);
});

test("kimiGoalInvocation: the env pair IS the shared kimiLaneEnv() derivation", () => {
  // One source of truth (src/kimi.js): the run loop, the install report, and
  // `muster doctor` can never disagree on the bind.
  assert.deepEqual(kimiGoalInvocation({ objective: "Ship the lane bind" }).env, kimiLaneEnv());
});

test("kimiGoalInvocation: a secondaryModel override flows into the env, the flag untouched", () => {
  const inv = kimiGoalInvocation({ objective: "x", secondaryModel: "kimi-code/k3-256k" });
  assert.equal(inv.env.KIMI_SECONDARY_MODEL, "kimi-code/k3-256k");
  assert.equal(inv.env.KIMI_CODE_EXPERIMENTAL_FLAG, "1");
});

test("kimiGoalInvocation: stream-json is opt-in, and the /goal prefix is never doubled", () => {
  assert.ok(kimiGoalInvocation({ objective: "x", streamJson: true }).argv.includes("stream-json"));
  assert.throws(() => kimiGoalInvocation({ objective: "/goal already prefixed" }), /the \/goal prefix is added here/);
});

test("kimiGoalInvocation: enforces the binary's 4000-char objective cap", () => {
  assert.equal(KIMI_GOAL_MAX_OBJECTIVE, 4000);
  assert.throws(() => kimiGoalInvocation({ objective: "x".repeat(4001) }), /caps it at 4000/);
  assert.doesNotThrow(() => kimiGoalInvocation({ objective: "x".repeat(4000) }));
  assert.throws(() => kimiGoalInvocation({ objective: "  " }), /objective is required/);
});

// --- Wave shape selection ---------------------------------------------------

test("resolveKimiWaveDispatch: swarm for a uniform fan-out, agent-calls for a mixed crew", () => {
  const uniform = resolveKimiWaveDispatch({ items: ["a.ts", "b.ts", "c.ts"], uniformTask: true });
  assert.equal(uniform.mode, KIMI_DISPATCH_MODES.SWARM);
  assert.equal(uniform.concurrencyEnv, "KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY");

  // a typical muster wave is N DISTINCT roles -- Kimi's own guidance says use
  // separate Agent calls for differently-shaped tasks.
  const mixed = resolveKimiWaveDispatch({ items: ["builder", "test-author", "reviewer"] });
  assert.equal(mixed.mode, KIMI_DISPATCH_MODES.AGENT_CALLS);
  assert.match(mixed.reason, /differently-shaped/);

  // below the floor, swarm is not even legal
  const single = resolveKimiWaveDispatch({ items: ["only"], uniformTask: true });
  assert.equal(single.mode, KIMI_DISPATCH_MODES.AGENT_CALLS);
  assert.match(single.reason, /below AgentSwarm's 2-item floor/);
});

// --- Resolved wave -> packet composition (orchestrator/SKILL.md's Kimi subsection) ---

test("a uniform wave resolves to ONE validated AgentSwarm packet", () => {
  const items = ["src/a.ts", "src/b.ts", "src/c.ts"];
  const decision = resolveKimiWaveDispatch({ items, uniformTask: true });
  assert.equal(decision.mode, KIMI_DISPATCH_MODES.SWARM);

  // The resolved wave builds exactly one swarm packet, already validated by
  // kimiSwarmCall -- dispatch never reaches Kimi with a malformed packet.
  const packet = kimiSwarmCall({
    promptTemplate: `Review ${KIMI_SWARM_PLACEHOLDER} for likely regressions.`,
    items,
    subagentType: "muster-reviewer"
  });
  assert.equal(packet.tool, "AgentSwarm");
  assert.deepEqual(packet.items, items);
  assert.equal(packet.soleToolCall, true); // must be the only tool call in its response
});

test("a mixed-role wave resolves to per-agent calls with each crew member's own lane", () => {
  const crew = [
    { agentId: "muster-builder", prompt: "Implement the feature." },
    { agentId: "muster-reviewer", prompt: "Review the diff." },
    { agentId: "muster-surgeon", prompt: "Fix the typo." }
  ];
  const decision = resolveKimiWaveDispatch({ items: crew.map(c => c.agentId) });
  assert.equal(decision.mode, KIMI_DISPATCH_MODES.AGENT_CALLS);

  const calls = crew.map(c => kimiAgentCall(c));
  assert.equal(calls.length, crew.length);
  for (const [i, call] of calls.entries()) {
    assert.equal(call.tool, "Agent");
    assert.equal(call.subagent_type, crew[i].agentId);
    assert.equal(call.prompt, crew[i].prompt);
  }
  // lanes come from the shared manifest, never a shared default
  assert.equal(calls[0].model, "primary");    // builder: opus tier
  assert.equal(calls[1].model, "primary");    // reviewer: opus tier
  assert.equal(calls[2].model, "secondary");  // surgeon: sonnet tier
});

// --- Named up-front rejection of the four swarm rules ------------------------

test("every swarm rejection is a NAMED up-front error, never a wave round trip", () => {
  const cases = [
    // rule 1: >=2 items unless resuming
    [{ promptTemplate: "x {{item}}", items: ["only-one"] }, /kimiSwarmCall: AgentSwarm requires at least 2 items/],
    // rule 2: prompt_template required when items are present
    [{ items: ["a", "b"] }, /kimiSwarmCall: prompt_template is required/],
    // rule 3: template must contain {{item}}
    [{ promptTemplate: "no placeholder", items: ["a", "b"] }, /kimiSwarmCall: prompt_template must contain the \{\{item\}\} placeholder/],
    // rule 4: filled prompts must be DISTINCT (undocumented in Kimi's docs)
    [{ promptTemplate: "Audit {{item}}.", items: ["src/a.ts", "src/a.ts"] }, /kimiSwarmCall: items must expand to DISTINCT prompts/]
  ];
  for (const [input, pattern] of cases) {
    assert.throws(() => kimiSwarmCall(input), pattern);
  }
});

// --- Prose wiring: the orchestrator skill names the shipped helpers ----------

// skill-split (2026-07-29): the Kimi-native dispatch mechanics moved to the
// orchestrator's progressive-disclosure reference file; SKILL.md keeps the
// heading + an on-Kimi-read-this pointer. These guards follow the content.
const KIMI_DISPATCH_REF = new URL("../plugin/skills/orchestrator/references/kimi-dispatch.md", import.meta.url);

test("orchestrator references/kimi-dispatch.md has the Kimi subsection naming the shipped helpers", async () => {
  const text = await readFile(KIMI_DISPATCH_REF, "utf8");
  const match = text.match(/### Kimi-native dispatch[^\n]*\n([\s\S]*?)(?=\n### |\n## |$)/);
  assert.ok(match, "references/kimi-dispatch.md must carry the '### Kimi-native dispatch' section");
  const section = match[1];
  // names the tool and the builder exactly (src/kimi-dispatch.js is canonical)
  assert.match(section, /`AgentSwarm`/, "the Kimi subsection must name the AgentSwarm tool");
  assert.match(section, /kimiSwarmCall/, "the Kimi subsection must name kimiSwarmCall exactly");
  assert.match(section, /kimiAgentCall/, "the Kimi subsection must name kimiAgentCall exactly");
  assert.match(section, /resolveKimiWaveDispatch/, "the Kimi subsection must route every wave through resolveKimiWaveDispatch");
  assert.match(section, /src\/kimi-dispatch\.js/, "the Kimi subsection must cite src/kimi-dispatch.js");
  // the up-front validation posture, including the distinct-prompts rule
  assert.match(section, /\{\{item\}\}/, "the Kimi subsection must name the exact placeholder");
  assert.match(section, /DISTINCT/i, "the Kimi subsection must state the distinct-prompts rejection rule");
  assert.match(section, /BEFORE dispatch/i, "the Kimi subsection must mandate pre-dispatch validation");
});

// --- Prose wiring: the failure rule names the Kimi resume path --------------

test("orchestrator/SKILL.md's progress-aware failure rule names the Kimi resume path", async () => {
  const text = await readFile(new URL("../plugin/skills/orchestrator/SKILL.md", import.meta.url), "utf8");
  const start = text.indexOf("- **Subagent failure:**");
  assert.ok(start >= 0, "orchestrator/SKILL.md step 4a must carry the 'Subagent failure' bullet");
  const bullet = text.slice(start, text.indexOf("b. BARRIER", start));
  // On Kimi the retry RESUMES the failed subagent instead of spawning fresh --
  // naming both native shapes and the builders that model them.
  assert.match(bullet, /On Kimi the re-dispatch is\s+a native RESUME/, "the failure bullet must state the Kimi retry is a native resume, not a fresh spawn");
  assert.match(bullet, /`resume`/, "the failure bullet must name the Agent tool's resume parameter");
  assert.match(bullet, /resume_agent_ids/, "the failure bullet must name AgentSwarm's resume_agent_ids");
  assert.match(bullet, /kimiAgentCall`\/`kimiSwarmCall` in `src\/kimi-dispatch\.js`/, "the failure bullet must cite the shipped builders");
  assert.match(bullet, /keeps its\s+prior context and only the error is appended/, "the failure bullet must state the resume keeps prior context and appends only the error");
  assert.match(bullet, /Non-Kimi harnesses keep the fresh re-dispatch/, "the failure bullet must keep the fresh re-dispatch on non-Kimi harnesses");
  assert.match(bullet, /deterministic error\/progress fingerprint/, "the retry rule must key continuation to progress");
  assert.match(bullet, /repeated-identical\/no-progress threshold/, "the retry rule must stop repeated outcomes deterministically");

  // ...and the Kimi-native dispatch reference carries the matching mechanics.
  const ref = await readFile(KIMI_DISPATCH_REF, "utf8");
  const kimi = ref.match(/### Kimi-native dispatch[^\n]*\n([\s\S]*?)(?=\n### |\n## |$)/);
  assert.ok(kimi, "the Kimi-native dispatch reference section must exist");
  assert.match(kimi[1], /Failure retry rides the same native shapes/, "the Kimi subsection must carry the failure-retry resume paragraph");
  assert.match(kimi[1], /kimiAgentCall\(\{ resume: /, "the Kimi subsection must show the per-agent resume retry shape");
  assert.match(kimi[1], /kimiSwarmCall\(\{ resumeAgentIds: /, "the Kimi subsection must show the swarm resume retry shape");
  assert.match(kimi[1], /mutually exclusive with `subagent_type`/, "the Kimi subsection must state resume's mutual exclusion with subagent_type");
  assert.match(kimi[1], /changed outcomes may resume again/, "Kimi retries must continue while progress changes");
});

// --- Prose wiring: the Kimi subsection names the background-vs-barrier rule --

test("references/kimi-dispatch.md names when to background a leg versus barrier on it", async () => {
  const text = await readFile(KIMI_DISPATCH_REF, "utf8");
  const match = text.match(/### Kimi-native dispatch[^\n]*\n([\s\S]*?)(?=\n### |\n## |$)/);
  assert.ok(match, "references/kimi-dispatch.md must carry the '### Kimi-native dispatch' section");
  const section = match[1];
  // the rule itself: independent read-only legs background; barrier-gated work foreground
  assert.match(section, /Background a leg only when the wave does not barrier on it/, "the Kimi subsection must state the background-vs-barrier rule");
  assert.match(section, /independent read-only\s+leg/, "the rule must scope backgrounding to independent read-only legs");
  assert.match(section, /background: true/, "the rule must name the kimiAgentCall background flag");
  assert.match(section, /run_in_background/, "the rule must name Kimi's run_in_background parameter");
  // the completion/receipt semantics the fold-back rides on
  assert.match(section, /synthetic user message/, "the rule must state the result arrives as a synthetic user message");
  assert.match(section, /tasks\/<task_id>\.json/, "the rule must name the on-disk tasks/ receipt");
  assert.match(section, /interpretKimiBackgroundCompletion/, "the rule must name the shipped receipt interpreter");
  // the barrier is not weakened: barrier/review-gate work stays foreground
  assert.match(section, /step 4b's barrier[\s\S]*?step 4c's review gate[\s\S]*?FOREGROUND/, "the rule must keep barrier/review-gate work foreground");
  assert.match(section, /progress-aware fingerprint/, "a failed backgrounded leg must re-enter progress-aware recovery");
});

// --- Prose wiring: the runner prose routes the Kimi run loop through /goal ----

test("the runner prose (go.md + runner.md) routes the Kimi run loop through the native /goal runner", async () => {
  // NOTE on file choice: plugin/commands/run.md is a pinned alias stub -- the
  // alias-shape guard (test/mode-evals.test.js) pins its body to exactly 2
  // paragraphs -- so the run-loop prose it historically carried now lives in
  // go.md (the hands-off runner, whose step 6 names the Ralph loop). The Kimi
  // arm lands there and in runner.md's Scheduling paragraph, where Claude's
  // /goal is already discussed.
  const go = await readFile(new URL("../plugin/commands/go.md", import.meta.url), "utf8");
  const runner = await readFile(new URL("../plugin/commands/runner.md", import.meta.url), "utf8");
  for (const [file, text] of [["go.md", go], ["runner.md", runner]]) {
    assert.match(text, /\/goal/, `${file} must name Kimi's native /goal runner`);
    assert.match(text, /kimiGoalInvocation/, `${file} must name kimiGoalInvocation exactly (src/kimi-dispatch.js is canonical)`);
    assert.match(text, /interpretKimiGoalExit/, `${file} must name interpretKimiGoalExit exactly`);
    // the exit-code contract: escalation arrives as an exit code, not a STATE parse
    assert.match(text, /0 complete/, `${file} must state the 0-complete exit code`);
    assert.match(text, /3 blocked/, `${file} must state the 3-blocked (escalation) exit code`);
    assert.match(text, /6 paused/, `${file} must state the 6-paused (resumable) exit code`);
    assert.match(text, /instead of being parsed out of a STATE file/, `${file} must state that escalation arrives as an exit code, not a STATE-file parse`);
    assert.match(text, /non-Kimi\s+harnesses/i, `${file} must keep the existing STATE-file loop on non-Kimi harnesses`);
  }
  // acceptance criteria compile INTO the objective string (no separate stop flag)
  assert.match(go, /acceptance criteria compiled\s*INTO the objective string/, "go.md must state that acceptance criteria compile into the /goal objective string");
  // the env pair is an OVERRIDE merged over the ambient env, never the whole spawn env
  assert.match(go, /\.\.\.process\.env, \.\.\.inv\.env/, "go.md must pin the env merge shape for the /goal invocation");
  assert.match(go, /never passed as the whole env/, "go.md must forbid passing the env pair as the whole spawn env");
});

// --- Headless process dispatch (kimi -p --agent-file) -------------------------

// A scratch Kimi home with an installed agents/ dir, bound via KIMI_CODE_HOME
// for the duration of fn (the dispatch resolves the dir per call).
function withKimiHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "kimi-dispatch-"));
  mkdirSync(join(home, "agents"), { recursive: true });
  const previous = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = home;
  try {
    return fn(home);
  } finally {
    if (previous === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

async function withKimiHomeAsync(fn) {
  const home = mkdtempSync(join(tmpdir(), "kimi-dispatch-"));
  mkdirSync(join(home, "agents"), { recursive: true });
  const previous = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (previous === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

test("kimiProcessDispatch: builds the headless -p invocation, -m ALWAYS emitted per lane", () => {
  withKimiHome(home => {
    writeFileSync(join(home, "agents", "muster-builder.md"), "---\nname: muster-builder\n---\n");
    for (const lane of ["primary", "secondary"]) {
      const d = kimiProcessDispatch({ brief: "Implement the feature.", agentFile: "muster-builder.md", cwd: home, lane });
      assert.equal(d.argv[0], "-p");
      assert.match(d.argv[1], /complete UTF-8 process brief/);
      assert.ok(!d.argv.includes("Implement the feature."));
      assert.deepEqual(d.argv.slice(2), ["--agent-file", join(home, "agents", "muster-builder.md"), "--output-format", "stream-json", "-m", KIMI_LANES[lane]]);
      assert.deepEqual(d.env, kimiLaneEnv()); // the shared derivation, never re-stated
      assert.equal(d.env.KIMI_CODE_EXPERIMENTAL_FLAG, "1"); // the v2 engine --agent-file needs
      assert.equal(d.cwd, home);
      assert.equal(d.lane, lane);
    }
  });
});

test("kimiProcessDispatch: agentFile forms -- bare name under the installed dir, absolute as-is, relative against cwd", () => {
  withKimiHome(home => {
    writeFileSync(join(home, "agents", "muster-builder.md"), "x");
    writeFileSync(join(home, "custom.md"), "x");
    mkdirSync(join(home, "run", "agents"), { recursive: true });
    writeFileSync(join(home, "run", "agents", "local.md"), "x");

    const bare = kimiProcessDispatch({ brief: "b", agentFile: "muster-builder.md", cwd: home, lane: "primary" });
    assert.equal(bare.argv[3], join(home, "agents", "muster-builder.md"));

    const abs = kimiProcessDispatch({ brief: "b", agentFile: join(home, "custom.md"), cwd: home, lane: "primary" });
    assert.equal(abs.argv[3], join(home, "custom.md"));

    const rel = kimiProcessDispatch({ brief: "b", agentFile: "agents/local.md", cwd: join(home, "run"), lane: "secondary" });
    assert.equal(rel.argv[3], join(home, "run", "agents", "local.md"));
  });
});

test("kimiProcessDispatch: NO construction path omits -m (omission falls to config default_model)", () => {
  // The spec-gate amendment: model_preference binds only SPAWNED SUBAGENTS,
  // never the -p process's own main agent, so the process model comes ONLY
  // from -m -- every accepted (agentFile form x lane) pair must carry it.
  withKimiHome(home => {
    writeFileSync(join(home, "agents", "muster-builder.md"), "x");
    writeFileSync(join(home, "custom.md"), "x");
    for (const agentFile of ["muster-builder.md", join(home, "custom.md")]) {
      for (const lane of ["primary", "secondary"]) {
        const d = kimiProcessDispatch({ brief: "b", agentFile, cwd: home, lane });
        const occurrences = d.argv.filter(a => a === "-m").length;
        assert.equal(occurrences, 1, `-m must appear exactly once in ${JSON.stringify(d.argv)}`);
        assert.equal(d.argv[d.argv.indexOf("-m") + 1], KIMI_LANES[lane]);
      }
    }
  });
});

test("kimiProcessDispatch: rejects an empty brief", () => {
  withKimiHome(home => {
    writeFileSync(join(home, "agents", "muster-builder.md"), "x");
    for (const brief of [undefined, "", "   ", 42]) {
      assert.throws(
        () => kimiProcessDispatch({ brief, agentFile: "muster-builder.md", cwd: home, lane: "primary" }),
        /kimiProcessDispatch: brief is required/
      );
    }
  });
});

test("kimiProcessDispatch: 4,001 chars and 64 KiB reach a child intact through the documented temporary-file transport", async () => {
  assert.equal(KIMI_PROCESS_MAX_BRIEF, 64 * 1024);
  await withKimiHomeAsync(async home => {
    writeFileSync(join(home, "agents", "muster-builder.md"), "x");
    const fakeChild = join(home, "fake-kimi.mjs");
    writeFileSync(fakeChild, "import { readFileSync } from 'node:fs';\nconst prompt = process.argv[process.argv.indexOf('-p') + 1];\nconst path = JSON.parse(prompt.slice(prompt.indexOf(':') + 1));\nprocess.stdout.write(readFileSync(path));\n");
    const exactMultibyte64KiB = "€".repeat(21_845) + "x";
    for (const brief of ["x".repeat(4001), "y".repeat(64 * 1024), exactMultibyte64KiB, "before\0after"]) {
      assert.ok(Buffer.byteLength(brief, "utf8") <= 64 * 1024);
      const dispatch = kimiProcessDispatch({ brief, agentFile: "muster-builder.md", cwd: home, lane: "primary" });
      assert.deepEqual(dispatch.briefTransport, { kind: "temporary-file", encoding: "utf8", maxBytes: 64 * 1024 });
      assert.throws(() => { dispatch.argv = ["-p", brief]; }, TypeError, "canonical argv is non-writable");
      assert.throws(() => { dispatch.cwd = join(home, "agents"); }, TypeError, "canonical cwd is non-writable");
      assert.ok(!dispatch.argv.some(value => value.includes(brief)), "the process brief must not ride argv");
      let transportedPath;
      const received = await withKimiProcessBriefFile(dispatch, async prepared => {
        assert.ok(prepared.argv.every(value => Buffer.byteLength(value, "utf8") < 4096), "argv remains bounded independently of brief size");
        const prompt = prepared.argv[1];
        transportedPath = JSON.parse(prompt.slice(prompt.indexOf(":") + 1));
        assert.ok(existsSync(transportedPath), "the private brief file exists for the child lifetime");
        return execFileSync(process.execPath, [fakeChild, ...prepared.argv], { encoding: "utf8", maxBuffer: 256 * 1024 });
      });
      assert.equal(received, brief);
      assert.equal(existsSync(transportedPath), false, "the private brief file is removed after child completion");
    }
    assert.throws(
      () => kimiProcessDispatch({ brief: "x".repeat(64 * 1024 + 1), agentFile: "muster-builder.md", cwd: home, lane: "primary" }),
      /brief is 65537 UTF-8 bytes; temporary-file transport cap is 65536 bytes/
    );
    await assert.rejects(
      withKimiProcessBriefFile(kimiProcessDispatch({ brief: "x", agentFile: "muster-builder.md", cwd: home, lane: "primary" }), () => "child still running"),
      /invoke must return a Promise that settles after child exit/
    );
    await assert.rejects(
      withKimiProcessBriefFile({ brief: "forged", briefTransport: { kind: "temporary-file", mode: 0o644 }, argv: ["-p", "x"] }, async () => {}),
      /kimiProcessDispatch descriptor is required/
    );
    assert.throws(
      () => kimiProcessDispatch({ brief: "€".repeat(21_846), agentFile: "muster-builder.md", cwd: home, lane: "primary" }),
      /brief is 65538 UTF-8 bytes; temporary-file transport cap is 65536 bytes/
    );
  });
});

test("kimiProcessDispatch: lane is REQUIRED and must be primary|secondary, never a model id", () => {
  withKimiHome(home => {
    writeFileSync(join(home, "agents", "muster-builder.md"), "x");
    for (const lane of [undefined, "tertiary", "kimi-code/k3"]) {
      assert.throws(
        () => kimiProcessDispatch({ brief: "b", agentFile: "muster-builder.md", cwd: home, lane }),
        /kimiProcessDispatch: lane is required and must be one of primary\|secondary/
      );
    }
  });
});

test("kimiProcessDispatch: rejects an agentFile that resolves to nothing", () => {
  withKimiHome(home => {
    writeFileSync(join(home, "agents", "muster-builder.md"), "x");
    // a bare name absent from the installed agents dir
    assert.throws(
      () => kimiProcessDispatch({ brief: "b", agentFile: "ghost.md", cwd: home, lane: "primary" }),
      /kimiProcessDispatch: agentFile "ghost\.md" resolved to .+ which does not exist/
    );
    // an explicit absolute path that does not exist
    assert.throws(
      () => kimiProcessDispatch({ brief: "b", agentFile: join(home, "nope.md"), cwd: home, lane: "primary" }),
      /which does not exist/
    );
    // and the argument itself is required
    for (const agentFile of [undefined, "", 42]) {
      assert.throws(
        () => kimiProcessDispatch({ brief: "b", agentFile, cwd: home, lane: "primary" }),
        /kimiProcessDispatch: agentFile is required/
      );
    }
  });
});

test("kimiProcessDispatch: cwd must be an existing directory", () => {
  withKimiHome(home => {
    writeFileSync(join(home, "agents", "muster-builder.md"), "x");
    for (const cwd of [undefined, ""]) {
      assert.throws(
        () => kimiProcessDispatch({ brief: "b", agentFile: "muster-builder.md", cwd, lane: "primary" }),
        /kimiProcessDispatch: cwd is required/
      );
    }
    for (const cwd of [join(home, "missing"), join(home, "agents", "muster-builder.md")]) {
      assert.throws(
        () => kimiProcessDispatch({ brief: "b", agentFile: "muster-builder.md", cwd, lane: "primary" }),
        /kimiProcessDispatch: cwd must be an existing directory/
      );
    }
  });
});

// --- Prose wiring: the attended-session process lane ---------------------------

test("references/kimi-dispatch.md carries the attended-session process-lane rule", async () => {
  const text = await readFile(KIMI_DISPATCH_REF, "utf8");
  const match = text.match(/### Kimi-native dispatch[^\n]*\n([\s\S]*?)(?=\n### |\n## |$)/);
  assert.ok(match, "references/kimi-dispatch.md must carry the '### Kimi-native dispatch' section");
  const section = match[1];
  // the rule itself exists
  assert.match(section, /Attended sessions cannot currently dispatch lane-sensitive legs as headless `kimi -p`\s+processes/, "the Kimi subsection must state the attended-session report-only rule");
  // the attended-vs-unattended division: process lane for attended sessions,
  // native Agent/AgentSwarm stays the unattended in-session path (the env bind
  // is already set by kimiGoalInvocation there)
  assert.match(section, /UNATTENDED in-session path/, "the rule must name the unattended in-session path");
  assert.match(section, /ATTENDED\/interactive session/, "the rule must name the attended/interactive session");
  assert.match(section, /kimiGoalInvocation/, "the rule must name kimiGoalInvocation as the unattended path's env binder");
  assert.match(section, /TUI ignores `model_preference` entirely/, "the rule must state WHY attended sessions cannot bind lanes in-session");
  assert.match(section, /genuinely need the parent's live context/, "the rule must reserve the native Agent tool for live-context legs");
  // No trusted process broker is currently available. Attended lane-sensitive
  // legs escalate instead of spawning; the descriptor remains inspection-only.
  assert.match(section, /`\$MUSTER_CLI kimi-process-run\s+--brief <text> --agent-file <name\|path> --cwd <dir> --lane <primary\|secondary>`/, "the rule must name the kimi-process-run supervisor with its exact argument shape");
  assert.match(section, /`src\/dispatch-receipts\.js`/, "the rule must cite the supervisor implementation");
  assert.match(section, /always exits nonzero before spawn, receipt, cgroup, or\s+signal setup/, "the process-run verb must be pinned report-only before side effects");
  assert.match(section, /trusted broker bootstrap is unavailable/, "the rule must state why process dispatch is unavailable");
  assert.match(section, /escalate the leg/, "attended lane-sensitive work must escalate");
  assert.match(section, /`\$MUSTER_CLI kimi-process-dispatch \.\.\.` remains descriptor-only/, "the descriptor verb must remain explicitly non-production");
  assert.match(section, /MUST NOT be manually spawned/, "production prose must forbid manual descriptor spawning");
  assert.match(section, /Filesystem receipts are\s+diagnostic only and never authorize hygiene signaling/, "the rule must deny receipt-based signaling authority");
  assert.match(section, /Briefs MUST be secret-free/, "the rule must state the argv prompt limitation");
  assert.match(section, /kimiLaneEnv\(\)/, "the rule must name the shared kimiLaneEnv() env derivation");
  // the always-emit -m rule and its rationale
  assert.match(section, /`-m` is ALWAYS\s*emitted/, "the rule must state -m is always emitted");
  assert.match(section, /binds only a process's SPAWNED\s*SUBAGENTS/, "the rule must state model_preference binds only spawned subagents");
  assert.match(section, /silently falls to config `default_model`/, "the rule must state that omitting -m falls to config default_model");
  // the receipt path: stream-json stdout + exit code + the session-usage verb
  assert.match(section, /stream-json result on stdout/, "the rule must name the stream-json stdout receipt");
  assert.match(section, /process exit code/, "the rule must name the process exit code receipt");
  assert.match(section, /`\$MUSTER_CLI kimi-session-usage --cwd <leg cwd> --stdout-file <captured stdout file>`/, "the rule must name the kimi-session-usage verb for per-leg token accounting");
  assert.match(section, /src\/kimi-receipts\.js's\s+`readSessionUsage`, reached through\s+`captureSessionId`\/`resolveSessionForCwd`/, "the rule must name readSessionUsage (src/kimi-receipts.js) and its resolution chain");
  assert.match(section, /docs\/research\/kimi-code-cli\.md sec 8/, "the rule must cite the receipts research section");
});
