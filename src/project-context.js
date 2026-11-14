// The project's own instruction files and skills, for the build briefs (live run 8: the
// reviewer skipped its "read CLAUDE.md and matching .claude/skills" step and a file breaking a
// documented project policy merged; executors were never told to read project skills at all).
// `muster build-args` records them in build-args.json as `project`, so every executor, fixer and
// reviewer brief names the exact files to read, and a reviewer's PASS must list them as read.
// Deterministic and read-only: no file content enters the args, only paths and each skill's
// one-line description.
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { matchFrontmatter, parseFrontmatterLenient } from "./frontmatter.js";

export const INSTRUCTION_FILES = Object.freeze(["CLAUDE.md", "AGENTS.md", ".claude/CLAUDE.md"]);
export const MAX_PROJECT_SKILLS = 12;
const SKILL_DIR_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_ABOUT = 200;
const MAX_SKILL_BYTES = 256 * 1024;

// A regular file (a symlink is followed) whose real path stays inside the project root.
function containedFile(root, rel) {
  const abs = join(root, rel);
  try {
    if (!statSync(abs).isFile()) return false;
    const real = realpathSync(abs);
    const realRoot = realpathSync(root);
    const r = relative(realRoot, real);
    return r !== "" && !r.startsWith("..") && !r.split(sep).includes("..");
  } catch {
    return false;
  }
}

// One line of plain text: no control characters, collapsed whitespace, capped.
export function oneLine(text, max = MAX_ABOUT) {
  const s = String(text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function skillAbout(abs) {
  try {
    const text = readFileSync(abs, "utf8").slice(0, MAX_SKILL_BYTES);
    const fm = matchFrontmatter(text);
    if (!fm) return "";
    try {
      return oneLine(parseFrontmatterLenient(fm.body, parseYaml).description || "");
    } catch {
      // Not YAML (a folded plain scalar with ": " in it): take the key's raw lines.
      const m = fm.body.match(/^description:[ \t]*(.*(?:\r?\n[ \t]+.*)*)/m);
      return m ? oneLine(m[1].replace(/^["'>|-]+\s*|["']\s*$/g, "")) : "";
    }
  } catch {
    return "";
  }
}

// -> { instructions: ["CLAUDE.md", ...], skills: [{path, about}], omitted? } or null when the
// project has neither. Skills are `.claude/skills/<dir>/SKILL.md`, sorted by directory name and
// capped at MAX_PROJECT_SKILLS (`omitted` counts the rest).
export function projectContext(root) {
  const instructions = INSTRUCTION_FILES.filter((f) => containedFile(root, f));
  const skills = [];
  let dirs = [];
  try {
    const skillsDir = join(root, ".claude", "skills");
    if (lstatSync(join(root, ".claude")).isDirectory() && statSync(skillsDir).isDirectory()) {
      dirs = readdirSync(skillsDir).filter((d) => SKILL_DIR_RE.test(d)).sort();
    }
  } catch {
    dirs = [];
  }
  let found = 0;
  for (const d of dirs) {
    const rel = `.claude/skills/${d}/SKILL.md`;
    if (!containedFile(root, rel)) continue;
    found++;
    if (skills.length < MAX_PROJECT_SKILLS) skills.push({ path: rel, about: skillAbout(join(root, rel)) });
  }
  if (!instructions.length && !skills.length) return null;
  return { instructions, skills, ...(found > skills.length ? { omitted: found - skills.length } : {}) };
}
