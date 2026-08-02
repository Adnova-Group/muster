import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { link, mkdir, open, readFile, rm, stat, symlink, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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
const CLAUDE_POINTER = "# Claude Code\n\n@AGENTS.md\n";
const readProfile = async (dir) => JSON.parse(await readFile(join(dir, ".muster/project-profile.json"), "utf8"));

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

test("paired instruction artifact-delta requires the canonical authority pair", async () => {
  const cases = [
    { name: "neither", agents: null, claude: null, ok: false },
    { name: "AGENTS only", agents: "# Policy\n", claude: null, ok: false },
    { name: "CLAUDE only", agents: null, claude: CLAUDE_POINTER, ok: false },
    { name: "conflicting CLAUDE", agents: "# Policy\n", claude: "# Independent\n", ok: false },
    { name: "policy then reverse import", agents: "# Policy\n\n  @CLAUDE.md\n", claude: CLAUDE_POINTER, ok: false },
    { name: "reverse import then policy", agents: "@./CLAUDE.md\n\n# Policy\n", claude: CLAUDE_POINTER, ok: false },
    { name: "inline reverse import", agents: "Use @CLAUDE.md for the rest.\n", claude: CLAUDE_POINTER, ok: false },
    { name: "normalized relative reverse import", agents: "Use @docs/../CLAUDE.md for the rest.\n", claude: CLAUDE_POINTER, ok: false },
    {
      name: "normalized absolute reverse import",
      agents: (dir) => `Use @${join(dir, "docs", "..", "CLAUDE.md")} for the rest.\n`,
      claude: CLAUDE_POINTER,
      ok: false,
    },
    { name: "canonical pair", agents: "# Policy\n", claude: CLAUDE_POINTER, ok: true },
  ];

  for (const fixture of cases) {
    const dir = await tmp();
    await initializeProject(dir);
    await transitionNativeInit(dir, {
      to: "handoff", reason: "not-callable", expectedArtifacts: ["AGENTS.md", "CLAUDE.md"],
    });
    if (fixture.agents !== null) {
      const agents = typeof fixture.agents === "function" ? fixture.agents(dir) : fixture.agents;
      await writeFile(join(dir, "AGENTS.md"), agents);
    }
    if (fixture.claude !== null) await writeFile(join(dir, "CLAUDE.md"), fixture.claude);
    const completion = transitionNativeInit(dir, { to: "completed", evidenceKind: "artifact-delta" });
    if (fixture.ok) {
      await completion;
      await writeFile(join(dir, "CLAUDE.md"), "# Independent\n");
      await assert.rejects(() => readInitReceipt(dir), /canonical instruction authority pair/);
    } else {
      await assert.rejects(completion, /canonical instruction authority pair/, fixture.name);
    }
  }
});

test("paired pre-existing confirmation requires both canonical instruction artifacts", async () => {
  const cases = [
    { name: "partial", agents: "# Policy\n", claude: null, artifacts: ["AGENTS.md"], ok: false },
    { name: "conflict", agents: "# Policy\n", claude: "# Independent\n", artifacts: ["AGENTS.md", "CLAUDE.md"], ok: false },
    { name: "canonical", agents: "# Policy\n", claude: CLAUDE_POINTER, artifacts: ["AGENTS.md", "CLAUDE.md"], ok: true },
  ];

  for (const fixture of cases) {
    const dir = await tmp();
    await writeFile(join(dir, "AGENTS.md"), fixture.agents);
    if (fixture.claude !== null) await writeFile(join(dir, "CLAUDE.md"), fixture.claude);
    await initializeProject(dir);
    await transitionNativeInit(dir, {
      to: "handoff", reason: "instruction-present", expectedArtifacts: ["AGENTS.md", "CLAUDE.md"],
    });
    await writeFile(join(dir, "confirmation.json"), canonicalInitJson({
      artifacts: fixture.artifacts,
      confirmation: "already-initialized",
      format: "muster.native-init-confirmation",
      schemaVersion: 1,
    }) + "\n");
    const completion = transitionNativeInit(dir, {
      to: "completed", evidenceKind: "preexisting-confirmed", evidenceFile: "confirmation.json",
    });
    if (fixture.ok) await completion;
    else await assert.rejects(completion, /canonical instruction authority pair/, fixture.name);
  }
});

test("paired call-result requires both canonical instruction artifacts", async () => {
  const cases = [
    { name: "partial", agents: "# Policy\n", claude: null, artifacts: ["AGENTS.md"], ok: false },
    { name: "conflict", agents: "# Policy\n", claude: "# Independent\n", artifacts: ["AGENTS.md", "CLAUDE.md"], ok: false },
    { name: "canonical", agents: "# Policy\n", claude: CLAUDE_POINTER, artifacts: ["AGENTS.md", "CLAUDE.md"], ok: true },
  ];

  for (const fixture of cases) {
    const dir = await tmp();
    await initializeProject(dir);
    const attempted = await transitionNativeInit(dir, {
      to: "attempted", expectedArtifacts: ["AGENTS.md", "CLAUDE.md"],
    });
    await writeFile(join(dir, "AGENTS.md"), fixture.agents);
    if (fixture.claude !== null) await writeFile(join(dir, "CLAUDE.md"), fixture.claude);
    await writeFile(join(dir, "result.json"), canonicalInitJson({
      artifacts: fixture.artifacts,
      attemptId: attempted.receipt.nativeInit.attemptId,
      format: "muster.native-init-result",
      ok: true,
      operation: "native-init",
      schemaVersion: 1,
    }) + "\n");
    const completion = transitionNativeInit(dir, {
      to: "completed", evidenceKind: "call-result", evidenceFile: "result.json",
    });
    if (fixture.ok) await completion;
    else await assert.rejects(completion, /canonical instruction authority pair/, fixture.name);
  }
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

test("project learning succeeds with 248 ordinary files and preserves accurate profile facts", async () => {
  const dir = await tmp();
  await Promise.all(Array.from({ length: 248 }, (_, index) => writeFile(
    join(dir, `ordinary-${String(index).padStart(3, "0")}.txt`), "",
  )));
  await writeFile(join(dir, "package.json"), '{"scripts":{"test":"node --test"},"dependencies":{"express":"1"}}');
  const profile = await learnProjectProfile(dir);
  assert.equal(profile.classification, "brownfield");
  assert.deepEqual(profile.facts.languages, ["javascript"]);
  assert.deepEqual(profile.facts.frameworks, ["express"]);
  assert.deepEqual(profile.facts.packageManagers, ["npm"]);
  assert.deepEqual(profile.facts.testRunners, ["node --test"]);
  assert.deepEqual(profile.facts.manifests.map(({ path }) => path), ["package.json"]);
});

test("repository fingerprints stream relevant files without repository-size ceilings", async () => {
  const dir = await tmp();
  await pexecFile("git", ["init", "--quiet"], { cwd: dir });
  await writeFile(join(dir, ".gitignore"), "generated/\nignored-link\n");
  await writeFile(join(dir, "tracked.txt"), "before\n");
  await pexecFile("git", ["add", ".gitignore", "tracked.txt"], { cwd: dir });
  await symlink("a".repeat(4_095), join(dir, "ignored-link"));

  const generated = join(dir, "generated");
  await mkdir(generated);
  for (let offset = 0; offset < 10_001; offset += 250) {
    await Promise.all(Array.from({ length: Math.min(250, 10_001 - offset) }, (_, index) =>
      writeFile(join(generated, `entry-${offset + index}`), "")));
  }

  const largeFiles = Array.from({ length: 8 }, (_, index) => join(dir, `large-${index}.bin`));
  for (const path of largeFiles) {
    await writeFile(path, "");
    await truncate(path, 16 * 1024 * 1024 + 1);
  }

  const initialized = await initializeProject(dir);
  const before = initialized.receipt.finalStateFingerprint.digest;
  await writeFile(join(dir, "tracked.txt"), "after\n");
  const changed = (await learnProjectProfile(dir)).repositoryFingerprint.digest;
  assert.notEqual(changed, before, "changing one tracked file must change the digest");

  await transitionNativeInit(dir, { to: "handoff", reason: "unavailable", expectedArtifacts: [] });
  await acknowledgeNativeInitHandoff(dir, { reason: "unavailable" });
  const finalized = await finalizeInitialization(dir);
  assert.equal(finalized.receipt.phase, "finalized");
});

test("repository fingerprints still reject relevant special files", async () => {
  const dir = await tmp();
  await pexecFile("git", ["init", "--quiet"], { cwd: dir });
  await pexecFile("mkfifo", [join(dir, "unsafe.pipe")]);
  await assert.rejects(
    () => learnProjectProfile(dir),
    /unsupported repository entry type: unsafe\.pipe/,
  );
});

test("repository fingerprints reject tracked files reached through a symlinked ancestor", async () => {
  const dir = await tmp();
  const outside = await tmp();
  await pexecFile("git", ["init", "--quiet"], { cwd: dir });
  await mkdir(join(dir, "tracked"));
  await writeFile(join(dir, "tracked", "file.txt"), "inside\n");
  await pexecFile("git", ["add", "tracked/file.txt"], { cwd: dir });
  await rm(join(dir, "tracked"), { recursive: true });
  await writeFile(join(outside, "file.txt"), "outside\n");
  await symlink(outside, join(dir, "tracked"));

  await assert.rejects(
    () => learnProjectProfile(dir),
    /unsafe ancestor for tracked\/file\.txt/,
  );
});

test("repository fingerprints reject same-size in-place writes during a streamed read", async () => {
  const dir = await tmp();
  const target = join(dir, "changing.bin");
  await writeFile(target, Buffer.alloc(16 * 1024 * 1024, 0x61));
  const handle = await open(target, "r+");
  const block = Buffer.alloc(64 * 1024, 0x62);
  let stop = false;
  const writer = (async () => {
    let position = 0;
    while (!stop) {
      await handle.write(block, 0, block.length, position);
      position = (position + block.length) % (16 * 1024 * 1024);
    }
  })();
  try {
    await assert.rejects(
      () => learnProjectProfile(dir),
      /file changed while reading: changing\.bin/,
    );
  } finally {
    stop = true;
    await writer;
    await handle.close();
  }
});

test("project learning records large metadata without treating storage size as a parse budget", async () => {
  const lockRoot = await tmp();
  await writeFile(join(lockRoot, "package-lock.json"), Buffer.alloc(2 * 1024 * 1024, 0x61));
  const initialized = await initializeProject(lockRoot);
  const lockProfile = await readProfile(lockRoot);
  assert.equal(lockProfile.facts.manifests[0].bytes, 2 * 1024 * 1024);
  assert.deepEqual(lockProfile.facts.learning, { limitations: [], status: "complete" });
  assert.deepEqual(await initializeProject(lockRoot), initialized);

  const aggregate = await tmp();
  const manifests = [
    "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "Cargo.toml",
    "Cargo.lock", "pyproject.toml", "requirements.txt", "go.mod", "Gemfile",
  ];
  await Promise.all(manifests.map((name) => writeFile(join(aggregate, name), Buffer.alloc(900_000, 0x61))));
  const aggregateInit = await initializeProject(aggregate);
  const aggregateProfile = await readProfile(aggregate);
  assert.ok(aggregateProfile.facts.manifests.reduce((sum, row) => sum + row.bytes, 0) > 8 * 1024 * 1024);
  assert.deepEqual(aggregateProfile.facts.learning, { limitations: [], status: "complete" });
  assert.deepEqual(await initializeProject(aggregate), aggregateInit);
});

test("project learning reports bounded parsing and depth as explicit incomplete evidence", async () => {
  const oversizedPackage = await tmp();
  await writeFile(join(oversizedPackage, "package.json"), Buffer.alloc(2 * 1024 * 1024, 0x61));
  const parseInit = await initializeProject(oversizedPackage);
  assert.deepEqual((await readProfile(oversizedPackage)).facts.learning, {
    limitations: [{ path: "package.json", reason: "parse-limit" }],
    status: "incomplete",
  });
  assert.deepEqual(await initializeProject(oversizedPackage), parseInit);

  const deep = await tmp();
  const deepDir = join(deep, "one", "two", "three", "four", "five");
  await mkdir(deepDir, { recursive: true });
  await writeFile(join(deepDir, "package.json"), "{}");
  const depthInit = await initializeProject(deep);
  assert.deepEqual((await readProfile(deep)).facts.learning, {
    limitations: [{ path: "one/two/three/four/five", reason: "depth-limit" }],
    status: "incomplete",
  });
  assert.deepEqual(await initializeProject(deep), depthInit);
});

test("project learning accepts contained metadata paths longer than owned-artifact paths", async () => {
  const dir = await tmp();
  const parts = ["a".repeat(100), "b".repeat(100), "c".repeat(90)];
  const parent = join(dir, ...parts);
  await mkdir(parent, { recursive: true });
  await writeFile(join(parent, "Cargo.toml"), "[package]\n");
  const initialized = await initializeProject(dir);
  const profile = await readProfile(dir);
  const path = profile.facts.manifests[0].path;
  assert.ok(Buffer.byteLength(path) >= 300);
  assert.deepEqual(profile.facts.learning, { limitations: [], status: "complete" });
  assert.deepEqual(await initializeProject(dir), initialized);
});

test("project learning bounds generated evidence so high-cardinality profiles reread", async () => {
  const dir = await tmp();
  const metadata = [
    "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb",
    "Cargo.toml", "Cargo.lock", "pyproject.toml", "requirements.txt", "go.mod", "Gemfile",
    "AGENTS.md", "CLAUDE.md", "GEMINI.md",
  ];
  for (let offset = 0; offset < 600; offset += 20) {
    await Promise.all(Array.from({ length: 20 }, async (_, index) => {
      const id = String(offset + index).padStart(3, "0");
      const parent = join(dir, `${id}-${"x".repeat(246)}`);
      await mkdir(parent);
      await Promise.all(metadata.map((name) => writeFile(join(parent, name), name === "package.json" ? "{}" : "")));
    }));
  }
  const initialized = await initializeProject(dir);
  const profile = await readProfile(dir);
  assert.equal(profile.facts.learning.status, "incomplete");
  assert.ok(profile.facts.learning.limitations.some(({ reason }) => reason === "profile-limit"));
  assert.ok((await stat(join(dir, ".muster/project-profile.json"))).size <= 1_048_576);
  assert.deepEqual(await initializeProject(dir), initialized);
});

// --- TOCTOU translation arm (audit 2 slice J) ------------------------------
// learnFacts passes the walk's own lstat to the streaming metadata reader; a
// same-user writer replacing the target mid-read trips its "changed" reason
// through post-read identity checks on both the held descriptor and its name.
// The rejection must surface with the exact tagged diagnostic below.
test("learnProjectProfile: a manifest swapped mid-read rejects with the changed-while-reading diagnostic", async () => {
  const dir = await tmp();
  // Stagings live OUTSIDE the walked root (same tmp filesystem, so the
  // hardlinks work): repositoryFingerprint (init.js:332) walks EVERY root
  // entry, so in-root stagings would be raced too and could throw first.
  const stagingDir = await tmp();
  // Big (valid-JSON) manifest so the guarded read spans many swap cycles; the
  // learning read cap (INIT_LIMITS.learnFileBytes) is 1 MiB.
  const big = `{"scripts":{"test":"node --test"},"_filler":"${"a".repeat(800_000)}"}`;
  const stagingA = join(stagingDir, "staging-a.json"), stagingB = join(stagingDir, "staging-b.json");
  await writeFile(stagingA, big);
  await writeFile(stagingB, big);
  const target = join(dir, "package.json");
  await link(stagingA, target);
  // Continuously replace the target between the walk's lstat and the guarded
  // read: unlink drops the held inode's nlink mid-read, the alternating relink
  // swaps which inode the name resolves to, and the 1ms dwell keeps the name
  // resolving (without it the target is absent at open too often).
  let stop = false;
  const swapper = (async () => {
    const stagings = [stagingA, stagingB];
    for (let i = 0; !stop; i++) {
      await unlink(target).catch(() => {});
      await link(stagings[i % 2], target).catch(() => {});
      await sleep(1);
    }
  })();
  try {
    let changed = null;
    for (let attempt = 0; attempt < 12 && changed === null; attempt++) {
      try {
        await learnProjectProfile(dir); // a miss reads clean -- retry
      } catch (error) {
        // A benign ENOENT (open landing in the unlinked gap) is a miss too.
        if (error?.fsSafe?.reason === "changed") changed = error;
      }
    }
    assert.ok(changed, "the changed-while-reading rejection must surface within 12 attempts");
    assert.equal(changed.message, "file changed while reading: package.json");
  } finally {
    stop = true;
    await swapper;
  }
});
