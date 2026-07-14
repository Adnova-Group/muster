import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withCodexFileLock } from "../src/codex-lock.js";

test("Codex retirement accepts mode-unavailable filesystems only with stable directory identity", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-mode-unavailable-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  let probes = 0;
  const modeCapability = async ({ dir, stat }) => {
    probes++;
    assert.equal(stat.isDirectory(), true);
    assert.match(dir, /\.muster-retired-/);
    return false;
  };
  await withCodexFileLock(join(tmp, "stable.lock"), async () => {}, { modeCapability });
  assert.equal(probes, 1);

  const replacementLock = join(tmp, "replaced.lock");
  await assert.rejects(withCodexFileLock(replacementLock, async () => {}, {
    modeCapability,
    afterRetirement: async state => {
      await rename(state.dir, `${state.dir}.replacement`);
      await mkdir(state.dir, { mode: 0o777 });
    }
  }), /retirement directory/i);
});
