import { lstat, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";

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
const SUPPORTED_HOSTS = new Set(["chatgpt-work", "codex-desktop"]);

function boundedPositiveInteger(value, fallback, hardMaximum, label) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > hardMaximum) {
    throw new TypeError(`${label} must be a positive safe integer no greater than ${hardMaximum}`);
  }
  return resolved;
}

function skillDescription(markdown) {
  const frontmatter = matchFrontmatter(markdown);
  if (!frontmatter) return "";
  const line = frontmatter.body.split(/\r?\n/).find(value => /^description:/.test(value));
  if (!line) return "";
  const value = line.slice("description:".length).trim();
  if (
    value.length >= 2
    && (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    )
  ) {
    return value.slice(1, -1);
  }
  return value;
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

async function readBoundedText(path, maxBytes, label) {
  try {
    const { bytes } = await readNoFollowRegular(path, { maxBytes, label });
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
    const skillMd = await resolveContainedRealpath(skillRoot, join(skillRoot, "SKILL.md"));
    if (!skillMd || !isContainedLexical(skillRoot, skillMd)) continue;
    let markdown;
    try {
      markdown = await readBoundedText(skillMd, maxResourceBytes, `skill ${entry.name} SKILL.md`);
    } catch {
      continue;
    }
    discovered.push({
      id: entry.name,
      description: skillDescription(markdown),
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
      const target = await resolveContainedRealpath(
        selected.skillRoot,
        join(selected.skillRoot, relativePath),
      );
      if (!target || !isContainedLexical(selected.skillRoot, target)) {
        throw new Error("executor skill resource must resolve inside its skill root");
      }
      return readBoundedText(
        target,
        bounds.maxResourceBytes,
        `skill ${skill} resource ${relativePath}`,
      );
    },
  });
}

export async function executorSkillsActivation({ host, capabilityRoot, authority } = {}) {
  const inactive = { active: false, reason: "active-host-authority-not-demonstrated" };
  if (!SUPPORTED_HOSTS.has(host) || !authority || authority.demonstrated !== true) return inactive;
  if (
    authority.contract !== EXECUTOR_SKILLS_CONTRACT.version
    || authority.activeHost !== host
    || authority.source !== "active-host-executor"
    || !Array.isArray(authority.methods)
    || authority.methods.length !== EXECUTOR_SKILLS_CONTRACT.methods.length
    || authority.methods.some((method, index) => method !== EXECUTOR_SKILLS_CONTRACT.methods[index])
  ) {
    return inactive;
  }
  let expectedRoot;
  let observedRoot;
  try {
    expectedRoot = await realpath(capabilityRoot);
    observedRoot = await realpath(authority.capabilityRoot);
  } catch {
    return inactive;
  }
  if (expectedRoot !== observedRoot) return inactive;
  return { active: true, reason: "active-host-demonstrated" };
}
