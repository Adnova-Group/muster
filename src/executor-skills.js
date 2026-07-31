import { lstat, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { matchFrontmatter } from "./frontmatter.js";
import {
  isContainedLexical,
  readNoFollowRegular,
  resolveContainedRealpath,
  safeRelativePath,
} from "./fs-safe.js";

export const EXECUTOR_SKILLS_CONTRACT = Object.freeze({
  version: "muster.executor-skills.v1",
  capabilityRoot: "filesystem-resolved Agent Plugin package root",
  methods: Object.freeze(["skills.list", "skills.read"]),
});

const DEFAULT_MAX_SKILLS = 128;
const DEFAULT_MAX_RESOURCE_BYTES = 256 * 1024;
const HARD_MAX_SKILLS = 512;
const HARD_MAX_RESOURCE_BYTES = 1024 * 1024;
const SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function boundedPositiveInteger(value, fallback, hardMaximum, label) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > hardMaximum) {
    throw new TypeError(`${label} must be a positive safe integer no greater than ${hardMaximum}`);
  }
  return resolved;
}

function skillDescription(markdown) {
  const frontmatter = matchFrontmatter(markdown);
  if (!frontmatter) return null;
  try {
    const fields = parseYaml(frontmatter.body, { maxAliasCount: 0 });
    return (
      fields
      && typeof fields === "object"
      && !Array.isArray(fields)
      && typeof fields.name === "string"
      && typeof fields.description === "string"
    ) ? fields : null;
  } catch {
    return null;
  }
}

function validSkillMetadata(markdown, directoryName) {
  const fields = skillDescription(markdown);
  if (!fields) return null;
  const { name, description } = fields;
  if (
    name !== directoryName
    || !SKILL_ID.test(name)
    || Buffer.byteLength(name) > 64
    || typeof description !== "string"
    || description.length < 1
    || Buffer.byteLength(description) > 1024
  ) {
    return null;
  }
  return { name, description };
}

function assertSkillId(id) {
  if (typeof id !== "string" || !SKILL_ID.test(id)) {
    throw new Error(`invalid executor skill id: ${JSON.stringify(id)}`);
  }
  return id;
}

async function resolveCapabilityRoot(capabilityRoot) {
  const root = await realpath(capabilityRoot);
  const skillsRoot = await resolveContainedRealpath(root, join(root, "skills"));
  if (!skillsRoot) throw new Error("executor skills capability root has no contained skills directory");
  const info = await lstat(skillsRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("executor skills capability root has no regular skills directory");
  }
  return { root, skillsRoot };
}

async function readContainedText({
  packageRoot,
  containmentRoot,
  candidate,
  maxBytes,
  label,
}) {
  const canonical = await resolveContainedRealpath(containmentRoot, candidate);
  if (
    !canonical
    || !isContainedLexical(packageRoot, canonical)
    || !isContainedLexical(containmentRoot, canonical)
  ) {
    throw new Error(`${label} must resolve inside its skill root`);
  }
  const before = await lstat(canonical);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
  try {
    const { bytes } = await readNoFollowRegular(canonical, {
      maxBytes,
      label,
      expectedInfo: before,
    });
    const afterCanonical = await realpath(candidate);
    const after = await lstat(afterCanonical);
    if (
      afterCanonical !== canonical
      || !isContainedLexical(packageRoot, afterCanonical)
      || !isContainedLexical(containmentRoot, afterCanonical)
      || after.ino !== before.ino
      || after.dev !== before.dev
      || after.size !== before.size
      || !after.isFile()
      || after.isSymbolicLink()
    ) {
      throw new Error(`file changed while reading: ${label}`);
    }
    return bytes.toString("utf8");
  } catch (error) {
    if (error?.fsSafe?.reason === "too-large") {
      throw new Error(`${label} exceeds the ${maxBytes} byte limit`, { cause: error });
    }
    throw error;
  }
}

