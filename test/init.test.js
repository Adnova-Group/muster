import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  acknowledgeNativeInitHandoff,
  canonicalInitJson,
  finalizeInitialization,
  initializeProject,
  learnProjectProfile,
  observeNativeInit,
  readInitReceipt,
  transitionNativeInit,
} from "../src/init.js";
import { trackedMkdtemp as mkdtemp } from "../test-support/helpers.js";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const tmp = () => mkdtemp(join(tmpdir(), "muster-init-"));
const pexecFile = promisify(execFile);

test("canonicalInitJson recursively sorts keys and rejects non-JSON values", () => {
  assert.equal(canonicalInitJson({ z: 1, a: { d: true, c: null } }), '{"a":{"c":null,"d":true},"z":1}');
  assert.throws(() => canonicalInitJson({ bad: 1.2 }), /integer/);
});

test("initializeProject prepares deterministic greenfield state without instruction seeds", async () => {
  const dir = await tmp();
  const first = await initializeProject(dir);
  assert.equal(first.receipt.classification, "greenfield");
  assert.equal(first.receipt.phase, "prepared");
  assert.equal(first.observedNativeEvidence, null);
  assert.equal(first.receipt.nativeInit.state, "not-requested");
  await assert.rejects(() => stat(join(dir, "AGENTS.md")), { code: "ENOENT" });
  await assert.rejects(() => stat(join(dir, "README.md")), { code: "ENOENT" });
  assert.equal(JSON.parse(await readFile(join(dir, ".muster/project-profile.json"), "utf8")).format, "muster.project-profile");
  const before = await readFile(join(dir, ".muster/init-receipt.json"));
  const second = await initializeProject(dir);
  const after = await readFile(join(dir, ".muster/init-receipt.json"));
  assert.deepEqual(second, first);
  assert.deepEqual(after, before);
});

test("project learning records bounded repository facts, not provider or model resolution", async () => {
  const dir = await tmp();
  await writeFile(join(dir, "package.json"), '{"scripts":{"test":"node --test"},"dependencies":{"express":"1"}}');
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src/index.js"), "export {};\n");
  const profile = await learnProjectProfile(dir);
  assert.equal(profile.classification, "brownfield");
  assert.deepEqual(profile.facts.languages, ["javascript"]);
  assert.deepEqual(profile.facts.frameworks, ["express"]);
  assert.deepEqual(profile.facts.packageManagers, ["npm"]);
  assert.deepEqual(profile.facts.sourceRoots, ["src"]);
  assert.deepEqual(profile.facts.testRunners, ["node --test"]);
  assert.doesNotMatch(JSON.stringify(profile), /provider|model/i);
});

test("handoff baseline is immutable and completion requires artifact delta evidence", async () => {
  const dir = await tmp();
  await initializeProject(dir);
  const handoff = await transitionNativeInit(dir, {
    to: "handoff", reason: "not-callable", expectedArtifacts: ["AGENTS.md"],
  });
  assert.deepEqual(handoff.receipt.nativeInit.baseline, [{ bytes: null, path: "AGENTS.md", sha256: null }]);
  assert.equal((await observeNativeInit(dir)).observedNativeEvidence, null);
  await assert.rejects(
    () => transitionNativeInit(dir, { to: "completed", evidenceKind: "artifact-delta" }),
    /artifact delta evidence is not present/,
  );
  await writeFile(join(dir, "AGENTS.md"), "# Native\n");
  const observed = await observeNativeInit(dir);
  assert.deepEqual(observed.observedNativeEvidence, {
    kind: "artifact-delta",
    artifacts: [{ after: sha("# Native\n"), before: null, path: "AGENTS.md" }],
  });
  const completed = await transitionNativeInit(dir, { to: "completed", evidenceKind: "artifact-delta" });
  assert.equal(completed.receipt.nativeInit.state, "completed");
  assert.deepEqual(completed.receipt.nativeInit.baseline, handoff.receipt.nativeInit.baseline);
  assert.deepEqual((await transitionNativeInit(dir, { to: "completed" })), completed);
  await assert.rejects(
    () => transitionNativeInit(dir, { to: "handoff", reason: "not-callable", expectedArtifacts: ["AGENTS.md"] }),
    /absorbing/,
  );
});

