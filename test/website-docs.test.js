/**
 * Drift test: website/ docs must reflect current code truth.
 *
 * 1. Every subcommand in src/cli.js's usage string must appear in website/reference/commands.md.
 * 2. Every hook event registered in plugin/hooks/hooks.json must appear in website/reference/architecture.md.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CODEX_COUNTS } from "../src/codex.js";
import { scoreHumanness } from "../src/humanizer-score.js";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");
const { version: releaseVersion } = JSON.parse(await read("package.json"));
const escapedReleaseVersion = releaseVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// --- helper: extract the usage line from cli.js and parse subcommand names ----

// USAGE is a joined array of per-group strings (one line per command group);
// reassemble the rendered single-line usage from the source before parsing.
function extractUsage(cliSource) {
  const decl = cliSource.match(/const USAGE = \[([\s\S]*?)\]\.join\(("(?:[^"\\]|\\.)*")\);/);
  if (!decl) throw new Error("Could not locate usage string in cli.js");
  const separator = JSON.parse(decl[2]);
  const parts = [...decl[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(([, s]) => JSON.parse(`"${s}"`));
  return parts.join(separator);
}

function extractSubcommands(cliSource) {
  // The usage string looks like:
  //   muster <detect|capabilities|match <task>|manifest validate <file>|...|steer <message>|...>
  // We want the first token after each | (or after <) before any space or <.
  const usageMatch = extractUsage(cliSource).match(/Usage: muster <([^`]+)>/);
  if (!usageMatch) throw new Error("Could not parse usage string in cli.js");

  const inner = usageMatch[1];
  const segments = [];
  let segment = "", angleDepth = 0, squareDepth = 0;
  for (const char of inner) {
    if (char === "<") angleDepth++;
    else if (char === ">") angleDepth--;
    else if (char === "[") squareDepth++;
    else if (char === "]") squareDepth--;
    if (char === "|" && angleDepth === 0 && squareDepth === 0) {
      segments.push(segment);
      segment = "";
    } else {
      segment += char;
    }
  }
  segments.push(segment);
  return segments
    .map((seg) => seg.trim().split(/[\s<]/)[0])
    .filter(Boolean)
    // strip any leftover ">" suffix from tokens like "id>" (e.g. from "<domain|id>")
    .map((tok) => tok.replace(/>$/, ""))
    .filter(Boolean)
    // nested alternatives in the usage grammar, not top-level commands
    .filter((tok) => tok !== "write" && !tok.startsWith("-"))
    // deduplicate
    .filter((tok, i, arr) => arr.indexOf(tok) === i);
}

// --- helper: extract event names from hooks.json -------------------------------

function extractHookEvents(hooksJson) {
  const obj = JSON.parse(hooksJson);
  return Object.keys(obj.hooks || {});
}

// --- tests -------------------------------------------------------------------

test("every CLI subcommand in usage string appears in website/reference/commands.md", async () => {
  const [cliSrc, commandsMd] = await Promise.all([
    read("src/cli.js"),
    read("website/reference/commands.md"),
  ]);

  const subcommands = extractSubcommands(cliSrc);
  assert.ok(subcommands.length > 0, "should find at least one subcommand");

  const documented = new Set();
  for (const [, cell] of commandsMd.matchAll(/^\|\s*((?:`[^`]+`(?:\s*\/\s*)?)+)\s*\|/gm)) {
    for (const [, command] of cell.matchAll(/`([^`\s[\]<|]+)/g)) documented.add(command);
  }
  const missing = subcommands.filter((cmd) => !documented.has(cmd));
  assert.deepEqual(
    missing,
    [],
    `commands.md is missing these subcommands from cli.js usage string: ${missing.join(", ")}`
  );
});

test("public navigation exposes every guide route and names the ten-mode reference", async () => {
  const config = await read("website/.vitepress/config.js");
  for (const route of [
    "/guides/get-started",
    "/guides/install",
    "/guides/quickstart",
    "/guides/harnesses",
    "/guides/codex",
    "/guides/kimi",
    "/guides/cowork",
    "/guides/chatgpt-work",
    "/guides/security",
    "/guides/troubleshooting",
  ]) {
    assert.match(config, new RegExp(`link:\\s*"${route}"`), `${route} must be reachable from navigation`);
  }
  assert.match(config, /text:\s*"The ten modes"/);
  assert.doesNotMatch(config, /The eight modes/);
});

test("public entry points consistently document ten modes including Design and Init", async () => {
  const pages = await Promise.all([
    read("website/index.md"),
    read("website/guides/quickstart.md"),
    read("website/guides/codex.md"),
    read("website/guides/install.md"),
    read("website/guides/kimi.md"),
    read("website/guides/harnesses.md"),
  ]);
  for (const page of pages) {
    assert.match(page, /\b[Tt]en modes\b/);
    assert.match(page, /\bDesign\b/);
    assert.match(page, /\bInit\b/);
    assert.doesNotMatch(page, /\b[Ee]ight modes\b/);
  }
  assert.match(pages[1], /\/muster:init/);
  assert.match(pages[1], /\/muster:design/);
  assert.match(pages[2], /\$muster-init/);
  assert.match(pages[2], /\$muster-design/);
});

test("harness documentation routes and support claims are explicit", async () => {
  const [config, harnesses, kimi, cowork] = await Promise.all([
    read("website/.vitepress/config.js"),
    read("website/guides/harnesses.md"),
    read("website/guides/kimi.md"),
    read("website/guides/cowork.md"),
  ]);
  for (const harness of ["Claude Code", "Codex", "Kimi", "Cowork"]) {
    assert.match(config, new RegExp(harness));
    assert.match(harnesses, new RegExp(harness));
  }
  assert.match(kimi, /support matrix/i);
  assert.match(kimi, /hooks-free/i);
  assert.match(kimi, new RegExp(`@adnova-group/muster@${escapedReleaseVersion}`));
  assert.match(kimi, /symbolic[\s\S]{0,100}`primary`[\s\S]{0,80}`secondary`/i);
  assert.match(kimi, /explicit[\s\S]{0,120}overrides[\s\S]{0,120}model_preference/i);
  assert.match(cowork, /support matrix/i);
  assert.match(cowork, /30 CLI-wrapper tools/i);
  assert.match(cowork, /`muster_sprint_protocol`/);
  assert.match(cowork, /phase-?3[\s\S]{0,260}before relying on parallel/i);
  assert.match(cowork, /orchestrator creates[\s\S]{0,120}dedicated isolated Git worktree[\s\S]{0,180}sequentially/i);
  assert.doesNotMatch(cowork, /write-capable wave items must run sequentially in the connected project/i);
  assert.doesNotMatch(cowork, /Parallel subagents \| Confirmed/i);
  assert.doesNotMatch(harnesses, /Confirmed subagent fan-out/i);
});

test("Init documentation pins the canonical instruction authority pair and conflict hold", async () => {
  const modes = await read("website/reference/modes.md");
  assert.match(modes, /`AGENTS\.md` is authoritative/i);
  assert.match(modes, /# Claude Code[\s\S]{0,40}@AGENTS\.md/);
  assert.match(modes, /existed at the preparation baseline[\s\S]{0,180}HUMAN-HOLD/i);
  assert.match(modes, /reverse `AGENTS\.md` reference to `CLAUDE\.md` cannot satisfy/i);
});

test("Codex guide documents current install, trust, audit, and safety limits", async () => {
  const codex = await read("website/guides/codex.md");
  const totalSkills = CODEX_COUNTS.publicSkills + CODEX_COUNTS.internalSkills;
  for (const phrase of [
    /per hook definition/i,
    /dry-run/i,
    /provenance/i,
    /three read-only briefs/i,
    /format validation/i,
    /real commit object/i,
    /scope you name/i,
  ]) {
    assert.match(codex, phrase);
  }
  assert.match(codex, new RegExp(`Skills \\| ${totalSkills} total`));
  assert.match(codex, new RegExp(`${CODEX_COUNTS.publicSkills} public`));
  assert.match(codex, /system quality[\s\S]{0,180}architecture[\s\S]{0,100}tech debt[\s\S]{0,100}simplification[\s\S]{0,100}readability/i);
  assert.match(codex, /coverage[\s\S]{0,120}test gaps/i);
  assert.match(codex, /security[\s\S]{0,120}(?:injection|secrets|unsafe IO|trust boundaries)/i);
  assert.doesNotMatch(codex, /All eight modes/);
  assert.equal(scoreHumanness(codex).passing, true, "website/guides/codex.md must pass humanizer score");
});

test("architecture pages describe current dependencies and repeatable Codex trust", async () => {
  const [architecture, concepts] = await Promise.all([
    read("website/reference/architecture.md"),
    read("website/reference/concepts.md"),
  ]);
  for (const page of [architecture, concepts]) {
    assert.match(page, /two runtime dependencies[\s\S]{0,100}(?:yaml[\s\S]{0,80}esbuild|esbuild[\s\S]{0,80}yaml)/i);
    assert.doesNotMatch(page, /single runtime dependency/i);
  }
  assert.match(architecture, /exact hook definition/i);
  assert.match(architecture, /review again|re-review/i);
  assert.doesNotMatch(architecture, /one-time trust review/i);
});

test("website publishes security reporting and doctor redaction guidance", async () => {
  const [security, troubleshooting] = await Promise.all([
    read("website/guides/security.md"),
    read("website/guides/troubleshooting.md"),
  ]);
  assert.match(security, /security advisories/i);
  assert.match(security, /privately/i);
  assert.match(troubleshooting, /redact/i);
  assert.match(troubleshooting, /doctor output/i);
  assert.doesNotMatch(troubleshooting, /paste the full `doctor` output/);
});

test("website install and uninstall examples pin the reviewed release", async () => {
  for (const file of [
    "website/guides/install.md",
    "website/guides/codex.md",
    "website/guides/kimi.md",
    "website/guides/troubleshooting.md",
  ]) {
    const page = await read(file);
    assert.doesNotMatch(page, /npx -y @adnova-group\/muster (?:install|uninstall)/);
    for (const line of page.split("\n").filter((value) => /npx -y @adnova-group\/muster.*(?:install|uninstall)/.test(value))) {
      assert.match(line, new RegExp(`@adnova-group/muster@${escapedReleaseVersion}`), `${file} has an unpinned mutation example: ${line}`);
    }
  }
});

test("website release surface routes through harness choice and publishes accessible brand metadata", async () => {
  const [config, home, getStarted, quickstart, harnesses, work] = await Promise.all([
    read("website/.vitepress/config.js"),
    read("website/index.md"),
    read("website/guides/get-started.md"),
    read("website/guides/quickstart.md"),
    read("website/guides/harnesses.md"),
    read("website/guides/chatgpt-work.md"),
  ]);
  assert.match(home, /text: Get Started[\s\S]{0,80}link: \/guides\/get-started/);
  assert.doesNotMatch(home, /(?:🔍|🧩|🌐|⚙️|🚦|🔒)/u);
  for (const harness of ["Claude Code", "Codex", "Kimi", "Cowork", "ChatGPT Work"]) {
    assert.match(getStarted, new RegExp(harness));
  }
  for (const disclosure of [/private\/local/i, /proof-gated/i, /Secure MCP Tunnel/i, /separately billed OpenAI Platform API key/i]) {
    assert.match(getStarted, disclosure);
    assert.match(work + harnesses, disclosure);
  }
  for (const mode of ["Plan", "Go", "Plan-backlog", "Go-backlog", "Diagnose", "Audit", "Design", "Runner", "Capture", "Init"]) {
    assert.match(quickstart, new RegExp(`>${mode}<|>${mode.replace("-", "-")}<|\\b${mode}\\b`, "i"));
  }
  for (const marker of ["favicon.svg", "muster-mark.svg", "social-preview.png", "og:image:alt", "twitter:image:alt"]) {
    assert.match(config, new RegExp(marker.replace(".", "\\.")));
  }
  for (const asset of [
    "website/public/brand/favicon.svg",
    "website/public/brand/muster-mark.svg",
    "website/public/brand/social-preview.png",
  ]) {
    assert.ok((await readFile(new URL(asset, root))).byteLength > 0, `${asset} must be non-empty`);
  }
});

test("every hook event in hooks.json appears in website/reference/architecture.md", async () => {
  const [hooksJson, archMd] = await Promise.all([
    read("plugin/hooks/hooks.json"),
    read("website/reference/architecture.md"),
  ]);

  const events = extractHookEvents(hooksJson);
  assert.ok(events.length > 0, "should find at least one hook event");

  const missing = events.filter((ev) => !archMd.includes(ev));
  assert.deepEqual(
    missing,
    [],
    `architecture.md is missing these hook events from hooks.json: ${missing.join(", ")}`
  );
});

test("architecture docs name every network-capable CLI boundary and offline behavior", async () => {
  const docs = await Promise.all([
    read("docs/architecture.md"),
    read("website/reference/architecture.md"),
  ]);
  for (const doc of docs) {
    assert.doesNotMatch(doc, /one carve-out is the `issue` verb/);
    assert.match(doc, /four boundaries/i);
    for (const command of ["`issue`", "`vendor`", "`doctor`", "`install kimi --probe`"]) {
      assert.match(doc, new RegExp(command));
    }
    assert.match(doc, /offline/i);
  }
});

test("command reference documents safe help, install style ownership, and signals target output", async () => {
  const commands = await read("website/reference/commands.md");
  assert.match(commands, /`help \[command\]`/);
  assert.match(commands, /`muster <command> --help`/);
  assert.match(commands, /output-styles\/muster\.md/);
  assert.match(commands, /\[dir\]\/\.muster\/signals\.json/);
  assert.doesNotMatch(commands, /Run any verb with no arguments to see its usage/);
});

test("command reference documents backlog-publish CAS, locking, containment, and retry contract", async () => {
  const commands = await readFile(new URL("../website/reference/commands.md", import.meta.url), "utf8");
  assert.match(commands, /backlog-publish <backlog\.md> --expect <sha256\\?\|absent>/);
  assert.match(commands, /compare-and-swap|CAS/i);
  assert.match(commands, /lock/i);
  assert.match(commands, /run root|contained/i);
  assert.match(commands, /reread.*retry|retry.*reread/i);
});
