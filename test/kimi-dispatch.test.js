// Kimi-native dispatch: AgentSwarm waves + /goal run loop.
// Constants here are pinned to the shipped kimi binary's own tool schema
// (v0.29.0, unstripped) -- notably {{item}}, the >=2-item floor, the 128 cap,
// the DISTINCT-prompts rule (absent from published docs), and
// GOAL_EXIT_CODES {complete:0, blocked:3, paused:6}.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  kimiSwarmCall, kimiAgentCall, kimiGoalInvocation, interpretKimiGoalExit, resolveKimiWaveDispatch,
  KIMI_SWARM_PLACEHOLDER, KIMI_SWARM_MAX_SUBAGENTS, KIMI_GOAL_EXIT_CODES, KIMI_GOAL_MAX_OBJECTIVE, KIMI_DISPATCH_MODES
} from "../src/kimi-dispatch.js";
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

test("orchestrator/SKILL.md's native-dispatch block has a Kimi subsection naming the shipped helpers", async () => {
  const text = await readFile(new URL("../plugin/skills/orchestrator/SKILL.md", import.meta.url), "utf8");
  const match = text.match(/### Kimi-native dispatch[^\n]*\n([\s\S]*?)(?=\n### |\n## |$)/);
  assert.ok(match, "orchestrator/SKILL.md must carry a '### Kimi-native dispatch' subsection in the native-dispatch block");
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

test("orchestrator/SKILL.md's re-dispatch-once failure rule names the Kimi resume path", async () => {
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
  assert.match(bullet, /max 2 attempts/, "the one-retry cap is unchanged");

  // ...and the Kimi-native dispatch subsection carries the matching mechanics.
  const kimi = text.match(/### Kimi-native dispatch[^\n]*\n([\s\S]*?)(?=\n### |\n## |$)/);
  assert.ok(kimi, "the Kimi-native dispatch subsection must exist");
  assert.match(kimi[1], /Failure retry rides the same native shapes/, "the Kimi subsection must carry the failure-retry resume paragraph");
  assert.match(kimi[1], /kimiAgentCall\(\{ resume: /, "the Kimi subsection must show the per-agent resume retry shape");
  assert.match(kimi[1], /kimiSwarmCall\(\{ resumeAgentIds: /, "the Kimi subsection must show the swarm resume retry shape");
  assert.match(kimi[1], /mutually exclusive with `subagent_type`/, "the Kimi subsection must state resume's mutual exclusion with subagent_type");
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
});