test("pre-existing confirmation and call-result evidence validate exact external shapes", async () => {
  const pre = await tmp();
  await writeFile(join(pre, "AGENTS.md"), "# Existing\n");
  await initializeProject(pre);
  await transitionNativeInit(pre, {
    to: "handoff", reason: "instruction-present", expectedArtifacts: ["AGENTS.md"],
  });
  await writeFile(join(pre, "confirmation.json"), canonicalInitJson({
    artifacts: ["AGENTS.md"], confirmation: "already-initialized",
    format: "muster.native-init-confirmation", schemaVersion: 1,
  }) + "\n");
  const confirmed = await transitionNativeInit(pre, {
    to: "completed", evidenceKind: "preexisting-confirmed", evidenceFile: "confirmation.json",
  });
  assert.equal(confirmed.receipt.nativeInit.evidence.kind, "preexisting-artifact-confirmed");

  const called = await tmp();
  await initializeProject(called);
  const attempted = await transitionNativeInit(called, { to: "attempted", expectedArtifacts: ["CLAUDE.md"] });
  await writeFile(join(called, "CLAUDE.md"), "# Native\n");
  await writeFile(join(called, "result.json"), canonicalInitJson({
    artifacts: ["CLAUDE.md"], format: "muster.native-init-result",
    attemptId: attempted.receipt.nativeInit.attemptId,
    ok: true, operation: "native-init", schemaVersion: 1,
  }) + "\n");
  const result = await transitionNativeInit(called, {
    to: "completed", evidenceKind: "call-result", evidenceFile: "result.json",
  });
  assert.equal(result.receipt.nativeInit.evidence.kind, "call-result");
  await writeFile(join(called, "CLAUDE.md"), "# Stale\n");
  await assert.rejects(() => readInitReceipt(called), /evidence artifact.*changed/);
});

test("acknowledged unavailable handoff permits greenfield finalization but brownfield is preserved", async () => {
  const green = await tmp();
  await initializeProject(green);
  await transitionNativeInit(green, { to: "handoff", reason: "unavailable", expectedArtifacts: [] });
  await acknowledgeNativeInitHandoff(green, { reason: "unavailable" });
  const finalized = await finalizeInitialization(green);
  assert.equal(finalized.receipt.phase, "finalized");
  assert.equal(finalized.receipt.nativeInit.state, "handoff");
  assert.ok(finalized.receipt.artifacts.created.includes("README.md"));
  assert.ok(finalized.receipt.artifacts.created.includes("docs/design/.gitkeep"));
  await assert.rejects(() => stat(join(green, "AGENTS.md")), { code: "ENOENT" });

  const brown = await tmp();
  await writeFile(join(brown, "README.md"), "USER\n");
  await initializeProject(brown);
  await transitionNativeInit(brown, { to: "handoff", reason: "unavailable", expectedArtifacts: [] });
  await acknowledgeNativeInitHandoff(brown, { reason: "unavailable" });
  const preserved = await finalizeInitialization(brown);
  assert.equal(await readFile(join(brown, "README.md"), "utf8"), "USER\n");
  assert.deepEqual(preserved.receipt.artifacts.created, []);
  assert.ok(preserved.receipt.artifacts.skipped.some((x) => x.reason === "brownfield"));
});

test("owned state fails closed for partial pairs and symlinked .muster", async () => {
  const partial = await tmp();
  await mkdir(join(partial, ".muster"));
  await writeFile(join(partial, ".muster/project-profile.json"), "{}");
  await assert.rejects(() => initializeProject(partial), /both be absent or present/);

  const target = await tmp();
  const unsafe = await tmp();
  await symlink(target, join(unsafe, ".muster"), "dir");
  await assert.rejects(() => initializeProject(unsafe), /symlink/);
});

test("readInitReceipt rejects a foreign schema", async () => {
  const dir = await tmp();
  await initializeProject(dir);
  await writeFile(join(dir, ".muster/init-receipt.json"), '{"format":"foreign"}\n');
  await assert.rejects(() => readInitReceipt(dir), /invalid init receipt/);
});

test("completion evidence rejects duplicate JSON keys", async () => {
  const dir = await tmp();
  await initializeProject(dir);
  await transitionNativeInit(dir, { to: "attempted", expectedArtifacts: ["CLAUDE.md"] });
  await writeFile(join(dir, "CLAUDE.md"), "# Native\n");
  await writeFile(
    join(dir, "result.json"),
    '{"artifacts":["CLAUDE.md"],"format":"muster.native-init-result","ok":false,"ok":true,"operation":"native-init","schemaVersion":1}\n',
  );
  await assert.rejects(
    () => transitionNativeInit(dir, {
      to: "completed", evidenceKind: "call-result", evidenceFile: "result.json",
    }),
    /duplicate keys/,
  );
});

