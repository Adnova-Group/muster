// `muster plan-lint <PLAN.md> [--json] [--root <dir>]`: the deterministic plan gates.
//
// gsd runs these as probes before its plan-checker agent sees a plan, and forbids the checker
// from hand-reasoning them ("Do not hand-reason this", gsd-core/references/failing-direction.md).
// This module ports them from gsd-core v1.20.1 (open-gsd/gsd-core@9385f46) to plain JS and
// applies them to muster's single-file PLAN.md (docs/plan-format.md). Ported from:
//   src/verify-command-grounding.cts   failing direction (#3172), verify-command paths (#2401)
//   src/gate-verify-failure-directions.cts, src/gate-verify-command-paths.cts  blocker => block
//   src/plan-document.cts              task grammar, threat-register IDs (#4683)
//   src/verify.cts                     plan-structure: task fields, truncation (#4927),
//                                      checkpoint/autonomous, one-way reversibility (#1951)
//   src/phase.cts                      depends_on resolution, cycle detection, wave levels
//   src/init.cts                       duplicate threat IDs (#4683)
//   agents/gsd-planner.md              tracer-first and same-wave file ownership (prose rules)
//   agents/gsd-plan-checker.md         already-passes-at-HEAD (#4927), narrowed to forms that
//                                      can be evaluated without executing anything
// vendor/manifest.yaml records each source with its base blob.
//
// PLAN.md is untrusted, LLM-authored text. Nothing here executes, spawns or shells out: the
// only I/O is bounded reads (stat / readFile) under the project root. No network.
//
// Output is a CheckResult (docs/strategy/stage-2-contracts.md):
//   { verdict: "PASS" | "ISSUES", issues: [{ dimension, severity, required_property, summary }] }
// Any issue of any severity makes the verdict ISSUES (gsd-plan-checker: "Issues of ANY severity
// -> ISSUES FOUND"); only a blocker makes the CLI exit 1. Exit 2 means "could not look"
// (missing or unreadable file, bad usage) and is never a pass.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { specialistCatalog } from "./specialists.js";
import { matchSkills } from "./match.js";
// spec_traceability (docs/plan-format.md "Planning from a spec"). spec-plan imports spec-lint,
// which imports this module: the cycle is safe because no module in it reads another's
// bindings while loading.
import { lintSpecTraceability } from "./spec-plan.js";

export const SEVERITY = Object.freeze({ BLOCKER: "blocker", WARNING: "warning", INFO: "info" });

export const DIMENSIONS = Object.freeze({
  PLAN_STRUCTURE: "plan_structure",
  TASK_COMPLETENESS: "task_completeness",
  NYQUIST: "nyquist_compliance",
  VERIFY_PATHS: "verify_command_paths",
  VERIFY_SANITY: "verify_command_sanity",
  DEPENDENCIES: "dependency_correctness",
  TRACER: "tracer_first",
  REVERSIBILITY: "reversibility",
  THREAT_MODEL: "threat_model",
  SPEC_TRACEABILITY: "spec_traceability",
});

export const REQUIRED_FRONTMATTER = Object.freeze(["run", "type", "autonomous", "must_haves"]);
export const KNOWN_TASK_TYPES = Object.freeze(["auto", "tracer", "tdd"]);
export const REVERSIBILITY_RATINGS = Object.freeze(["reversible", "costly", "one-way"]);
export const MAX_PLAN_BYTES = 2 * 1024 * 1024;

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AGENT_HINT_RE = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;
const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// A preflight skill candidate "scored highly" at this score (an id-token hit plus one more);
// it must also match the task's own text before a skill-less task is flagged.
export const HIGH_SKILL_SCORE = 4;

// ─── Text helpers ─────────────────────────────────────────────────────────────

/**
 * XML entities -> characters (gsd #4730/#3611): planners escape `&&` as `&amp;&amp;` inside
 * XML-ish tags, and `>`/`<` redirects as `&gt;`/`&lt;` (live e2e 2026-11-10: a verify command
 * reached build-args.json as `printf ... &gt; "$D/e.csv"`, which no shell runs as a redirect).
 * `&amp;` goes last so `&amp;gt;` decodes once, to the literal text `&gt;`.
 */
export function decodeEntityAmps(s) {
  return String(s)
    .replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Blank every fenced code block (``` or ~~~), keeping line count so offsets stay comparable.
 * A plan that QUOTES a task or register must not have the quote read as live plan content
 * (gsd plan-document.cts extractThreatRegisterIds, #4683 review MAJOR). gsd applies this to the
 * threat register only; muster applies it to every gate, since the format is new and has no
 * fence-blind consumers to stay compatible with. An unclosed fence blanks to end of document,
 * as gsd does; `unclosedFence` lets the structure gate say so instead of reporting "no tasks".
 */
export function blankFencedBlocks(text) {
  const lines = String(text).split(/\r?\n/);
  let inFence = false;
  const out = lines.map(line => {
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; return ""; }
    return inFence ? "" : line;
  });
  return { text: out.join("\n"), unclosedFence: inFence };
}

/**
 * Closing tags with no opener anywhere in the (fence-blanked) body: `</output>` after
 * `</success_criteria>` and the like. Inline code spans are ignored, so prose that names a tag in
 * backticks is not counted. Only a close with zero openers is reported: a stray tag misleads an
 * executor about where the plan ends, while an unmatched opener in prose is harmless.
 * Live e2e 2026-11-10: the checker reported a stray `</output>` that the file never contained
 * (tool-output framing); this is the deterministic check it defers to.
 */
export function strayClosingTags(body) {
  const lines = String(body ?? "").split("\n").map(l => l.replace(/`[^`\n]*`/g, ""));
  const opens = new Map();
  const closes = new Map();
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/<([A-Za-z][\w-]{0,63})(?:\s[^<>]{0,1000})?>/g)) {
      if (m[0].endsWith("/>")) continue;
      const tag = m[1].toLowerCase();
      opens.set(tag, (opens.get(tag) || 0) + 1);
    }
    for (const m of line.matchAll(/<\/([A-Za-z][\w-]{0,63})\s*>/g)) {
      const tag = m[1].toLowerCase();
      if (!closes.has(tag)) closes.set(tag, i + 1);
    }
  });
  return [...closes].filter(([tag]) => !opens.has(tag)).map(([tag, line]) => ({ tag, line }));
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** gsd markdown-sectionizer.cts taggedBlockPattern: ReDoS-safe, the body stops at the next opener. */
function taggedBlockPattern(tag, flags, allowAttributes) {
  const esc = escapeRegex(tag);
  const open = allowAttributes ? `<${esc}(?:\\s[^>]{0,1000})?>` : `<${esc}>`;
  const boundary = allowAttributes ? `<${esc}[\\s>]` : `<${esc}>`;
  return new RegExp(`${open}((?:(?!${boundary})[\\s\\S])*?)</${esc}>`, flags);
}

export function extractTaggedBlocks(content, tag, allowAttributes = false) {
  if (typeof content !== "string" || content.length === 0) return [];
  return [...content.matchAll(taggedBlockPattern(tag, "g", allowAttributes))].map(m => m[1]);
}

export function stripTaggedBlocks(content, tag, allowAttributes = false) {
  if (typeof content !== "string" || content.length === 0) return "";
  return content.replace(taggedBlockPattern(tag, "gi", allowAttributes), "");
}

/** Body of the first `<tag ...>...</tag>` in `block` (attribute-tolerant), or null. */
function elementBody(block, tag) {
  const m = new RegExp(`<${tag}(?:\\s[^>]{0,500})?>([\\s\\S]*?)</${tag}\\s*>`, "i").exec(block);
  return m ? m[1] : null;
}

