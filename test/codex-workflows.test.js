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

test("generated Codex orchestration surfaces enforce the bounded, liveness-aware agent watch invariant", async () => {
  const surfaces = new Map([
    ["adapter", join(selectedPluginRoot, "runtime", "codex-skill-adapter.md")],
    ["orchestrator", join(selectedPluginRoot, "internal-skills", "orchestrator", "SKILL.md")],
    ...["muster-plan", "muster-go", "muster-plan-backlog", "muster-go-backlog", "muster-diagnose", "muster-audit", "muster-runner", "muster-capture", "run", "autopilot", "sprint"]
      .map(name => [name, join(selectedPluginRoot, "skills", name, "SKILL.md")])
  ]);
  // Pin re-derived for the codex-agent-watch-review-budget item (2026-07-19 dogfood: a healthy
  // gpt-5.6-sol/high muster-reviewer was interrupted mid-review by the flat 3-heartbeat kill --
  // review-class reasoning routinely exceeds 3 silent minutes with zero mailbox receipts). The
  // watch is now liveness-aware (a `list_agents`-confirmed in-turn worker is extended, not killed)
  // with per-class ceilings bounding the extension: 10 silent heartbeats for review/strategy-class
  // workers, 6 for mechanical/implementation lanes. Genuinely idle/completed/failed workers still
  // die at 3 heartbeats exactly as before.
  const watchMarkers = ["collaboration.list_agents", "collaboration.wait_agent", "60 seconds", "message or completion receipt", "mailbox receipts first", "exactly once", "newly ready work", "Three consecutive heartbeats", "Never tight-poll", "Respect the configured `agents.max_threads`", "fork_turns: \"none\"", "25-step ceiling", "one follow-up", "worker budget exhaustion", "THINKING, not hung", "10 consecutive silent heartbeats", "6 consecutive silent heartbeats", "muster-reviewer", "wsh-code-reviewer", "muster-strategist", "wsh-security-auditor", "DeepSWE sol/high", "liveness checkpoint"];
  for (const [name, path] of surfaces) {
    const text = await readFile(path, "utf8");
    for (const marker of watchMarkers) {
      assert.match(text, new RegExp(marker.replaceAll(".", "\\.")), `${name} must carry watch marker ${marker}`);
    }
    assert.ok(text.indexOf("collaboration.wait_agent") < text.indexOf("collaboration.list_agents"), `${name} must wait before its first reconciliation poll`);
    assert.ok(text.indexOf("mailbox receipts first") < text.indexOf("collaboration.list_agents"), `${name} must process the wake receipt before reconciling`);
    assert.match(
      text,
      /muster-reviewer`, `wsh-code-reviewer`, `muster-strategist`, `wsh-security-auditor`\) get a hard ceiling of 10 consecutive silent heartbeats/,
      `${name} must bind the 10-heartbeat ceiling to the named review\\/strategy-class workers`
    );
    assert.match(
      text,
      /Mechanical\/implementation workers[\s\S]{0,200}?6 consecutive silent heartbeats/,
      `${name} must bind the 6-heartbeat ceiling to mechanical\\/implementation workers`
    );
  }
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
  assert.match(text, /Respect `agents\.max_threads`/);
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
    "autopilot", "muster", "muster-audit", "muster-capture", "muster-diagnose", "muster-go",
    "muster-go-backlog", "muster-plan", "muster-plan-backlog", "muster-runner", "run", "sprint"
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
