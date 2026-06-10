/**
 * Drift test: website/ docs must reflect current code truth.
 *
 * 1. Every subcommand in src/cli.js's usage string must appear in website/reference/commands.md.
 * 2. Every hook event registered in plugin/hooks/hooks.json must appear in website/reference/architecture.md.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

// --- helper: extract the usage line from cli.js and parse subcommand names ----

function extractSubcommands(cliSource) {
  // The usage string looks like:
  //   muster <detect|capabilities|match <task>|manifest validate <file>|...|steer <message>|...>
  // We want the first token after each | (or after <) before any space or <.
  const usageMatch = cliSource.match(/Usage: muster <([^`]+)>/);
  if (!usageMatch) throw new Error("Could not locate usage string in cli.js");

  const inner = usageMatch[1];
  // split on | and take first word of each segment, filtering out arg placeholders
  return inner
    .split("|")
    .map((seg) => seg.trim().split(/[\s<]/)[0])
    .filter(Boolean)
    // strip any leftover ">" suffix from tokens like "id>" (e.g. from "<domain|id>")
    .map((tok) => tok.replace(/>$/, ""))
    .filter(Boolean)
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

  const missing = subcommands.filter((cmd) => !commandsMd.includes(cmd));
  assert.deepEqual(
    missing,
    [],
    `commands.md is missing these subcommands from cli.js usage string: ${missing.join(", ")}`
  );
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
