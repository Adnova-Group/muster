import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSprintBrokerStateStore } from "../src/sprint-broker-state.js";

const TOKEN = "a".repeat(64);

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "muster-broker-state-"));
  await chmod(dir, 0o700);
  const statePath = join(dir, "state.json");
  const checkpointPath = join(dir, "checkpoint.json");
  const lockPath = join(dir, "state.lock");
  const state = {
    version: 1,
    runId: "run-a",
    callbackPrincipals: {
      [TOKEN]: {
        actorId: "human-a",
        purposes: ["approval"],
        oneTimeApproval: { itemId: "a" },
      },
    },
    items: { a: {} },
  };
  await writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  const options = { statePath, checkpointPath, lockPath };
  return { dir, statePath, options, store: createSprintBrokerStateStore(options) };
}

const consume = (state) => {
  delete state.callbackPrincipals[TOKEN];
  return state;
};

test("shared CAS prevents a stale publisher from resurrecting a capability when consumption commits first", async () => {
  const value = await fixture();
  try {
    const publisher = createSprintBrokerStateStore(value.options);
    const before = await value.store.read();
    await value.store.mutate(before, consume);

    const stalePublication = structuredClone(before.state);
    stalePublication.items.b = {};
    await assert.rejects(
      publisher.mutate(before, () => stalePublication),
      (error) => error.code === "STATE_CONFLICT",
    );
    const final = await publisher.read();
    assert.equal(final.version, 2);
    assert.equal(final.state.callbackPrincipals[TOKEN], undefined);
  } finally { await rm(value.dir, { recursive: true, force: true }); }
});

test("shared CAS makes a stale consumer retry when publication commits first and prevents later resurrection", async () => {
  const value = await fixture();
  try {
    const publisher = createSprintBrokerStateStore(value.options);
    const before = await value.store.read();
    const publication = structuredClone(before.state);
    publication.items.b = {};
    const published = await publisher.mutate(before, () => publication);

    await assert.rejects(
      value.store.mutate(before, consume),
      (error) => error.code === "STATE_CONFLICT",
    );
    const consumed = await value.store.mutate(await value.store.read(), consume);
    assert.equal(consumed.version, 3);

    const staleResurrection = structuredClone(published.state);
    await assert.rejects(
      publisher.mutate(published, () => staleResurrection),
      (error) => error.code === "STATE_CONFLICT",
    );
    const final = await publisher.read();
    assert.equal(final.version, 3);
    assert.equal(final.state.callbackPrincipals[TOKEN], undefined);
    assert.ok(final.state.items.b);
  } finally { await rm(value.dir, { recursive: true, force: true }); }
});

test("durable checkpoint rejects consumed state rollback after broker restart", async () => {
  const value = await fixture();
  try {
    const oldText = await readFile(value.statePath, "utf8");
    await value.store.mutate(await value.store.read(), consume);
    await writeFile(value.statePath, oldText);

    const restarted = createSprintBrokerStateStore(value.options);
    await assert.rejects(restarted.read(), /durable monotonic checkpoint/);
  } finally { await rm(value.dir, { recursive: true, force: true }); }
});
