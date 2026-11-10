// test/sprint-parallel-cap.test.js -- prose-consistency pin for the MUSTER_SPRINT_PARALLEL
// wave-mode cap (backlog item `sprint-parallel-5-10`). The cap is orchestration-protocol
// discipline read from plugin/commands/go-backlog.md, not library code -- so the values are
// pinned here instead of unit-tested: default 5, hard ceiling 10, above-ceiling clamps,
// 0 invalid falls back to the default. Every doc surface that states the cap must agree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(p, "utf8");

test("README + website env tables agree on default 5 / ceiling 10", async () => {
  for (const path of ["README.md", "website/reference/configuration.md"]) {
    const text = await read(path);
    const row = text.split("\n").find((l) => l.startsWith("| `MUSTER_SPRINT_PARALLEL`"));
    assert.ok(row, `${path} must carry a MUSTER_SPRINT_PARALLEL row`);
    assert.match(row, /\| `5` \|/, `${path} row must show default 5`);
    assert.match(row, /ceiling `10`/, `${path} row must show ceiling 10`);
  }
});

test("no live doc surface still pins the old 3/8 sprint-parallel values", async () => {
  for (const path of [
    "README.md",
    "docs/architecture.md",
    "website/reference/configuration.md",
    "website/reference/modes.md",
    "website/guides/quickstart.md",
  ]) {
    const text = await read(path);
    const stale = text.split("\n").filter(
      (l) => l.includes("MUSTER_SPRINT_PARALLEL") && (/default 3/.test(l) || /ceiling 8/.test(l) || /clamp to 8/.test(l))
    );
    assert.deepEqual(stale, [], `${path} still pins old sprint-parallel values: ${stale[0] || ""}`);
  }
});
