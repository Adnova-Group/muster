// Split from the former test/codex.test.js monolith: generated Codex
// workflow surfaces (commands, orchestrator/router/review-gate skills,
// bounded public/internal skill inventories, and ported-skill harness binding).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { CODEX_COUNTS } from "../src/codex.js";
import { codexFallbackSkillId } from "../src/codex-catalog.js";
import { execFile, repoRoot, selectedPluginRoot } from "../test-support/codex-helpers.js";

test("packaged Codex workflows use the bundled CLI and Codex-native mode names", async () => {
  const commands = join(selectedPluginRoot, "commands");
  for (const entry of await readdir(commands, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const text = await readFile(join(commands, entry.name), "utf8");
    assert.doesNotMatch(text, /npx -y @adnova-group\/muster/, entry.name);
    assert.doesNotMatch(text, /\/muster:(?:plan|go|plan-backlog|go-backlog|run|autopilot|sprint|diagnose|audit|runner|capture)\b/, entry.name);
  }
  const router = await readFile(join(selectedPluginRoot, "internal-skills", "router", "SKILL.md"), "utf8");
  assert.match(router, /runtime\/muster\.mjs match --codex --skills/);
  assert.match(router, /compact Codex capability snapshot intentionally omits the global skill inventory/);
  const runner = await readFile(join(commands, "runner.md"), "utf8");
  assert.match(runner, /Usage: \$muster-runner/);
  assert.match(runner, /codex exec "\$muster-runner/);
  assert.doesNotMatch(runner, /\$muster-planner|Claude Code Routine|claude -p/);
  const coordination = await readFile(join(selectedPluginRoot, "internal-skills", "coordination", "SKILL.md"), "utf8");
  assert.match(coordination, /plugin cache is not a Git checkout/);
  assert.doesNotMatch(coordination, /git log -1 --format/);
  const orchestrator = await readFile(join(selectedPluginRoot, "internal-skills", "orchestrator", "SKILL.md"), "utf8");
  assert.match(orchestrator, /call `collaboration\.spawn_agent`/);
  assert.match(orchestrator, /agent_type: "<exact chosen\.id>"/);
  assert.match(orchestrator, /fork_turns: "none"/);
  assert.match(orchestrator, /never use `"all"`/);
  assert.match(orchestrator, /25-step ceiling/);
  assert.match(orchestrator, /Respect the configured Codex thread concurrency/);
  assert.match(orchestrator, /capabilities --codex --role <role>/);
  assert.match(orchestrator, /do not reprint the full skills inventory/);
  assert.match(orchestrator, /implementer leaf agent/);
  assert.match(orchestrator, /minimal dispatch packet/);
  assert.match(orchestrator, /Never attach unrelated plan items/);
  assert.match(orchestrator, /Workers are leaves and must not spawn descendants/);
  assert.match(orchestrator, /absolute `WORKTREE CWD`/);
  assert.match(orchestrator, /never read the parent checkout's `.muster` artifacts/);
  assert.match(orchestrator, /If the named type is rejected, stop with a registration diagnostic/);
  assert.match(orchestrator, /do not silently inherit the parent model/);
  assert.doesNotMatch(orchestrator, /generic-subagent fallback|isolation: "worktree"|hook-enforced -- these BLOCK/);

  for (const command of ["plan", "go", "plan-backlog", "go-backlog", "diagnose", "audit", "runner", "capture"]) {
    const commandText = await readFile(join(commands, `${command}.md`), "utf8");
    const skillText = await readFile(join(selectedPluginRoot, "skills", `muster-${command}`, "SKILL.md"), "utf8");
    assert.match(commandText, /runtime\/codex-skill-adapter\.md/, `${command} command must load the Codex adapter`);
    assert.match(skillText, /runtime\/codex-skill-adapter\.md/, `${command} skill must load the Codex adapter`);
  }
  const diagnose = await readFile(join(commands, "diagnose.md"), "utf8");
  assert.match(diagnose, /prints `\{mode, manifest\}` JSON to stdout/);
  assert.match(diagnose, /Extract the emitted `manifest` object/);
  assert.match(diagnose, /manifest validate \.muster\/manifest\.json --codex/);
  const audit = await readFile(join(commands, "audit.md"), "utf8");
  assert.match(audit, /prints the Crew Manifest JSON to stdout/);
  assert.match(audit, /manifest validate \.muster\/manifest\.json --codex/);
  const go = await readFile(join(commands, "go.md"), "utf8");
  assert.match(go, /manifest validate \.muster\/manifest\.json --codex/);
  for (const command of ["go", "diagnose", "audit"]) {
    const text = await readFile(join(commands, `${command}.md`), "utf8");
    assert.doesNotMatch(text, /manifest validate --codex(?:`|\s+until)/, `${command} must name the manifest file`);
  }
  for (const command of ["plan", "go", "plan-backlog"]) {
    const text = await readFile(join(commands, `${command}.md`), "utf8");
    assert.match(text, /capabilities --codex --roles-only/, `${command} should route from compact role capabilities`);
  }
  for (const command of ["plan-backlog", "go-backlog"]) {
    const text = await readFile(join(commands, `${command}.md`), "utf8");
    assert.match(
      text,
      /--max-concurrent-threads-per-session <effective agents\.max_concurrent_threads_per_session>/,
      `${command} must carry the effective Codex ceiling into deterministic wave scheduling`,
    );
  }
  const goBacklog = await readFile(join(commands, "go-backlog.md"), "utf8");
  assert.match(goBacklog, /self-healing transition/i, "generated Codex go-backlog must bootstrap isolation from a primary checkout");
  assert.match(goBacklog, /git worktree add/i, "generated Codex go-backlog must carry the driver-worktree recovery action");
  assert.match(goBacklog, /Continue the batch automatically/i, "generated Codex go-backlog must not stop after successful isolation recovery");
});

test("generated Codex init binds the bundled runtime without Claude resolver leakage", async () => {
  const init = await readFile(join(selectedPluginRoot, "commands", "init.md"), "utf8");
  assert.doesNotMatch(init, /\bCLAUDE_PLUGIN_ROOT\b/);
  assert.match(init, /MUSTER_CLI="node \$\{PLUGIN_ROOT\}\/runtime\/muster\.mjs"/);
  assert.match(init, /--to handoff --reason not-callable --expect AGENTS\.md/);
  assert.match(init, /generated project profile is provider\/model-neutral/i);
  assert.doesNotMatch(init, /\b(?:scout|core|prime|apex|haiku|sonnet|opus|fable|gpt-5(?:\.\d+)?)\b/i);
});

test("generated Codex package exposes the native-dispatch resolvers the orchestrator needs at runtime", async () => {
  // Runtime reachability: the codex-spawn-agent-dispatch item's follow-up asked for proof these
  // reach a CODEX-HOSTED muster running the BUNDLED plugin, not just the source repo -- exercise
  // the actual generated runtime/muster.mjs, never src/wave-dispatch.js directly.
  const runtimeCli = join(selectedPluginRoot, "runtime", "muster.mjs");
  const waveDispatch = JSON.parse((await execFile(process.execPath, [runtimeCli, "wave-dispatch", "--no-agent-teams"])).stdout);
  assert.equal(waveDispatch.mode, "prose");
  const worktreeIsolation = JSON.parse((await execFile(process.execPath, [runtimeCli, "worktree-isolation", "--harness", "codex"])).stdout);
  assert.deepEqual(worktreeIsolation, { harness: "codex", mechanism: "receipts-only", receiptRequired: true });

  // Doc reachability: the ported orchestrator/SKILL.md's wave-dispatch section is wholesale-replaced
  // for Codex (scripts/build-codex.mjs's adaptOrchestratorForCodex) -- that replacement must still
  // carry the Codex-specific resolvers (resolveCodexWaveDispatch's sequential-inline fallback,
  // resolveWorktreeIsolation's receipts-only mechanism) it stands in for, not silently drop them
  // along with the Claude-only prose it exists to replace.
  const orchestrator = await readFile(join(selectedPluginRoot, "internal-skills", "orchestrator", "SKILL.md"), "utf8");
  assert.match(orchestrator, /sequential-inline/);
  assert.match(orchestrator, /multiAgent: false|MUSTER_CODEX_MULTI_AGENT/);
  assert.match(orchestrator, /receipts-only/);
  assert.match(orchestrator, /worktree-isolation --harness codex/);

  // codex-receipt-verify-parity item: PR #78 wired the orchestrator's Claude-side prose to run
  // `receipt-verify` right after appending each dispatch receipt, but this same wave-dispatch
  // span is wholesale-replaced for Codex (adaptOrchestratorForCodex's waveDispatchHeading
  // replacement, above) and that replacement text never carried the instruction forward -- so
  // Codex-generated prose silently omitted verification on exactly the harness whose isolation
  // floor is receipts-only. Assert the replacement text now runs receipt-verify against the
  // bundled CLI and treats a nonzero exit as an escalation, never a silent continue.
  assert.match(orchestrator, /runtime\/muster\.mjs receipt-verify <baseSha> --cwd <absolute worktree path>/);
  assert.match(orchestrator, /nonzero exit as a receipt failure/);
  assert.match(orchestrator, /escalat(?:e|ion)/i);

  // The bundled runtime IS `src/cli.js` (esbuild-bundled, scripts/build-codex.mjs), so the
  // `receipt-verify` command ships automatically once PR #78 lands -- prove the actual generated
  // package's runtime carries it, not just the source repo's src/cli.js.
  const runtimeSource = await readFile(runtimeCli, "utf8");
  assert.match(runtimeSource, /receipt-verify/);
  assert.match(runtimeSource, /makeGitShaVerifier/);
});

// Every generated surface that carries the agent watch protocol (adapter + orchestrator +
// the root router and 14 mode skills), shared by the watch-invariant and dispatch-shape
// guards below and mirroring scripts/check-codex.mjs's own `watchSurfaces` list.
const watchInvariantSurfaces = new Map([
  ["adapter", join(selectedPluginRoot, "runtime", "codex-skill-adapter.md")],
  ["orchestrator", join(selectedPluginRoot, "internal-skills", "orchestrator", "SKILL.md")],
  ...["muster", "muster-init", "muster-design", "muster-plan", "muster-go", "muster-plan-backlog", "muster-go-backlog", "muster-diagnose", "muster-audit", "muster-runner", "muster-capture", "run", "autopilot", "sprint"]
    .map(name => [name, join(selectedPluginRoot, "skills", name, "SKILL.md")])
]);

test("generated Codex orchestration surfaces enforce the state-based agent watch invariant", async () => {
  const surfaces = watchInvariantSurfaces;
  assert.equal(surfaces.size, 16, "every generated Codex watch-invariant surface must be covered");
  for (const [name, path] of surfaces) {
    const text = await readFile(path, "utf8");
    assert.match(text, /collaboration\.list_agents/, `${name} must reconcile worker state`);
    assert.match(text, /collaboration\.wait_agent/, `${name} must wait for worker updates`);
    assert.match(text, /mailbox receipts first/, `${name} must process receipts before reconciliation`);
    assert.match(text, /mailbox receipts first[\s\S]{0,80}call `collaboration\.list_agents` exactly once/i, `${name} must require exactly one reconciliation after each wake`);
    assert.match(text, /running/, `${name} must identify an actively-running worker`);
    assert.match(text, /actively? in (?:a )?turn/, `${name} must inspect whether a worker is actively in a turn`);
    assert.match(text, /authoritative positive liveness/, `${name} must treat running as authoritative positive liveness`);
    assert.match(text, /must not be interrupted solely because any fixed silent-heartbeat count elapsed/i, `${name} must not kill running work on a fixed heartbeat count`);
    assert.match(text, /each heartbeat[\s\S]{0,160}reconcil(?:e|iation)/i, `${name} must reconcile state on every heartbeat`);
    for (const status of ["idle", "failed", "completed", "unreachable"]) {
      assert.match(text, new RegExp(`\\b${status}\\b`), `${name} must handle ${status} workers`);
    }
    assert.match(text, /non-running[\s\S]{0,220}(?:exhaust|handle)/i, `${name} must deterministically exhaust or handle non-running workers`);
    assert.match(text, /explicit (?:user )?cancellation/i, `${name} must preserve explicit user cancellation as a stop condition`);
    assert.match(text, /explicit task step violation/i, `${name} must stop explicit task step violations`);
    assert.match(text, /explicit task budget violation/i, `${name} must stop explicit task budget violations`);
    assert.match(text, /long-running active work/i, `${name} must name long-running active work`);
    assert.match(text, /periodic advisory progress/i, `${name} must surface periodic advisory progress`);
    assert.match(text, /advisory escalation[\s\S]{0,80}without killing or interrupting/i, `${name} must escalate advisory status without killing active work`);
    assert.doesNotMatch(text, /\b(?:6|10|14) consecutive silent heartbeats\b/i, `${name} must not carry fixed 6/10/14-heartbeat ceilings`);
    assert.doesNotMatch(text, /\bhard ceiling\b/i, `${name} must not carry hard heartbeat-ceiling language`);
    assert.doesNotMatch(text, /(?:Three|three) consecutive heartbeats|live after three(?: 60-second)? heartbeats/i, `${name} must not carry generic live-after-three interruption language`);
    assert.ok(text.indexOf("collaboration.wait_agent") < text.indexOf("collaboration.list_agents"), `${name} must wait before its first reconciliation poll`);
    assert.ok(text.indexOf("mailbox receipts first") < text.indexOf("collaboration.list_agents"), `${name} must process the wake receipt before reconciling`);
  }
});

// codex-watch-protocol-v1 item (audit 2026-07-30, slice S1): the watch protocol injected
// into all 13 mode skills, the root router, the orchestrator, and the copied
// runtime/codex-skill-adapter.md hardcoded v2-only `collaboration.spawn_agent`/`wait_agent`/
// `list_agents` phrasing -- but Codex resolves its subagent API PER MODEL, and muster's core
// tier (gpt-5.6-luna) speaks v1: `multi_agent_v1.*`, a `fork_context` bool instead of
// `fork_turns`, and a wait that REQUIRES `targets[]`. The 2026-07-29 slice D (ed54355)
// single-sourced the v1/v2 contract out of plugin/skills/orchestrator/references/
// codex-dispatch.md into the orchestrator's wave-dispatch span and go-backlog only; the watch
// protocol and the skill adapter never got threaded, so every one of those 16 surfaces still
// taught a Codex-luna session a dispatch shape its model rejects. These guards pin the
// reference's shapes table into each surface's watch section byte-for-byte and fail on a
// return to v2-only phrasing.
const DISPATCH_REFERENCE = join(repoRoot, "plugin", "skills", "orchestrator", "references", "codex-dispatch.md");
// Mirrors loadCodexDispatchContract's extraction in scripts/build-codex.mjs exactly.
async function dispatchContractBlock(startMarker) {
  const reference = await readFile(DISPATCH_REFERENCE, "utf8");
  const start = reference.indexOf(startMarker);
  const end = start < 0 ? -1 : reference.indexOf("\n\n", start);
  assert.ok(start >= 0 && end >= 0, `reference block starting at ${JSON.stringify(startMarker)} must exist`);
  return reference.slice(start, end);
}

test("generated Codex watch protocols teach BOTH multi-agent API shapes, not v2-only", async () => {
  const shapesTable = await dispatchContractBlock("| | v2 (`sol`, `terra`)");
  assert.match(shapesTable, /multi_agent_v1\.wait_agent/, "the reference table must still carry the v1 barrier shape");
  for (const [name, path] of watchInvariantSurfaces) {
    const text = await readFile(path, "utf8");
    const watch = text.slice(text.indexOf("## Agent watch invariant"));
    assert.ok(watch.length > 0, `${name} must carry an agent watch section`);
    assert.ok(
      watch.includes(shapesTable),
      `${name}'s watch protocol must carry the reference's v1/v2 shapes table byte-for-byte (single source: references/codex-dispatch.md)`
    );
    assert.match(watch, /VERSION-DEPENDENT/, `${name} must warn that the dispatch and barrier shapes are version-dependent`);
    assert.match(watch, /never hardcode one shape/, `${name} must forbid hardcoding one dispatch shape`);
    assert.match(watch, /multi_agent_v1\.spawn_agent/, `${name} teaches collaboration.* dispatch, so it must name the v1 spawn namespace (gpt-5.6-luna, muster's core tier, is v1)`);
    assert.match(watch, /multi_agent_v1\.wait_agent/, `${name} must name the v1 barrier, whose wait requires targets[]`);
    assert.match(watch, /fork_context: false/, `${name} must name v1's fork_context bool alongside v2's fork_turns`);
    assert.match(
      watch,
      /retain every canonical agent id returned by[\s\S]{0,160}multi_agent_v1\.spawn_agent/,
      `${name} must resolve the dispatch namespace per model version at the retain step`
    );
    assert.doesNotMatch(
      watch,
      /returned by `collaboration\.spawn_agent` and immediately call `collaboration\.wait_agent`/,
      `${name} must not carry the v2-only dispatch/barrier phrasing (a luna session rejects those tool names)`
    );
    // The v2 names stay -- both shapes ship, neither replaces the other.
    assert.match(watch, /collaboration\.spawn_agent/, `${name} must keep the v2 spawn shape`);
    assert.match(watch, /collaboration\.wait_agent/, `${name} must keep the v2 barrier shape`);
  }
});

test("generated Codex skill adapter single-sources the v1/v2 dispatch contract", async () => {
  const adapter = await readFile(join(selectedPluginRoot, "runtime", "codex-skill-adapter.md"), "utf8");
  const forkTurns = await dispatchContractBlock("`fork_turns` (v2 only)");
  assert.ok(
    adapter.includes(forkTurns),
    "the adapter's named-profile dispatch bullet must carry the reference's fork_turns paragraph byte-for-byte (single source: references/codex-dispatch.md)"
  );
  assert.match(adapter, /multi_agent_v1\.spawn_agent/, "the adapter must name the v1 spawn namespace");
  assert.match(adapter, /fork_context: false/, "the adapter must name v1's fork_context bool");
  assert.doesNotMatch(
    adapter,
    /call `collaboration\.spawn_agent` with the ordinary `task_name`/,
    "the adapter's dispatch bullet must not hardcode v2-only spawn for every resolved kind:agent provider"
  );
});

test("generated Codex review gates use compact, risk-based review dispatch", async () => {
  const text = await readFile(join(selectedPluginRoot, "internal-skills", "review-gate", "SKILL.md"), "utf8");
  assert.match(text, /capabilities --codex --role <role>/);
  assert.match(text, /never attach the full skills inventory/);
  assert.match(text, /Select one code reviewer for ordinary waves/);
  assert.match(text, /Add the security reviewer only/);
  assert.match(text, /one fix-and-re-review iteration/);
});

test("generated Codex audits cover six dimensions with three nonredundant scans", async () => {
  const text = await readFile(join(selectedPluginRoot, "commands", "audit.md"), "utf8");
  assert.match(text, /Quota-bounded dimension sweep/);
  assert.match(text, /three nonredundant read-only briefs/);
  assert.match(text, /Respect `agents\.max_concurrent_threads_per_session`/);
  assert.match(text, /fork_turns: "none"/);
  assert.doesNotMatch(text, /requested=6|six core dimensions remain independent/);
});

test("Codex fallbacks are self-contained and package referenced skill assets", async () => {
  const skills = join(selectedPluginRoot, "internal-skills");
  for (const name of ["muster-gsd-plan-phase", "muster-gsd-execute-phase", "muster-gsd-verify-work"]) {
    const text = await readFile(join(skills, name, "SKILL.md"), "utf8");
    assert.match(text, /self-contained|no dependency/i, name);
    assert.doesNotMatch(text, /@~\/\.claude|\$HOME\/\.claude|npx\s+-y\s+@opengsd/, name);
  }
  const api = await readFile(join(skills, "wsh-api-design-principles", "SKILL.md"), "utf8");
  assert.match(api, /references\/details\.md/);
  assert.match(await readFile(join(skills, "wsh-api-design-principles", "references", "details.md"), "utf8"), /API|api/);
  const signed = await readFile(join(skills, "wsh-signed-audit-trails-recipe", "SKILL.md"), "utf8");
  assert.match(signed, /Codex lifecycle hooks/);
  assert.doesNotMatch(signed, /\.claude\/settings\.json/);
  const catalog = await readFile(join(selectedPluginRoot, "catalog", "builtins.muster.yaml"), "utf8");
  assert.match(catalog, /rudra496\/StealthHumanizer/);
});

test("Codex exposes a bounded public skill surface while packaging internal workflows", async () => {
  const publicSkills = (await readdir(join(selectedPluginRoot, "skills"), { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.equal(publicSkills.length, CODEX_COUNTS.publicSkills);
  assert.deepEqual(publicSkills, [
    "autopilot", "muster", "muster-audit", "muster-capture", "muster-design", "muster-diagnose", "muster-go",
    "muster-go-backlog", "muster-init", "muster-plan", "muster-plan-backlog", "muster-runner", "run", "sprint"
  ]);

  const internalRoot = join(selectedPluginRoot, "internal-skills");
  const internalSkills = (await readdir(internalRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.equal(internalSkills.length, CODEX_COUNTS.internalSkills);
  for (const name of ["orchestrator", "router", "muster-research", "sp-tdd", "wsh-debugging-strategies"]) {
    const text = await readFile(join(internalRoot, name, "SKILL.md"), "utf8");
    assert.equal(parseYaml(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || "").name, name);
  }

  const adapter = await readFile(join(selectedPluginRoot, "runtime", "codex-skill-adapter.md"), "utf8");
  assert.match(adapter, /resolve-skill-provider\.mjs <chosen\.source> <chosen\.id>/);
  assert.match(adapter, /source === "builtin"/);
  assert.match(adapter, /source === "installed"/);
  assert.doesNotMatch(adapter, /read `\$\{PLUGIN_ROOT\}\/internal-skills\/\$\{chosen\.id\}/);
});

test("generated Codex public skill metadata stays within Muster's discovery budget", async () => {
  const expectedSkills = [
    "autopilot", "muster", "muster-audit", "muster-capture", "muster-design", "muster-diagnose", "muster-go",
    "muster-go-backlog", "muster-init", "muster-plan", "muster-plan-backlog", "muster-runner", "run", "sprint"
  ];
  const metadata = [];
  for (const name of expectedSkills) {
    const text = await readFile(join(selectedPluginRoot, "skills", name, "SKILL.md"), "utf8");
    const frontmatter = parseYaml(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || "");
    metadata.push({ name: frontmatter.name, description: frontmatter.description });
  }

  assert.deepEqual(metadata.map(skill => skill.name).sort(), expectedSkills);
  assert.ok(metadata.every(skill => typeof skill.description === "string" && skill.description.length > 0));
  const advertisedCharacters = metadata.reduce(
    (total, skill) => total + skill.name.length + skill.description.length,
    0
  );
  const discoveryBudget = CODEX_COUNTS.publicSkills * 65;
  assert.ok(
    advertisedCharacters <= discoveryBudget,
    `generated Muster skills advertise ${advertisedCharacters} name/description characters; expected at most ${discoveryBudget}`
  );
});

test("generated Codex muster-init delegates to the guarded authoritative workflow", async () => {
  const skill = await readFile(join(selectedPluginRoot, "skills", "muster-init", "SKILL.md"), "utf8");
  const command = await readFile(join(selectedPluginRoot, "commands", "init.md"), "utf8");
  const router = await readFile(join(selectedPluginRoot, "skills", "muster", "SKILL.md"), "utf8");

  assert.match(skill, /^name: muster-init$/m);
  assert.match(skill, /commands\/init\.md/);
  assert.match(router, /\$muster-init/);
  assert.match(command, /Usage: \$muster-init \[dir\]/);
  assert.match(command, /--to completed --evidence artifact-delta/);
  assert.match(command, /nativeInit\.state: "completed"/);
  assert.match(command, /never as native\s+initialization completed/);
  assert.doesNotMatch(command, /\/muster:init/);
});

test("all ported skills declare and load the Codex harness binding", async () => {
  const native = (await readdir(join(repoRoot, "plugin", "skills"), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  const builtins = (await readdir(join(repoRoot, "plugin", "builtins"), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  for (const name of new Set([...native, ...builtins])) {
    const id = codexFallbackSkillId(name);
    const skill = await readFile(join(selectedPluginRoot, "internal-skills", id, "SKILL.md"), "utf8");
    const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || "";
    assert.equal(parseYaml(frontmatter).name, id, id);
    assert.ok(parseYaml(frontmatter).description.startsWith("Codex-compatible Muster workflow."), id);
    assert.doesNotMatch(skill, /AskUserQuestion|\/muster:|Claude Code Agent tool|\bAgent tool|\bTask tool/, id);
    assert.match(skill, /runtime\/codex-skill-adapter\.md/, id);
  }
  assert.match(await readFile(join(selectedPluginRoot, "runtime", "codex-skill-adapter.md"), "utf8"), /Treat `Agent` and `Task` calls as Codex subagent dispatch/);
});
