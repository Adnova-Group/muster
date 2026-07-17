import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Regression test for the coordination standing-context preflight's fingerprint set
// (backlog item `coordination-preflight`). The preflight exists to catch drift in
// "every file a runner's behavior is actually bound by" -- but two of its five
// watched paths (plugin/commands/sprint.md, plugin/commands/autopilot.md) were minimal
// legacy-alias stubs that only redirect to plugin/commands/go-backlog.md and
// plugin/commands/go.md respectively (per the mode/plan/go verb-lexicon rename) and
// never again carry the behavior they were named for -- the mechanism was blind to
// edits in exactly the files it exists to watch. This test pins both copies of the
// fingerprint set in plugin/skills/coordination/SKILL.md (the git-log command and the
// short-form parenthetical restating the same set, both now co-located in the
// "Standing-context preflight" section itself post the coordination-footprint
// de-duplication -- previously the second copy lived in Binding C's own prose) to
// (a) name zero known alias-stub filenames, (b) agree with each other, and (c)
// actually include the live behavior files.

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

const SKILL = "plugin/skills/coordination/SKILL.md";

// Known dead alias stubs as of the mode/plan/go verb-lexicon rename -- each is a
// minimal redirect, never the live behavior file. `run.md` is included defensively
// even though it was never actually part of the fingerprint set (it aliases
// plugin/commands/plan.md, unrelated to the sprint/autopilot -> go-backlog/go
// rename) -- the assertion is "the fingerprint set never regresses to naming ANY of
// these", not "these three specific files used to be there".
const ALIAS_STUB_BASENAMES = ["sprint.md", "run.md", "autopilot.md"];

// A path segment's basename: the last non-empty "/"-delimited token, so a directory
// path (`plugin/hooks/`) yields `hooks` the same way a file path
// (`plugin/commands/go.md`) yields `go.md` -- both fingerprint copies below use one
// or the other shorthand.
function basename(pathLike) {
  const parts = pathLike.split("/").filter(Boolean);
  return parts[parts.length - 1];
}

function extractGitLogFingerprint(text) {
  const m = text.match(/```\ngit log -1 --format=%h -- ([\s\S]+?)\n```/);
  assert.ok(m, `could not find the standing-context preflight's \`git log -1\` fingerprint command in ${SKILL}`);
  return m[1]
    .replace(/\\\n\s*/g, " ") // join a backslash line-continuation into one line
    .split(/\s+/)
    .filter(Boolean);
}

function extractBindingCFingerprint(text) {
  const m = text.match(/fingerprint set \(([^)]+)\)/);
  assert.ok(m, `could not find Binding C's parenthetical fingerprint-set mention in ${SKILL}`);
  return m[1].split("/").filter(Boolean);
}

test("standing-context preflight: the git-log fingerprint command names zero alias-stub files", async () => {
  const text = await read(SKILL);
  const paths = extractGitLogFingerprint(text);
  assert.ok(paths.length > 0, "fingerprint command's path list parsed empty");
  const basenames = paths.map(basename);
  for (const stub of ALIAS_STUB_BASENAMES) {
    assert.ok(
      !basenames.includes(stub),
      `fingerprint command still names alias-stub file "${stub}" -- watch its live target instead: ${paths.join(" ")}`
    );
  }
});

test("standing-context preflight: Binding C's fingerprint-set mention names zero alias-stub files", async () => {
  const text = await read(SKILL);
  const basenames = extractBindingCFingerprint(text);
  assert.ok(basenames.length > 0, "Binding C's fingerprint-set parenthetical parsed empty");
  for (const stub of ALIAS_STUB_BASENAMES) {
    assert.ok(
      !basenames.includes(stub),
      `Binding C's fingerprint-set mention still names alias-stub file "${stub}": (${basenames.join("/")})`
    );
  }
});

test("standing-context preflight: both fingerprint-set copies name the exact same files", async () => {
  const text = await read(SKILL);
  const cmdBasenames = extractGitLogFingerprint(text).map(basename).sort();
  const bindingCBasenames = extractBindingCFingerprint(text).sort();

  assert.deepEqual(
    bindingCBasenames,
    cmdBasenames,
    `the two fingerprint-set copies have drifted apart: git-log command names [${cmdBasenames.join(", ")}], Binding C mention names [${bindingCBasenames.join(", ")}]`
  );
});

test("standing-context preflight: the live behavior files replace the dead alias stubs", async () => {
  const text = await read(SKILL);
  const basenames = extractGitLogFingerprint(text).map(basename);
  for (const live of ["go-backlog.md", "go.md", "runner.md"]) {
    assert.ok(basenames.includes(live), `fingerprint set is missing live behavior file "${live}": ${basenames.join(", ")}`);
  }
});
