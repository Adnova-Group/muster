import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EXECUTOR_SKILLS_CONTRACT,
  createExecutorSkillsFixture,
  executorSkillsActivation,
} from "../src/executor-skills.js";

async function buildPackage() {
  const root = await mkdtemp(join(tmpdir(), "muster-executor-skills-"));
  for (const [name, description] of [
    ["explicit-skill", "Selected explicitly by the dispatcher."],
    ["discoverable-skill", "Found through bounded direct-child discovery."],
  ]) {
    const skill = join(root, "skills", name);
    await mkdir(join(skill, "references"), { recursive: true });
    await writeFile(
      join(skill, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\n\nRead references/proof.txt.\n`,
    );
    await writeFile(join(skill, "references", "proof.txt"), `${name}:package-relative\n`);
  }
  return root;
}

test("contract names the capability root and the exact skills.list/read surface", () => {
  assert.deepEqual(EXECUTOR_SKILLS_CONTRACT, {
    version: "muster.executor-skills.v1",
    capabilityRoot: "filesystem-resolved Agent Plugin package root",
    methods: ["skills.list", "skills.read"],
  });
});

test("bounded local fixture lists explicit and discoverable skills and reads package-relative resources", async () => {
  const capabilityRoot = await buildPackage();
  const fixture = await createExecutorSkillsFixture({
    capabilityRoot,
    explicitSkills: ["explicit-skill"],
  });

  assert.equal(fixture.productionActive, false);
  assert.deepEqual(await fixture.list(), [
    {
      id: "explicit-skill",
      description: "Selected explicitly by the dispatcher.",
      activation: "explicit",
      path: "skills/explicit-skill/SKILL.md",
    },
    {
      id: "discoverable-skill",
      description: "Found through bounded direct-child discovery.",
      activation: "discoverable",
      path: "skills/discoverable-skill/SKILL.md",
    },
  ]);
  assert.equal(
    await fixture.read({ skill: "explicit-skill", path: "references/proof.txt" }),
    "explicit-skill:package-relative\n",
  );
  assert.equal(
    await fixture.read({ skill: "discoverable-skill", path: "SKILL.md" }),
    "---\nname: discoverable-skill\ndescription: Found through bounded direct-child discovery.\n---\n\nRead references/proof.txt.\n",
  );
});

test("discovery skips malformed Agent Skills metadata and mismatched frontmatter names", async () => {
  const capabilityRoot = await buildPackage();
  for (const [name, markdown] of [
    ["missing-frontmatter", "# No metadata\n"],
    ["missing-description", "---\nname: missing-description\n---\n"],
    ["wrong-name", "---\nname: another-name\ndescription: mismatch\n---\n"],
  ]) {
    const skill = join(capabilityRoot, "skills", name);
    await mkdir(skill);
    await writeFile(join(skill, "SKILL.md"), markdown);
  }
  const fixture = await createExecutorSkillsFixture({ capabilityRoot });

  assert.deepEqual(
    (await fixture.list()).map(skill => skill.id),
    ["discoverable-skill", "explicit-skill"],
  );
});

test("fixture rejects traversal, symlink escapes, and reads beyond its byte bound", async () => {
  const capabilityRoot = await buildPackage();
  const outside = await mkdtemp(join(tmpdir(), "muster-executor-skills-outside-"));
  await writeFile(join(outside, "secret.txt"), "outside");
  await symlink(
    join(outside, "secret.txt"),
    join(capabilityRoot, "skills", "explicit-skill", "references", "escape.txt"),
  );
  await writeFile(
    join(capabilityRoot, "skills", "explicit-skill", "references", "large.txt"),
    "x".repeat(257),
  );
  const fixture = await createExecutorSkillsFixture({
    capabilityRoot,
    explicitSkills: ["explicit-skill"],
    maxResourceBytes: 256,
  });

  await assert.rejects(
    fixture.read({ skill: "explicit-skill", path: "../discoverable-skill/SKILL.md" }),
    /safe relative path/,
  );
  await assert.rejects(
    fixture.read({ skill: "explicit-skill", path: "references/escape.txt" }),
    /inside its skill root/,
  );
  await assert.rejects(
    fixture.read({ skill: "explicit-skill", path: "references/large.txt" }),
    /256 byte limit/,
  );
});

test("production activation requires authority demonstrated by the same active host and capability root", async () => {
  const capabilityRoot = await buildPackage();
  const callerFabricatedAuthority = {
    contract: EXECUTOR_SKILLS_CONTRACT.version,
    activeHost: "codex-desktop",
    capabilityRoot,
    methods: [...EXECUTOR_SKILLS_CONTRACT.methods],
    source: "active-host-executor",
    demonstrated: true,
  };

  assert.deepEqual(
    await executorSkillsActivation({
      host: "codex-desktop",
      capabilityRoot,
      authority: callerFabricatedAuthority,
    }),
    { active: false, reason: "active-host-authority-not-demonstrated" },
  );
  assert.deepEqual(
    await executorSkillsActivation({
      host: "chatgpt-work",
      capabilityRoot,
      authority: callerFabricatedAuthority,
    }),
    { active: false, reason: "active-host-authority-not-demonstrated" },
  );
  assert.deepEqual(
    await executorSkillsActivation({
      host: "codex-desktop",
      capabilityRoot,
      authority: { ...callerFabricatedAuthority, capabilityRoot: join(capabilityRoot, "skills") },
    }),
    { active: false, reason: "active-host-authority-not-demonstrated" },
  );
  assert.deepEqual(
    await executorSkillsActivation({
      host: "codex-desktop",
      capabilityRoot,
      authority: null,
    }),
    { active: false, reason: "active-host-authority-not-demonstrated" },
  );
});
