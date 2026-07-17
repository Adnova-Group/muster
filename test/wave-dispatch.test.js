// test/wave-dispatch.test.js — capability-check + fallback-selection logic behind the
// workflow-tool-delegation item (orchestrator/SKILL.md's "Wave dispatch: native Workflow
// vs prose fallback" section).
//
// Claude Code CLI's agent-teams surface exposes a native, deterministic Workflow tool
// (fan-out + barrier as code) -- reached ONLY through agent-teams/background-agent mode,
// never the single-session loop a plain `claude` invocation runs (docs/research/
// claude-code-cli.md sec 1's binary-tools evidence + sec 11's `claude agents` subcommand;
// docs/strategy/native-delegation.md Part B item 1).
// There is no on-disk/protocol signal an outside process can probe to detect agent-teams
// mode from inside a running session, so this is a DECLARED capability (same shape as
// Cowork's nativePluginRide, src/harness.js/src/capabilities.js) -- never an auto-probe.
// The native tool itself is not invocable from a test; what's fixture-driven and
// unit-testable is the pure SELECTION branch: given a declared/observed capability
// signal, which mode (native vs prose) does the orchestrator ride, and does the prose
// floor stay the unconditional default when nothing is declared.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_TEAMS_ENV,
  WAVE_DISPATCH_MODES,
  declaredAgentTeams,
  resolveWaveDispatch,
} from "../src/wave-dispatch.js";

test("resolveWaveDispatch: no signal at all (no agentTeams arg, no env) selects the prose fallback", () => {
  const r = resolveWaveDispatch({ env: {} });
  assert.equal(r.mode, WAVE_DISPATCH_MODES.PROSE);
  assert.equal(r.agentTeams, false);
  assert.match(r.reason, /prose wave loop/);
});

test("resolveWaveDispatch: agentTeams:true (session self-observed Workflow tool) selects native", () => {
  const r = resolveWaveDispatch({ agentTeams: true, env: {} });
  assert.equal(r.mode, WAVE_DISPATCH_MODES.NATIVE);
  assert.equal(r.agentTeams, true);
  assert.match(r.reason, /native Workflow tool/);
});

test("resolveWaveDispatch: agentTeams:false explicitly overrides a truthy env declaration (self-observation wins)", () => {
  const r = resolveWaveDispatch({ agentTeams: false, env: { [AGENT_TEAMS_ENV]: "1" } });
  assert.equal(r.mode, WAVE_DISPATCH_MODES.PROSE);
  assert.equal(r.agentTeams, false);
});

test("resolveWaveDispatch: agentTeams omitted falls back to the declared env var", () => {
  const on = resolveWaveDispatch({ env: { [AGENT_TEAMS_ENV]: "1" } });
  assert.equal(on.mode, WAVE_DISPATCH_MODES.NATIVE);
  const off = resolveWaveDispatch({ env: { [AGENT_TEAMS_ENV]: "0" } });
  assert.equal(off.mode, WAVE_DISPATCH_MODES.PROSE);
});

test("resolveWaveDispatch: called with no args at all still resolves (real process.env), never throws", () => {
  const r = resolveWaveDispatch();
  assert.ok(r.mode === WAVE_DISPATCH_MODES.NATIVE || r.mode === WAVE_DISPATCH_MODES.PROSE);
});

test("declaredAgentTeams: MCPB-boolean-safe parse -- only 1/true-ish values enable, mirrors MUSTER_ENABLE_FABLE/MUSTER_COWORK_NATIVE_PLUGIN", () => {
  assert.equal(declaredAgentTeams({ [AGENT_TEAMS_ENV]: "1" }), true);
  assert.equal(declaredAgentTeams({ [AGENT_TEAMS_ENV]: "true" }), true);
  assert.equal(declaredAgentTeams({ [AGENT_TEAMS_ENV]: "TRUE" }), true);
  for (const v of ["0", "false", "FALSE", "", undefined]) {
    assert.equal(declaredAgentTeams({ [AGENT_TEAMS_ENV]: v }), false, `expected "${v}" to not enable`);
  }
  assert.equal(declaredAgentTeams({}), false, "absent env var must not enable");
});

test("resolveWaveDispatch: prose is the floor -- an absent or explicitly-false declaration resolves to prose, never a silent third mode", () => {
  for (const input of [{ env: {} }, { agentTeams: undefined, env: {} }, { env: { [AGENT_TEAMS_ENV]: "false" } }]) {
    const r = resolveWaveDispatch(input);
    assert.equal(r.mode, WAVE_DISPATCH_MODES.PROSE);
  }
});