test("persisted receipt rows must remain sorted by UTF-8 path order", async () => {
  const dir = await tmp();
  await writeFile(join(dir, "existing.txt"), "user\n");
  await initializeProject(dir);
  await transitionNativeInit(dir, { to: "handoff", reason: "unavailable", expectedArtifacts: [] });
  await acknowledgeNativeInitHandoff(dir, { reason: "unavailable" });
  await finalizeInitialization(dir);
  const receiptPath = join(dir, ".muster/init-receipt.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.artifacts.skipped.reverse();
  await writeFile(receiptPath, JSON.stringify(receipt));
  await assert.rejects(() => readInitReceipt(dir), /invalid init receipt/);
});

test("persisted receipt cannot claim completed without positive evidence", async () => {
  const dir = await tmp();
  await initializeProject(dir);
  const receiptPath = join(dir, ".muster/init-receipt.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.nativeInit.state = "completed";
  await writeFile(receiptPath, JSON.stringify(receipt));
  await assert.rejects(() => readInitReceipt(dir), /invalid init receipt/);
});

test("call-result is bound to attempted state, a separate evidence file, and the exact attempt id", async () => {
  const handoff = await tmp();
  await initializeProject(handoff);
  const handed = await transitionNativeInit(handoff, {
    to: "handoff", reason: "not-callable", expectedArtifacts: ["AGENTS.md"],
  });
  await writeFile(join(handoff, "AGENTS.md"), "# Native\n");
  await writeFile(join(handoff, "result.json"), canonicalInitJson({
    artifacts: ["AGENTS.md"], attemptId: handed.receipt.nativeInit.attemptId,
    format: "muster.native-init-result", ok: true, operation: "native-init", schemaVersion: 1,
  }) + "\n");
  await assert.rejects(
    () => transitionNativeInit(handoff, {
      to: "completed", evidenceKind: "call-result", evidenceFile: "result.json",
    }),
    /attempted/,
  );

  const attempted = await tmp();
  await initializeProject(attempted);
  const pending = await transitionNativeInit(attempted, {
    to: "attempted", expectedArtifacts: ["AGENTS.md"],
  });
  const result = {
    artifacts: ["AGENTS.md"], attemptId: pending.receipt.nativeInit.attemptId,
    format: "muster.native-init-result", ok: true, operation: "native-init", schemaVersion: 1,
  };
  await writeFile(join(attempted, "AGENTS.md"), canonicalInitJson(result) + "\n");
  await assert.rejects(
    () => transitionNativeInit(attempted, {
      to: "completed", evidenceKind: "call-result", evidenceFile: "AGENTS.md",
    }),
    /must not be an expected artifact/,
  );
  await writeFile(join(attempted, "result.json"), canonicalInitJson({
    ...result, attemptId: "0".repeat(64),
  }) + "\n");
  await assert.rejects(
    () => transitionNativeInit(attempted, {
      to: "completed", evidenceKind: "call-result", evidenceFile: "result.json",
    }),
    /attempt id/,
  );
});

test("FIFO owned targets fail promptly instead of blocking on open", async () => {
  const dir = await tmp();
  await mkdir(join(dir, ".muster"));
  await pexecFile("mkfifo", [join(dir, ".muster/project-profile.json")]);
  await assert.rejects(
    () => pexecFile(
      process.execPath,
      [new URL("../src/cli.js", import.meta.url).pathname, "init", dir],
      { timeout: 1_000 },
    ),
    (error) => {
      assert.notEqual(error.killed, true, "FIFO read must fail before the child timeout");
      assert.match(error.stderr, /unsafe regular file/);
      return true;
    },
  );
});

test("learning cap counts all encountered regular files, not only manifests", async () => {
  const dir = await tmp();
  for (let index = 0; index < 128; index++) {
    await writeFile(join(dir, `irrelevant-${String(index).padStart(3, "0")}.txt`), "");
  }
  await writeFile(join(dir, "package.json"), "{}");
  await assert.rejects(() => learnProjectProfile(dir), /project learning limit exceeded/);
});