async function inventory({ root, skillsRoot, explicitSkills, maxSkills, maxResourceBytes }) {
  const explicit = new Set(explicitSkills.map(assertSkillId));
  if (explicit.size !== explicitSkills.length) {
    throw new Error("explicit executor skill ids must be unique");
  }
  if (explicit.size > maxSkills) {
    throw new Error(`explicit executor skills exceed the ${maxSkills} skill limit`);
  }

  const discovered = [];
  let scanned = 0;
  const maxScannedEntries = maxSkills * 4;
  for await (const entry of await opendir(skillsRoot)) {
    scanned += 1;
    if (scanned > maxScannedEntries) {
      throw new Error(`executor skill discovery exceeds the ${maxScannedEntries} entry scan limit`);
    }
    if (!entry.isDirectory() || !SKILL_ID.test(entry.name)) continue;
    const skillRoot = await resolveContainedRealpath(skillsRoot, join(skillsRoot, entry.name));
    if (!skillRoot || !isContainedLexical(root, skillRoot)) continue;
    let markdown;
    try {
      markdown = await readContainedText({
        packageRoot: root,
        containmentRoot: skillRoot,
        candidate: join(skillRoot, "SKILL.md"),
        maxBytes: maxResourceBytes,
        label: `skill ${entry.name} SKILL.md`,
      });
    } catch {
      continue;
    }
    const metadata = validSkillMetadata(markdown, entry.name);
    if (!metadata) continue;
    discovered.push({
      id: entry.name,
      description: metadata.description,
      activation: explicit.has(entry.name) ? "explicit" : "discoverable",
      path: `skills/${entry.name}/SKILL.md`,
      skillRoot,
    });
    if (discovered.length > maxSkills) {
      throw new Error(`executor skills exceed the ${maxSkills} skill limit`);
    }
  }

  const byId = new Map(discovered.map(skill => [skill.id, skill]));
  for (const id of explicit) {
    if (!byId.has(id)) throw new Error(`explicit executor skill is unavailable: ${id}`);
  }
  return [
    ...explicitSkills.map(id => byId.get(id)),
    ...discovered
      .filter(skill => !explicit.has(skill.id))
      .sort((a, b) => a.id.localeCompare(b.id)),
  ];
}

export async function createExecutorSkillsFixture({
  capabilityRoot,
  explicitSkills = [],
  maxSkills,
  maxResourceBytes,
} = {}) {
  const bounds = {
    maxSkills: boundedPositiveInteger(
      maxSkills,
      DEFAULT_MAX_SKILLS,
      HARD_MAX_SKILLS,
      "maxSkills",
    ),
    maxResourceBytes: boundedPositiveInteger(
      maxResourceBytes,
      DEFAULT_MAX_RESOURCE_BYTES,
      HARD_MAX_RESOURCE_BYTES,
      "maxResourceBytes",
    ),
  };
  const roots = await resolveCapabilityRoot(capabilityRoot);

  async function currentInventory() {
    return inventory({ ...roots, explicitSkills, ...bounds });
  }

  return Object.freeze({
    contract: EXECUTOR_SKILLS_CONTRACT,
    capabilityRoot: roots.root,
    productionActive: false,
    async list() {
      return (await currentInventory()).map(({ skillRoot: _skillRoot, ...skill }) => skill);
    },
    async read({ skill, path } = {}) {
      assertSkillId(skill);
      const relativePath = safeRelativePath(path);
      const selected = (await currentInventory()).find(candidate => candidate.id === skill);
      if (!selected) throw new Error(`executor skill is unavailable: ${skill}`);
      return readContainedText({
        packageRoot: roots.root,
        containmentRoot: selected.skillRoot,
        candidate: join(selected.skillRoot, relativePath),
        maxBytes: bounds.maxResourceBytes,
        label: `executor skill resource`,
      });
    },
  });
}

export async function executorSkillsActivation({ host, capabilityRoot, authority } = {}) {
  // The pilot has no production host adapter, so it has no private attestation
  // channel. A plain object, environment variable, installed file, or external
  // app-server query is forgeable by the caller and cannot activate this lane.
  // When an active-host adapter exists, it must own an unforgeable receipt
  // channel and replace this fail-closed boundary with its verifier.
  void host;
  void capabilityRoot;
  void authority;
  return { active: false, reason: "active-host-authority-not-demonstrated" };
}