/** One attribute of an opening tag (gsd plan-document.cts tagAttribute); empty values are null. */
function tagAttribute(openTag, attr) {
  const re = new RegExp(`(?:^|\\s)${escapeRegex(attr)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
  const m = re.exec(openTag);
  if (!m) return null;
  const value = (m[1] ?? m[2] ?? "").trim();
  return value.length > 0 ? value : null;
}

function collapseWhitespace(value) {
  if (value === null) return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** `<files>` body -> paths. Comma- or newline-separated (gsd splitFileList); backticks dropped. */
function splitFileList(body) {
  if (body === null) return [];
  return body.split(/[,\n]/).map(p => p.trim().replace(/^`|`$/g, "").trim()).filter(Boolean);
}

function normalizePlanPath(p) {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function splitList(value) {
  if (value === null || value === undefined) return [];
  return String(value).split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
}

// ─── Plan document ───────────────────────────────────────────────────────────

const FRONTMATTER_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Parse a muster PLAN.md. Never throws. Task grammar follows gsd plan-document.cts
 * parseXmlTasks: one row per `<task ...>` opener, the block bounded by its `</task>` or the next
 * opener (so an unclosed block cannot swallow its siblings), checkpoint tasks distinguished by
 * `type="checkpoint:*"`. Children are detected with gsd verify.cts's `/<tag[\s>]/` test, so
 * `<verify>` never satisfies `<verification>`.
 */
export function parsePlan(rawText) {
  const text = String(rawText ?? "").replace(/\r\n/g, "\n");
  const fm = FRONTMATTER_RE.exec(text);
  let frontmatter = null;
  let frontmatterError = null;
  if (fm) {
    try {
      const parsed = parseYaml(fm[1]);
      frontmatter = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      frontmatterError = error.message.split("\n")[0];
    }
  }
  const bodyStart = fm ? fm[0].length : 0;
  const { text: blanked, unclosedFence } = blankFencedBlocks(text);
  const body = blanked.slice(bodyStart);

  const openings = [...body.matchAll(/<task(?=[\s>])[^>]{0,1000}>/gi)];
  const tasks = openings.map((match, i) => {
    const start = match.index;
    const openTag = match[0];
    const nextStart = i + 1 < openings.length ? openings[i + 1].index : body.length;
    const windowText = body.slice(start, nextStart);
    const closeMatch = /<\/task\s*>/i.exec(windowText);
    const closeIdx = closeMatch ? closeMatch.index : -1;
    const block = closeIdx === -1 ? windowText : windowText.slice(0, closeIdx);
    const end = closeMatch ? start + closeIdx + closeMatch[0].length : nextStart;
    const type = tagAttribute(openTag, "type");
    const kind = type !== null && type.toLowerCase().startsWith("checkpoint") ? "checkpoint" : "auto";
    const waveRaw = tagAttribute(openTag, "wave");
    const autoSelectMatch = openTag.match(/(?:^|\s)auto_select\s*=\s*["']([^"']*)["']/);
    const optionsBody = elementBody(block, "options");
    const reversibility = /<reversibility[\s>]/i.test(block)
      ? { rating: (block.match(/<reversibility\s[^>]*rating\s*=\s*["']?([\w-]+)/i) || [])[1] ?? null }
      : null;
    return {
      index: i + 1,
      offset: start,
      end,
      openTag,
      closed: closeIdx !== -1,
      block,
      id: tagAttribute(openTag, "id"),
      type: type === null ? null : type.toLowerCase(),
      kind,
      waveRaw,
      wave: waveRaw !== null && /^\d+$/.test(waveRaw) ? Number(waveRaw) : null,
      dependsOn: splitList(tagAttribute(openTag, "depends_on")),
      agentHint: tagAttribute(openTag, "agent_hint"),
      skills: splitList(tagAttribute(openTag, "skills")),
      skillsDeclared: /(?:^|\s)skills\s*=\s*["']/i.test(openTag),
      tdd: tagAttribute(openTag, "tdd"),
      covers: splitList(tagAttribute(openTag, "covers")),
      name: collapseWhitespace(elementBody(block, "name")),
      hasName: /<name[\s>]/i.test(block),
      files: splitFileList(elementBody(block, "files")),
      hasFiles: /<files[\s>]/i.test(block),
      hasAction: /<action[\s>]/i.test(block),
      hasVerify: /<verify[\s>]/i.test(block),
      hasDone: /<done[\s>]/i.test(block),
      hasWhatBuilt: /<what-built[\s>]/i.test(block),
      hasHowToVerify: /<how-to-verify[\s>]/i.test(block),
      hasDecision: /<decision[\s>]/i.test(block),
      hasOptions: /<options[\s>]/i.test(block),
      hasInstructions: /<instructions[\s>]/i.test(block),
      hasVerification: /<verification[\s>]/i.test(block),
      hasResumeSignal: /<resume-signal[\s>]/i.test(block),
      autoSelect: autoSelectMatch ? autoSelectMatch[1] : null,
      optionIds: optionsBody === null ? [] : [...optionsBody.matchAll(/<option(\s[^>]{0,500})?>/g)]
        .map(m => ((m[1] ?? "").match(/(?:^|\s)id\s*=\s*["']([^"']{1,200})["']/) || [])[1])
        .filter(Boolean),
      reversibility,
      verifyBody: elementBody(block, "verify"),
      // `<automated proves="REF-01.2 INV-01">`: the spec IDs a verify command proves.
      proves: [...block.matchAll(/<automated(\s[^>]{0,200})?>/gi)].flatMap(m => splitList(tagAttribute(m[1] ?? "", "proves"))),
    };
  });

  return { text, body, frontmatter, frontmatterPresent: Boolean(fm), frontmatterError, unclosedFence, tasks };
}

// ─── Failing direction (gsd verify-command-grounding.cts, #3172) ─────────────

const MISSING_SENTINEL_RE = /^MISSING(?:\s|$)/;
const AUTOMATED_BLOCK_RE = /<automated[^>]{0,200}>((?:(?!<automated\b)[\s\S])*?)<\/automated>/g;
const VERIFY_TOKEN_RE = /<(automated|fails_when)[^>]{0,200}>((?:(?!<(?:automated|fails_when)\b)[\s\S])*?)<\/\1>/g;
const TASK_NAME_RE = /<name>([\s\S]*?)<\/name>/;
const PLACEHOLDER_STATEMENTS = new Set(["tbd", "todo", "n/a", "na", "none", "unknown", "tba", "?", "-"]);
const MAX_BLOCK_WALK = 20000;

/**
 * Judge one `<automated>` command's stated failing direction. Total; never throws. Order is
 * load-bearing (gsd #3172 review): the MISSING sentinel exemption runs before the statement
 * presence check, and placeholders match the WHOLE value only ("TBD in the output" is prose).
 */
export function resolveFailingDirection(command, statement) {
  const cmd = typeof command === "string" ? command.trim() : "";
  if (cmd === "") {
    return { command: "", statement: typeof statement === "string" ? statement : null, status: "orphan", severity: "warning" };
  }
  if (MISSING_SENTINEL_RE.test(cmd)) {
    return { command: cmd, statement: typeof statement === "string" ? statement.trim() : null, status: "sentinel", severity: "none" };
  }
  if (typeof statement !== "string") return { command: cmd, statement: null, status: "missing", severity: "blocker" };
  const trimmed = statement.trim();
  if (trimmed === "") return { command: cmd, statement, status: "empty", severity: "blocker" };
  if (PLACEHOLDER_STATEMENTS.has(trimmed.toLowerCase())) {
    return { command: cmd, statement: trimmed, status: "placeholder", severity: "blocker" };
  }
  return { command: cmd, statement: trimmed, status: "ok", severity: "none" };
}

/**
 * Within one text unit, bind each `<fails_when>` to the nearest PRECEDING `<automated>`; the
 * first statement after a command binds, a redundant trailing one adds no row, and a statement
 * with no pending command is an orphan row.
 */
function extractFailingFromText(text, task, out, guard) {
  VERIFY_TOKEN_RE.lastIndex = 0;
  let pending = null;
  let bound = false;
  let match;
  while ((match = VERIFY_TOKEN_RE.exec(text)) !== null) {
    const [, kind, body = ""] = match;
    if (kind === "automated") {
      const trimmedCommand = body.trim();
      if (trimmedCommand !== "") {
        const entry = { ...resolveFailingDirection(trimmedCommand, undefined), task };
        out.push(entry);
        pending = entry;
        bound = false;
      }
    } else if (pending === null) {
      out.push({ ...resolveFailingDirection("", body), task });
    } else if (!bound) {
      const resolved = resolveFailingDirection(pending.command, body);
      pending.statement = resolved.statement;
      pending.status = resolved.status;
      pending.severity = resolved.severity;
      bound = true;
    }
    if (match.index === VERIFY_TOKEN_RE.lastIndex) VERIFY_TOKEN_RE.lastIndex += 1;
    guard.n += 1;
    if (guard.n > MAX_BLOCK_WALK) return false;
  }
  return true;
}

/**
 * Every `<automated>`/`<fails_when>` pairing verdict, task bodies first in document order, then
 * the task-stripped remainder (task `""`), so pairing never crosses a task boundary.
 * `task` is the task's `<name>` text, as in gsd.
 */
export function extractFailingDirections(planText) {
  if (typeof planText !== "string" || planText.length === 0) return [];
  const out = [];
  const guard = { n: 0 };
  for (const body of extractTaggedBlocks(planText, "task", true)) {
    const nameMatch = TASK_NAME_RE.exec(body);
    if (!extractFailingFromText(body, nameMatch ? nameMatch[1].trim() : "", out, guard)) return out;
  }
  extractFailingFromText(stripTaggedBlocks(planText, "task", true), "", out, guard);
  return out;
}

/** Every non-empty `<automated>` command, with the owning task `<name>` (gsd extractAutomatedCommands). */
export function extractAutomatedCommands(planText) {
  if (typeof planText !== "string" || planText.length === 0) return [];
  const out = [];
  const guard = { n: 0 };
  const walk = (text, task) => {
    AUTOMATED_BLOCK_RE.lastIndex = 0;
    let m;
    while ((m = AUTOMATED_BLOCK_RE.exec(text)) !== null) {
      const raw = (m[1] ?? "").trim();
      if (raw !== "") out.push({ task, command: raw });
      if (m.index === AUTOMATED_BLOCK_RE.lastIndex) AUTOMATED_BLOCK_RE.lastIndex += 1;
      guard.n += 1;
      if (guard.n > MAX_BLOCK_WALK) return false;
    }
    return true;
  };
  for (const body of extractTaggedBlocks(planText, "task", true)) {
    const nameMatch = TASK_NAME_RE.exec(body);
    if (!walk(body, nameMatch ? nameMatch[1].trim() : "")) return out;
  }
  walk(stripTaggedBlocks(planText, "task", true), "");
  return out;
}

// ─── Verify-command path grounding (gsd verify-command-grounding.cts, #2401) ──

const DYNAMIC_PATH_ANYWHERE_RE = /[$`*?\n]/;
const DYNAMIC_PATH_LEADING_TILDE_RE = /^["']?~/;
const CD_SEGMENT_RE = /^cd\s+(.+)$/;
const PREFIX_FLAG_RE = /(?:^|\s)--prefix(?:=|\s+)("[^"]*"|'[^']*'|\S+)/;
const PREFIX_FLAG_STRIP_RE = /(?:^|\s)--prefix(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)/g;
const NEEDS_NPM_RE = /^(npm|npx|pnpm|yarn|bun)\b/;
const NEEDS_MAKE_RE = /^make\b/;
const NPM_RUN_SCRIPT_RE = /\bnpm\s+run\s+([\w:@./-]+)/;
const MAX_MANIFEST_BYTES = 512 * 1024;

function stripQuotes(s) {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return s.slice(1, -1);
  }
  return s;
}

const toSlash = s => s.replace(/\\/g, "/");

/** Lexical containment (gsd security.cts tryWithinRootLexical): target is root or below it. */
export function withinRootLexical(target, root) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`));
}

function foldCdArgs(args) {
  let acc = "";
  for (const raw of args) {
    acc = acc === "" || path.isAbsolute(toSlash(stripQuotes(raw))) ? raw : `${acc}/${raw}`;
  }
  return acc;
}

function isPureAncestorClimb(rel) {
  if (rel.length === 0) return false;
  const segs = rel.split(/[\\/]/).filter(Boolean);
  return segs.length > 0 && segs.every(s => s === "..");
}

function declaredPathCovers(declaredPaths, norm) {
  if (!Array.isArray(declaredPaths)) return false;
  const target = norm.replace(/^\.\//, "");
  return declaredPaths.some(p => {
    if (typeof p !== "string") return false;
    const dp = toSlash(p).replace(/^\.\//, "");
    return dp === target || dp.startsWith(`${target}/`);
  });
}

function statOrNull(p) {
  try { return statSync(p, { throwIfNoEntry: false }) ?? null; } catch { return null; }
}

function readManifestObject(manifestPath) {
  const st = statOrNull(manifestPath);
  if (!st || st.size > MAX_MANIFEST_BYTES) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Can this `<automated>` command's target directory be grounded? A recognizer, not a shell:
 * exactly two forms are grounded (`cd <literal>` chains and `npm --prefix <literal>`), anything
 * else is not_applicable, and an ungroundable path is a warning, never a blocker. Never executes
 * the command and never throws.
 */
export function resolveVerifyCommandTarget(command, options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  const base = typeof opts.projectRoot === "string" && opts.projectRoot !== "" ? opts.projectRoot : process.cwd();
  const result = {
    command: "", status: "not_applicable", severity: "none", reason: null, form: null,
    rawTarget: null, target: null, manifest: null, script: null, sentinel: false, base,
  };
  if (typeof command !== "string") return result;
  result.command = command;
  const trimmed = decodeEntityAmps(command.trim());
  if (trimmed === "") return result;
  if (MISSING_SENTINEL_RE.test(trimmed)) { result.sentinel = true; return result; }

  const segments = trimmed.split(/&&|\|\||;|\n/).map(s => s.trim()).filter(Boolean);
  const cdArgs = [];
  let i = 0;
  while (i < segments.length) {
    const m = CD_SEGMENT_RE.exec(segments[i]);
    if (!m) break;
    cdArgs.push(m[1].trim());
    i += 1;
  }
  let form;
  let rawTarget;
  let rest;
  if (cdArgs.length > 0) {
    form = "cd";
    rawTarget = foldCdArgs(cdArgs);
    rest = segments.slice(i).join(" && ");
  } else {
    const prefixMatch = PREFIX_FLAG_RE.exec(trimmed);
    if (!prefixMatch) return result;
    form = "prefix";
    rawTarget = prefixMatch[1];
    rest = trimmed;
  }
  result.form = form;
  result.rawTarget = rawTarget;

  if (DYNAMIC_PATH_ANYWHERE_RE.test(rawTarget) || DYNAMIC_PATH_LEADING_TILDE_RE.test(rawTarget)) {
    return { ...result, status: "unresolvable", reason: "dynamic_path", severity: "warning" };
  }

  const norm = toSlash(stripQuotes(rawTarget));
  const isAbs = path.isAbsolute(norm);
  const target = isAbs ? path.normalize(norm) : path.resolve(base, norm);
  result.target = target;

  // An absolute target outside the root, or a bare `..` climb, is ambiguous under worktree
  // isolation (gsd #4767): existence is not evidence, so the filesystem is not consulted.
  if (isAbs ? !withinRootLexical(target, base) : isPureAncestorClimb(path.relative(base, target))) {
    return { ...result, status: "ok", severity: "warning", reason: "outside_root" };
  }

  const st = statOrNull(target);
  if (!st || !st.isDirectory()) {
    return declaredPathCovers(opts.declaredPaths, norm)
      ? { ...result, status: "pending_creation", severity: "none", reason: null }
      : { ...result, status: "broken", reason: "missing_dir", severity: "blocker" };
  }

  const restTrimmed = rest.trim();
  const neededManifest = NEEDS_NPM_RE.test(restTrimmed) ? "package.json" : NEEDS_MAKE_RE.test(restTrimmed) ? "Makefile" : null;
  if (!neededManifest) return { ...result, status: "ok", severity: "none" };

  const manifestPath = path.join(target, neededManifest);
  if (!statOrNull(manifestPath)) {
    return { ...result, status: "broken", reason: "no_manifest", severity: "blocker", expectedManifest: neededManifest };
  }
  result.manifest = neededManifest;
  if (neededManifest === "Makefile") return { ...result, status: "ok", severity: "none" };

  const parsed = readManifestObject(manifestPath);
  if (!parsed) return { ...result, status: "ok", reason: "manifest_unreadable", severity: "warning" };
  const scriptMatch = NPM_RUN_SCRIPT_RE.exec(restTrimmed.replace(PREFIX_FLAG_STRIP_RE, " "));
  if (scriptMatch) {
    result.script = scriptMatch[1];
    const scripts = parsed.scripts;
    const hasScript = scripts !== null && typeof scripts === "object" && !Array.isArray(scripts)
      && Object.prototype.hasOwnProperty.call(scripts, scriptMatch[1]);
    if (!hasScript) return { ...result, status: "ok", reason: "script_missing", severity: "warning" };
  }
  return { ...result, status: "ok", severity: "none" };
}

/** Every `<files>` token across the whole plan (gsd extractDeclaredPaths): paths tasks will create. */
export function extractDeclaredPaths(text) {
  const out = [];
  for (const m of String(text).matchAll(/<files>([\s\S]*?)<\/files>/g)) {
    for (const tok of (m[1] ?? "").split(/[,\s]+/)) {
      const t = tok.trim().replace(/^`|`$/g, "");
      if (t) out.push(t);
    }
  }
  return out;
}

// ─── Already passes at HEAD (gsd-plan-checker verify-command sanity, #4927) ───
//
// gsd's checker RUNS each read-only count/match gate against the current tree: "It already passes
// at HEAD with no recorded baseline: BLOCKER (it measures nothing)". This port never executes
// plan text. It recognises the plain single-command forms whose result is decidable by reading
// files (`test -f|-e|-d|-s P`, `[ -f P ]`, `grep`/`rg` of a literal pattern in named files) and
// evaluates them in JS. Anything else (pipes, chains, substitution, regex patterns, recursion,
// negation) is not_applicable, so a finding here is always reproducible.

const GREP_FLAG_CHARS = new Set(["q", "F", "i", "c", "s", "l", "n", "H", "h"]);
const GREP_LONG_FLAGS = new Map([
  ["--quiet", "q"], ["--silent", "q"], ["--fixed-strings", "F"], ["--ignore-case", "i"],
  ["--count", "c"], ["--no-messages", "s"], ["--files-with-matches", "l"], ["--line-number", "n"],
]);
const REGEX_META_RE = /[\\[\]()*+?{}|^$]/;
const MAX_GATE_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Split a command into words, honouring single and double quotes. Returns null when the command
 * contains anything this recognizer refuses: an unquoted shell operator or redirection, a
 * substitution (`$` or backtick, even inside double quotes), a backslash escape, or a newline.
 * An unquoted `#` at a word start ends the command (shell comment).
 */
export function tokenizeSimpleCommand(command) {
  const s = String(command);
  const words = [];
  let cur = "";
  let inWord = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "'") {
      const end = s.indexOf("'", i + 1);
      if (end === -1) return null;
      cur += s.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (ch === '"') {
      const end = s.indexOf('"', i + 1);
      if (end === -1) return null;
      const inner = s.slice(i + 1, end);
      if (/[$`\\]/.test(inner)) return null;
      cur += inner;
      inWord = true;
      i = end;
    } else if (ch === " " || ch === "\t") {
      if (inWord) { words.push(cur); cur = ""; inWord = false; }
    } else if (ch === "#" && !inWord) {
      break;
    } else if (/[|&;<>()$`\\\n\r]/.test(ch)) {
      return null;
    } else {
      cur += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(cur);
  return words;
}

function resolveGatePath(p, root) {
  if (!p || /[*?[\]{}~]/.test(p)) return null;
  const norm = toSlash(p);
  const target = path.isAbsolute(norm) ? path.normalize(norm) : path.resolve(root, norm);
  return withinRootLexical(target, root) ? target : null;
}

function evaluateTestForm(args, root) {
  if (args.length !== 2 || !["-f", "-e", "-d", "-s"].includes(args[0])) return null;
  const target = resolveGatePath(args[1], root);
  if (!target) return null;
  const st = statOrNull(target);
  const passes = args[0] === "-e" ? Boolean(st)
    : args[0] === "-f" ? Boolean(st?.isFile())
      : args[0] === "-d" ? Boolean(st?.isDirectory())
        : Boolean(st?.isFile() && st.size > 0);
  return { form: "test", passes, evidence: `${args[1]} ${passes ? "already satisfies" : "does not satisfy"} test ${args[0]}` };
}

function evaluateGrepForm(tool, args, root) {
  const flags = new Set();
  let i = 0;
  let endOfFlags = false;
  for (; i < args.length; i += 1) {
    const a = args[i];
    if (endOfFlags || !a.startsWith("-") || a === "-") break;
    if (a === "--") { endOfFlags = true; continue; }
    if (a.startsWith("--")) {
      const short = GREP_LONG_FLAGS.get(a);
      if (!short) return null;
      flags.add(short);
      continue;
    }
    for (const ch of a.slice(1)) {
      if (!GREP_FLAG_CHARS.has(ch)) return null;
      flags.add(ch);
    }
  }
  const pattern = args[i];
  const files = args.slice(i + 1);
  if (pattern === undefined || pattern === "" || files.length === 0) return null;
  if (!flags.has("F") && REGEX_META_RE.test(pattern)) return null;
  const needle = flags.has("i") ? pattern.toLowerCase() : pattern;
  let passes = false;
  let matchedFile = null;
  for (const f of files) {
    const target = resolveGatePath(f, root);
    if (!target) return null;
    const st = statOrNull(target);
    // A missing file or a directory makes grep's exit status depend on flags and other files;
    // rather than model that, the gate is not evaluated.
    if (!st || !st.isFile() || st.size > MAX_GATE_FILE_BYTES) return null;
    let content;
    try { content = readFileSync(target, "utf8"); } catch { return null; }
    if (flags.has("i")) content = content.toLowerCase();
    if (!passes && content.includes(needle)) { passes = true; matchedFile = f; }
  }
  // Without -F a `.` in the pattern matches any character, so an absent literal does not prove
  // the regex fails. Only the "passes" direction is ever reported, so that is safe.
  return {
    form: tool,
    passes,
    evidence: passes ? `the pattern ${JSON.stringify(pattern)} is already present in ${matchedFile}` : "no match at HEAD",
  };
}

/**
 * Evaluate one `<automated>` command against the tree at `projectRoot` WITHOUT executing it.
 * Returns `{status: "passes_at_head" | "fails_at_head" | "not_applicable", form, evidence,
 * baseline}`. `baseline` is true when the command records a pre-change result
 * (`# baseline at HEAD: ...`), the escape hatch gsd's planner reference prescribes.
 */
export function probeAlreadyPassing(command, options = {}) {
  const root = typeof options.projectRoot === "string" && options.projectRoot ? options.projectRoot : process.cwd();
  const raw = decodeEntityAmps(typeof command === "string" ? command : "").trim();
  const none = { status: "not_applicable", form: null, evidence: null, baseline: false };
  if (raw === "" || MISSING_SENTINEL_RE.test(raw)) return none;
  const baseline = /(?:^|\s)#\s*baseline at HEAD\b/i.test(raw);
  const words = tokenizeSimpleCommand(raw);
  if (!words || words.length === 0) return none;
  let evaluated = null;
  const [head, ...args] = words;
  if (head === "test") evaluated = evaluateTestForm(args, root);
  else if (head === "[" && args.at(-1) === "]") evaluated = evaluateTestForm(args.slice(0, -1), root);
  else if (head === "grep" || head === "rg") evaluated = evaluateGrepForm(head, args, root);
  if (!evaluated) return none;
  return { status: evaluated.passes ? "passes_at_head" : "fails_at_head", form: evaluated.form, evidence: evaluated.evidence, baseline };
}

// ─── Threat register (gsd plan-document.cts + init.cts, #4683) ───────────────

const THREAT_MODEL_BLOCK_RE = /<threat_model>([\s\S]*?)<\/threat_model>/gi;
// gsd's grammar is `T-{phase}-NN`; a muster run has no phase, so `T-NN` is accepted too. The
// reserved supply-chain row (`T-SC`, `T-{phase}-SC`) is shared by design and never matches.
const THREAT_REGISTER_ROW_RE = /^[^\S\n]*\|[^\S\n]*(T-\d+(?:\.\d+)?(?:-\d+)?)[^\S\n]*\|/;

/** First-cell IDs of register rows inside every `<threat_model>` block, fenced quotes excluded. */
export function extractThreatRegisterIds(content) {
  const { text } = blankFencedBlocks(String(content ?? ""));
  const ids = [];
  for (const block of text.matchAll(THREAT_MODEL_BLOCK_RE)) {
    for (const line of block[1].split("\n")) {
      const row = line.match(THREAT_REGISTER_ROW_RE);
      if (row) ids.push(row[1]);
    }
  }
  return ids;
}

// ─── Truncation (gsd verify.cts scanPlanTruncation, #4927) ───────────────────

export function scanPlanTruncation(content) {
  const errors = [];
  const text = content || "";
  if (/<!--\s*(?:gsd|muster):write-continue\s*-->/.test(text)) {
    errors.push("the incremental-write sentinel `<!-- muster:write-continue -->` is still present: the last section was never written");
  }
  if (/<tasks>/.test(text) && !/<\/tasks>/.test(text)) {
    errors.push("`<tasks>` is opened but `</tasks>` never appears: the file was cut off before the task list ended");
  }
  const trimmed = text.replace(/\s+$/, "");
  const lastLt = trimmed.lastIndexOf("<");
  if (lastLt !== -1 && trimmed.indexOf(">", lastLt) === -1 && /^<\/?[A-Za-z_!][^<>]{0,200}$/.test(trimmed.slice(lastLt))) {
    errors.push(`the file ends inside a tag (\`${trimmed.slice(lastLt).slice(0, 40)}\`): the write stopped mid-payload`);
  }
  return errors;
}

// ─── Dependency graph (gsd phase.cts computeDependencyLevels) ────────────────

/**
 * Kahn's algorithm over task `depends_on`, case-folded id resolution (gsd #2237). Returns
 * `{level: Map<id, 0-based longest-path level>, cycle: [ids], unresolved: [{task, token}]}`.
 * Tasks without a usable id are left out of the graph (task_completeness reports them).
 */
export function computeDependencyLevels(tasks) {
  const nodes = tasks.filter(t => t.id && TASK_ID_RE.test(t.id));
  const byLower = new Map(nodes.map(t => [t.id.toLowerCase(), t.id]));
  const inDeg = new Map(nodes.map(t => [t.id, 0]));
  const adj = new Map(nodes.map(t => [t.id, []]));
  const unresolved = [];
  for (const t of nodes) {
    for (const dep of t.dependsOn) {
      const resolved = byLower.get(dep.toLowerCase());
      if (!resolved) { unresolved.push({ task: t.id, token: dep }); continue; }
      adj.get(resolved).push(t.id);
      inDeg.set(t.id, inDeg.get(t.id) + 1);
    }
  }
  const level = new Map();
  const queue = [];
  for (const t of nodes) if (inDeg.get(t.id) === 0) { queue.push(t.id); level.set(t.id, 0); }
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    for (const next of adj.get(cur)) {
      level.set(next, Math.max(level.get(next) ?? -1, level.get(cur) + 1));
      inDeg.set(next, inDeg.get(next) - 1);
      if (inDeg.get(next) === 0) queue.push(next);
    }
  }
  const cycle = nodes.filter(t => !queue.includes(t.id)).map(t => t.id);
  return { level, cycle, unresolved, resolve: dep => byLower.get(String(dep).toLowerCase()) ?? null };
}

// ─── The lint ────────────────────────────────────────────────────────────────

function label(task) {
  return task.id ? `Task ${task.id}` : `Task #${task.index}${task.name ? ` (${task.name})` : ""}`;
}

/**
 * The text units gsd walks (each task body, then the task-stripped remainder), taken from the
 * parsed tasks so a finding names the exact task even when two tasks share a `<name>`, and an
 * unclosed task is its own unit rather than leaking into the remainder.
 */
function textUnits(plan) {
  const units = plan.tasks.map(t => ({ text: t.block, where: label(t) }));
  let remainder = "";
  let at = 0;
  for (const t of plan.tasks) { remainder += plan.body.slice(at, t.offset); at = t.end; }
  remainder += plan.body.slice(at);
  units.push({ text: remainder, where: "Outside any task" });
  return units;
}

function failingDirectionsByTask(plan) {
  const out = [];
  const guard = { n: 0 };
  for (const unit of textUnits(plan)) {
    const entries = [];
    const more = extractFailingFromText(unit.text, "", entries, guard);
    out.push(...entries.map(e => ({ ...e, where: unit.where })));
    if (!more) break;
  }
  return out;
}

function automatedCommandsByTask(plan) {
  const out = [];
  for (const unit of textUnits(plan)) {
    for (const m of unit.text.matchAll(AUTOMATED_BLOCK_RE)) {
      const command = (m[1] ?? "").trim();
      if (command !== "") out.push({ command, where: unit.where });
      if (out.length > MAX_BLOCK_WALK) return out;
    }
  }
  return out;
}

function quote(s, max = 120) {
  const one = String(s).replace(/\s+/g, " ").trim();
  return JSON.stringify(one.length > max ? `${one.slice(0, max - 1)}…` : one);
}

/**
 * Lint a PLAN.md's text. `projectRoot` (default cwd) anchors the filesystem probes (verify
 * command paths, already-passing gates). Returns a CheckResult. Never throws on any input.
 */
export function lintPlan(rawText, options = {}) {
  const projectRoot = typeof options.projectRoot === "string" && options.projectRoot ? options.projectRoot : process.cwd();
  const issues = [];
  const add = (dimension, severity, required_property, summary) => issues.push({ dimension, severity, required_property, summary });
  // options.catalog ({agents, skills} Maps, src/specialists.js) turns on the agent_hint/skills
  // membership checks; the CLI always passes it, pure callers may leave it out.
  const catalog = options.catalog && options.catalog.agents && options.catalog.skills ? options.catalog : null;
  // options.skillCandidates ([{id, score}], preflight.json's skillCandidates) adds the
  // "skill-less task despite a strong candidate" warning; needs catalog for descriptions.
  const skillCandidates = Array.isArray(options.skillCandidates) ? options.skillCandidates : [];
  const plan = parsePlan(rawText);
  const { frontmatter, tasks } = plan;

  // plan_structure
  if (!plan.frontmatterPresent) {
    add(DIMENSIONS.PLAN_STRUCTURE, SEVERITY.BLOCKER, "PLAN.md opens with a YAML frontmatter block", "no `---` frontmatter block at the top of the file");
  } else if (plan.frontmatterError) {
    add(DIMENSIONS.PLAN_STRUCTURE, SEVERITY.BLOCKER, "PLAN.md frontmatter is valid YAML", `frontmatter does not parse: ${plan.frontmatterError}`);
  } else {
    for (const field of REQUIRED_FRONTMATTER) {
      if (frontmatter[field] === undefined) {
        add(DIMENSIONS.PLAN_STRUCTURE, SEVERITY.BLOCKER, `Frontmatter declares \`${field}\``, `missing required frontmatter field: ${field}`);
      }
    }
  }
  for (const error of scanPlanTruncation(plan.text)) {
    add(DIMENSIONS.PLAN_STRUCTURE, SEVERITY.BLOCKER, "PLAN.md is written in full, not truncated", `plan appears truncated: ${error}`);
  }
  if (plan.unclosedFence) {
    add(DIMENSIONS.PLAN_STRUCTURE, SEVERITY.BLOCKER, "Every code fence is closed", "a ``` or ~~~ fence is never closed; everything after it is read as quoted text");
  }
  if (tasks.length === 0) {
    add(DIMENSIONS.PLAN_STRUCTURE, SEVERITY.BLOCKER, "The plan declares at least one `<task>`", "no <task> elements found");
  }
  const bodyLineOffset = plan.text.split("\n").length - plan.body.split("\n").length;
  for (const { tag, line } of strayClosingTags(plan.body)) {
    add(DIMENSIONS.PLAN_STRUCTURE, SEVERITY.WARNING, "Every closing tag in PLAN.md has an opener", `line ${line + bodyLineOffset}: </${tag}> closes nothing (no <${tag}> anywhere in the plan); delete it`);
  }
  for (const t of tasks) {
    if (!t.closed) add(DIMENSIONS.PLAN_STRUCTURE, SEVERITY.BLOCKER, "Every `<task>` is closed by `</task>`", `${label(t)} is opened but never closed`);
    if (t.kind !== "checkpoint" && t.type !== null && !KNOWN_TASK_TYPES.includes(t.type)) {
      add(DIMENSIONS.PLAN_STRUCTURE, SEVERITY.WARNING, `A task type is one of ${KNOWN_TASK_TYPES.join(", ")} or checkpoint:*`, `${label(t)} has unknown type ${quote(t.type)}; it is validated as an auto task`);
    }
  }

  // task_completeness
  const seenIds = new Map();
  for (const t of tasks) {
    if (t.id === null) {
      add(DIMENSIONS.TASK_COMPLETENESS, SEVERITY.BLOCKER, "Every task has an `id` attribute", `${label(t)} has no id attribute`);
    } else if (!TASK_ID_RE.test(t.id)) {
      add(DIMENSIONS.TASK_COMPLETENESS, SEVERITY.BLOCKER, "A task id is 1-64 characters of [A-Za-z0-9._-], starting alphanumeric", `${label(t)} has an invalid id ${quote(t.id)}`);
    } else {
      const lower = t.id.toLowerCase();
      if (seenIds.has(lower)) {
        add(DIMENSIONS.TASK_COMPLETENESS, SEVERITY.BLOCKER, "Task ids are unique (case-insensitively)", `task ids ${quote(seenIds.get(lower))} and ${quote(t.id)} collide`);
      } else seenIds.set(lower, t.id);
    }
    if (!t.hasName) add(DIMENSIONS.TASK_COMPLETENESS, SEVERITY.BLOCKER, "Every task has a `<name>`", `${label(t)} is missing <name>`);
    if (t.agentHint !== null && !AGENT_HINT_RE.test(t.agentHint)) {
      add(DIMENSIONS.TASK_COMPLETENESS, SEVERITY.WARNING, "`agent_hint` names one agent id", `${label(t)} has an agent_hint that is not an agent id: ${quote(t.agentHint)}`);
    } else if (t.agentHint !== null && catalog) {
      const agent = catalog.agents.get(t.agentHint);
      if (!agent) add(DIMENSIONS.TASK_COMPLETENESS, SEVERITY.WARNING, "`agent_hint` is a known plugin agent id, else omitted", `${label(t)} names an unknown agent ${quote(t.agentHint)}; omit agent_hint for the default executor`);
      else if (!agent.dispatchable) add(DIMENSIONS.TASK_COMPLETENESS, SEVERITY.WARNING, "`agent_hint` names an agent that can implement and commit", `${label(t)} names ${quote(t.agentHint)}, a read-only or workflow-seat agent that cannot execute a task`);
    }
    if (catalog && skillCandidates.length && t.kind !== "checkpoint" && !t.skillsDeclared) {
      const strong = skillCandidates
        .filter((c) => c && Number(c.score) >= HIGH_SKILL_SCORE && catalog.skills.has(c.id))
        .map((c) => ({ id: c.id, source: "builtin", description: catalog.skills.get(c.id).description }));
      const text = `${t.name} ${(t.block.match(/<action[^>]{0,200}>([\s\S]*?)<\/action>/) || [])[1] || ""}`;
      const fit = matchSkills(text, strong, { limit: 3 }).filter((m) => m.score >= 3).map((m) => m.id);
      if (fit.length) add(DIMENSIONS.TASK_COMPLETENESS, SEVERITY.WARNING, "A task binds the skills preflight ranked highly for it, or declines them with `skills=\"\"`", `${label(t)} binds no skills, but preflight ranked ${fit.map((id) => `"${id}"`).join(", ")} highly and they match this task; add skills="${fit.join(",")}" or write skills="" to decline`);
    }
    for (const id of t.skills) {
      if (!SKILL_ID_RE.test(id)) add(DIMENSIONS.TASK_COMPLETENESS, SEVERITY.BLOCKER, "`skills` lists builtin skill ids", `${label(t)} has a malformed skill id ${quote(id)}`);
      else if (catalog && !catalog.skills.has(id)) add(DIMENSIONS.TASK_COMPLETENESS, SEVERITY.BLOCKER, "`skills` lists builtin skill ids", `${label(t)} binds unknown skill ${quote(id)}; use an id from plugin/builtins/ or drop it`);
    }
    if (t.kind === "checkpoint") {
      const need = (has, el) => { if (!has) add(DIMENSIONS.TASK_COMPLETENESS, SEVERITY.BLOCKER, `A \`${t.type}\` task has \`<${el}>\``, `${label(t)} is missing <${el}>`); };
      need(t.hasResumeSignal, "resume-signal");
      if (t.type === "checkpoint:human-verify") { need(t.hasWhatBuilt, "what-built"); need(t.hasHowToVerify, "how-to-verify"); }
      if (t.type === "checkpoint:decision") {
        need(t.hasDecision, "decision");
        need(t.hasOptions, "options");
        const { autoSelect } = t;
        if (autoSelect !== null) {
          if (autoSelect.length === 0) {
            add(DIMENSIONS.TASK_COMPLETENESS, SEVERITY.BLOCKER, "`auto_select` names an `<option id>`", `${label(t)} has an empty auto_select`);
          } else if (t.hasOptions && !t.optionIds.includes(autoSelect)) {
            add(DIMENSIONS.TASK_COMPLETENESS, SEVERITY.BLOCKER, "`auto_select` names an `<option id>`", `${label(t)} auto_select=${quote(autoSelect)} matches no <option id> (available: ${t.optionIds.join(", ") || "none"})`);
          }
        }
      }
      if (t.type === "checkpoint:human-action") { need(t.hasAction, "action"); need(t.hasInstructions, "instructions"); need(t.hasVerification, "verification"); }
      continue;
    }
    if (!t.hasAction) add(DIMENSIONS.TASK_COMPLETENESS, SEVERITY.BLOCKER, "Every task has an `<action>`", `${label(t)} is missing <action>`);
    if (!t.hasVerify) add(DIMENSIONS.TASK_COMPLETENESS, SEVERITY.BLOCKER, "Every task has a `<verify>` separating pass from fail", `${label(t)} is missing <verify>`);
    if (!t.hasFiles) add(DIMENSIONS.TASK_COMPLETENESS, SEVERITY.BLOCKER, "Every task declares the files it touches in `<files>`", `${label(t)} is missing <files>`);
    else if (t.files.length === 0) add(DIMENSIONS.TASK_COMPLETENESS, SEVERITY.BLOCKER, "Every task declares the files it touches in `<files>`", `${label(t)} has an empty <files>`);
    if (!t.hasDone) add(DIMENSIONS.TASK_COMPLETENESS, SEVERITY.WARNING, "Every task states measurable acceptance in `<done>`", `${label(t)} is missing <done>`);
  }
  const hasCheckpoints = tasks.some(t => t.kind === "checkpoint");
  if (hasCheckpoints && frontmatter && frontmatter.autonomous !== false && String(frontmatter.autonomous) !== "false") {
    add(DIMENSIONS.TASK_COMPLETENESS, SEVERITY.BLOCKER, "A plan with checkpoint tasks sets `autonomous: false`", "the plan has checkpoint tasks but autonomous is not false");
  }

  // nyquist_compliance: every <verify> carries a runnable <automated>, and every runnable
  // <automated> states its failing direction.
  for (const t of tasks) {
    if (t.kind === "checkpoint" || !t.hasVerify) continue;
    const commands = [...(t.verifyBody ?? "").matchAll(/<automated[^>]{0,200}>([\s\S]*?)<\/automated>/g)].map(m => m[1].trim()).filter(Boolean);
    if (commands.length === 0) {
      add(DIMENSIONS.NYQUIST, SEVERITY.BLOCKER, "Every `<verify>` includes a runnable `<automated>` command", `${label(t)} has a <verify> with no <automated> command`);
    }
  }
  for (const e of failingDirectionsByTask(plan)) {
    const where = e.where;
    if (e.status === "missing") {
      add(DIMENSIONS.NYQUIST, SEVERITY.BLOCKER, "Every runnable `<automated>` command has a `<fails_when>` naming its failure signal", `${where}: ${quote(e.command)} has no stated failing direction`);
    } else if (e.status === "empty") {
      add(DIMENSIONS.NYQUIST, SEVERITY.BLOCKER, "Every runnable `<automated>` command has a `<fails_when>` naming its failure signal", `${where}: the <fails_when> after ${quote(e.command)} is blank`);
    } else if (e.status === "placeholder") {
      add(DIMENSIONS.NYQUIST, SEVERITY.BLOCKER, "Every runnable `<automated>` command has a `<fails_when>` naming its failure signal", `${where}: ${quote(e.statement)} is a placeholder, not a failure signal (command ${quote(e.command)})`);
    } else if (e.status === "orphan") {
      add(DIMENSIONS.NYQUIST, SEVERITY.WARNING, "Every `<fails_when>` follows the `<automated>` command it describes", `${where}: a <fails_when> follows no command and satisfies nothing: ${quote(e.statement ?? "")}`);
    } else if (e.status === "sentinel") {
      add(DIMENSIONS.NYQUIST, SEVERITY.WARNING, "Every `<automated>` command is runnable when the task merges", `${where}: ${quote(e.command)} is the MISSING sentinel; an earlier task must create the test and the command be replaced before merge-wave can re-run it`);
    }
  }

  // verify_command_paths
  const declaredPaths = extractDeclaredPaths(plan.body);
  const automated = automatedCommandsByTask(plan);
  for (const c of automated) {
    const r = resolveVerifyCommandTarget(c.command, { projectRoot, declaredPaths });
    if (r.severity === "none") continue;
    const where = c.where;
    const why = {
      missing_dir: `its ${r.form} target ${quote(r.rawTarget)} is not a directory under the project root`,
      no_manifest: `its ${r.form} target ${quote(r.rawTarget)} has no ${r.expectedManifest}`,
      dynamic_path: `its ${r.form} target ${quote(r.rawTarget)} is dynamic and cannot be grounded`,
      outside_root: `its ${r.form} target ${quote(r.rawTarget)} is outside the project root (ambiguous under worktree isolation)`,
      manifest_unreadable: `the package.json at ${quote(r.rawTarget)} cannot be read`,
      script_missing: `npm script ${quote(r.script)} is not defined in ${quote(r.rawTarget)}/package.json`,
    }[r.reason] ?? r.reason;
    add(DIMENSIONS.VERIFY_PATHS, r.severity, "Each `<automated>` command's `cd`/`--prefix` target resolves from the project root", `${where}: ${quote(c.command)}: ${why}`);
  }

  // verify_command_sanity: a gate that already passes at HEAD measures nothing.
  for (const c of automated) {
    const r = probeAlreadyPassing(c.command, { projectRoot });
    if (r.status !== "passes_at_head") continue;
    add(
      DIMENSIONS.VERIFY_SANITY,
      r.baseline ? SEVERITY.WARNING : SEVERITY.BLOCKER,
      "A count/match gate fails at HEAD, before the task's work exists (otherwise it measures nothing)",
      `${c.where}: ${quote(c.command)} already passes at HEAD: ${r.evidence}${r.baseline ? " (a baseline is recorded; confirm the gate asserts a change from it)" : ""}`,
    );
  }

  // dependency_correctness
  const graph = computeDependencyLevels(tasks);
  for (const { task, token } of graph.unresolved) {
    add(DIMENSIONS.DEPENDENCIES, SEVERITY.BLOCKER, "Every `depends_on` entry names a task in this plan", `Task ${task}: depends_on ${quote(token)} does not name any task in this plan`);
  }
  if (graph.cycle.length > 0) {
    add(DIMENSIONS.DEPENDENCIES, SEVERITY.BLOCKER, "The task `depends_on` graph is acyclic", `depends_on cycle detected, involving: ${graph.cycle.join(", ")}`);
  }
  const byId = new Map(tasks.filter(t => t.id).map(t => [t.id, t]));
  for (const t of tasks) {
    if (t.waveRaw === null) {
      add(DIMENSIONS.DEPENDENCIES, SEVERITY.BLOCKER, "Every task declares a `wave`", `${label(t)} has no wave attribute`);
    } else if (t.wave === null || t.wave < 1) {
      add(DIMENSIONS.DEPENDENCIES, SEVERITY.BLOCKER, "A task's `wave` is an integer >= 1", `${label(t)} has wave ${quote(t.waveRaw)}`);
    }
  }
  const cyclic = new Set(graph.cycle);
  for (const t of tasks) {
    if (t.wave === null || t.wave < 1 || !t.id || cyclic.has(t.id)) continue;
    let required = 1;
    for (const dep of t.dependsOn) {
      const depTask = byId.get(graph.resolve(dep));
      if (!depTask || depTask.wave === null) continue;
      if (depTask.wave >= t.wave) {
        add(DIMENSIONS.DEPENDENCIES, SEVERITY.BLOCKER, "A task runs in a later wave than every task it depends on", `${label(t)} is in wave ${t.wave} but depends on ${depTask.id} in wave ${depTask.wave}`);
      }
      required = Math.max(required, depTask.wave + 1);
    }
    // gsd planner assign_waves: a shared file with an earlier-wave task also forces a later wave.
    for (const other of tasks) {
      if (other === t || other.wave === null || other.wave >= t.wave) continue;
      const shared = t.files.some(f => other.files.some(g => normalizePlanPath(f) === normalizePlanPath(g)));
      if (shared) required = Math.max(required, other.wave + 1);
    }
    if (t.wave > required) {
      add(DIMENSIONS.DEPENDENCIES, SEVERITY.WARNING, "A task's wave is the earliest its dependencies and file ownership allow", `${label(t)} declares wave ${t.wave} but its depends_on and files place it in wave ${required}`);
    }
  }
  // gsd planner: "Same-wave plans must have zero files_modified overlap". In muster each task of
  // a wave runs in its own worktree, so a shared file is a guaranteed merge conflict.
  const waves = new Map();
  for (const t of tasks) {
    if (t.wave === null) continue;
    if (!waves.has(t.wave)) waves.set(t.wave, []);
    waves.get(t.wave).push(t);
  }
  for (const [wave, members] of [...waves.entries()].sort((a, b) => a[0] - b[0])) {
    const owner = new Map();
    for (const t of members) {
      for (const f of new Set(t.files.map(normalizePlanPath))) {
        if (owner.has(f)) {
          add(DIMENSIONS.DEPENDENCIES, SEVERITY.BLOCKER, "Tasks in the same wave have zero `<files>` overlap", `wave ${wave}: ${label(owner.get(f))} and ${label(t)} both touch ${f}`);
        } else owner.set(f, t);
      }
    }
  }

  // tracer_first (gsd-planner "Tracer-First Decomposition (default)"); `tracer: false` opts out.
  const tracerOptOut = frontmatter && (frontmatter.tracer === false || String(frontmatter.tracer) === "false");
  const executable = tasks.filter(t => t.kind !== "checkpoint");
  if (!tracerOptOut && executable.length > 0) {
    const tracers = executable.filter(t => t.type === "tracer");
    const req = "The plan leads with exactly one `type=\"tracer\"` task and no task runs in an earlier wave (or sets `tracer: false`)";
    if (tracers.length === 0) {
      add(DIMENSIONS.TRACER, SEVERITY.WARNING, req, "no task has type=\"tracer\"; set `tracer: false` in frontmatter to opt out deliberately");
    } else {
      if (tracers.length > 1) add(DIMENSIONS.TRACER, SEVERITY.WARNING, req, `${tracers.length} tracer tasks (${tracers.map(label).join(", ")}); a plan has one`);
      const tracer = tracers[0];
      if (executable[0] !== tracer) add(DIMENSIONS.TRACER, SEVERITY.WARNING, req, `${label(tracer)} is the tracer but ${label(executable[0])} comes first`);
      // A task in the tracer's own wave is independent of it: it cannot depend on the tracer
      // (dependency_correctness) or share a file with it (same-wave overlap is a blocker). Forcing
      // it a wave later serialized small plans of independent tasks (live e2e 2026-11-10: two
      // helpers a locked decision declared independent ran in two waves, so the integration
      // check never ran). Only a task that runs BEFORE the tracer is out of order.
      if (tracer.wave !== null) {
        const early = executable.filter(t => t !== tracer && t.wave !== null && t.wave < tracer.wave);
        if (early.length > 0) add(DIMENSIONS.TRACER, SEVERITY.WARNING, req, `${early.map(label).join(", ")} run${early.length === 1 ? "s" : ""} before the tracer (wave ${tracer.wave}), before the slice is proven`);
      }
    }
  }

  // reversibility (gsd verify.cts #1951): ratings are from the taxonomy, and a one-way door is
  // preceded by a checkpoint:decision unless the decision is already settled.
  const decisionOffsets = tasks.filter(t => t.type === "checkpoint:decision").map(t => t.offset);
  for (const t of tasks) {
    if (!t.reversibility) continue;
    const { rating } = t.reversibility;
    if (!rating || !REVERSIBILITY_RATINGS.includes(rating.toLowerCase())) {
      add(DIMENSIONS.REVERSIBILITY, SEVERITY.WARNING, `A \`<reversibility>\` rating is one of ${REVERSIBILITY_RATINGS.join(", ")}`, `${label(t)} has reversibility rating ${quote(rating ?? "(none)")}`);
    } else if (rating.toLowerCase() === "one-way" && !decisionOffsets.some(o => o < t.offset)) {
      add(DIMENSIONS.REVERSIBILITY, SEVERITY.WARNING, "A one-way decision is confirmed by a preceding checkpoint:decision (unless already settled in CONTEXT.md)", `${label(t)} is rated one-way with no preceding checkpoint:decision`);
    }
  }

  // threat_model (gsd init.cts findDuplicateThreatIds): one register row per threat ID.
  const seenThreats = new Map();
  for (const id of extractThreatRegisterIds(plan.text)) seenThreats.set(id, (seenThreats.get(id) ?? 0) + 1);
  for (const [id, count] of seenThreats) {
    if (count > 1) add(DIMENSIONS.THREAT_MODEL, SEVERITY.BLOCKER, "Threat IDs are unique in the register", `threat ID ${id} names ${count} register rows`);
  }

  // spec_traceability: checked only when the plan names its spec (`spec:` in frontmatter), so a
  // spec-less plan lints exactly as before.
  if (frontmatter && Object.hasOwn(frontmatter, "spec")) {
    for (const i of lintSpecTraceability(plan, { projectRoot })) issues.push(i);
  }

  return { verdict: issues.length === 0 ? "PASS" : "ISSUES", issues };
}

export function countBySeverity(result) {
  const counts = { blocker: 0, warning: 0, info: 0 };
  for (const i of result.issues) counts[i.severity] = (counts[i.severity] ?? 0) + 1;
  return counts;
}

export function formatCheckResult(result, file = "PLAN.md") {
  const c = countBySeverity(result);
  if (result.verdict === "PASS") return `plan-lint ${file}: PASS`;
  const lines = [`plan-lint ${file}: ISSUES (${c.blocker} blocker, ${c.warning} warning, ${c.info} info)`];
  for (const i of result.issues) {
    lines.push(`  ${i.severity.toUpperCase()} [${i.dimension}] ${i.summary}`);
    lines.push(`    required: ${i.required_property}`);
  }
  return lines.join("\n");
}

/**
 * CLI entry: `plan-lint <PLAN.md> [--json] [--root <dir>]`. Returns the exit code: 0 no
 * blockers, 1 blockers, 2 not evaluated (usage error, missing/unreadable/oversized file).
 */
export function runPlanLintCli(args, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const cwd = io.cwd ?? process.cwd();
  const usage = "usage: muster plan-lint <PLAN.md> [--json] [--root <dir>]";
  const positionals = [];
  let json = false;
  let root = null;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--root") {
      root = args[i + 1];
      i += 1;
      if (!root) { stderr.write(`muster: plan-lint: --root needs a directory\n${usage}\n`); return 2; }
    } else if (a.startsWith("--")) { stderr.write(`muster: plan-lint: unknown flag ${a}\n${usage}\n`); return 2; }
    else positionals.push(a);
  }
  if (positionals.length !== 1) { stderr.write(`muster: plan-lint: expected one PLAN.md path\n${usage}\n`); return 2; }
  const file = path.resolve(cwd, positionals[0]);
  const projectRoot = path.resolve(cwd, root ?? ".");
  let text;
  try {
    const st = statSync(file);
    if (!st.isFile()) throw new Error("not a regular file");
    if (st.size > MAX_PLAN_BYTES) throw new Error(`larger than ${MAX_PLAN_BYTES} bytes`);
    text = readFileSync(file, "utf8");
  } catch (error) {
    stderr.write(`muster: plan-lint: cannot read ${positionals[0]}: ${error.code ?? error.message} (not evaluated)\n`);
    return 2;
  }
  let catalog = io.catalog;
  if (catalog === undefined) {
    try { catalog = specialistCatalog(); } catch { catalog = null; }
  }
  // preflight.json sits next to PLAN.md in the run dir; absent or unreadable means no candidates.
  let skillCandidates = io.skillCandidates;
  if (skillCandidates === undefined) {
    try { skillCandidates = JSON.parse(readFileSync(path.join(path.dirname(file), "preflight.json"), "utf8")).skillCandidates; } catch { skillCandidates = []; }
  }
  const result = lintPlan(text, { projectRoot, catalog, skillCandidates });
  stdout.write(`${json ? JSON.stringify(result, null, 2) : formatCheckResult(result, positionals[0])}\n`);
  return countBySeverity(result).blocker > 0 ? 1 : 0;
}
