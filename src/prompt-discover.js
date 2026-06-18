// Repo prompt-discovery: locate candidate prompts in a codebase so the audit's
// prompt-quality dimension can lint them. Pure + deterministic — given a list of
// { path, content } it returns the prompts it found, no IO of its own.
//
// Prompts live in three places, and a real project usually keeps most of them as TEXT,
// not in code: (1) dedicated prompt files (`.prompt`/`.tmpl`, anything under `prompts/`);
// (2) markdown/text prompt docs — agent definitions, skill instructions, command prompts —
// recognised by name+description frontmatter (the Claude Code / plugin convention) or a
// conventional `agents/ commands/ skills/ prompts/` directory; (3) backtick template-
// literal assignments to a prompt-ish identifier in source files. A length floor filters
// trivial strings so labels and one-liners don't register as prompts.

const PROMPT_EXT = /\.(prompt|prompt\.md|tmpl)$/i;
// Plural `prompts/` only — a singular `prompt/` is usually a code utility folder, not a
// directory of prompt assets, so matching it would misclassify ordinary source files.
const PROMPT_DIR = /(^|\/)prompts\//i;
// Markdown/text files, and the conventional directories that hold prompt docs.
const MD_EXT = /\.(md|markdown|mdx|txt)$/i;
const PROMPT_DOC_DIR = /(^|\/)(agents|commands|skills|prompts)\//i;
// Assignment to a prompt-ish identifier holding a backtick template literal.
const ASSIGN = /\b(system|systemprompt|prompt|instructions|persona)\s*[:=]\s*`([\s\S]*?)`/gi;
const MIN_PROMPT_LEN = 40;

// A leading YAML frontmatter block (--- ... ---). Captured so we can both detect the
// agent/skill/command convention and strip it before linting (so the lint reads the
// instruction body, not the `name:`/`description:` header).
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

export function stripFrontmatter(content) {
  return String(content).replace(FRONTMATTER, "");
}

export function isPromptFile(path) {
  return PROMPT_EXT.test(path) || PROMPT_DIR.test(path);
}

// Is this markdown/text file a prompt artifact (not an ordinary README/doc)? Precise by
// design: name+description frontmatter (skill/agent/command convention) or a conventional
// prompt directory. We deliberately do NOT treat a stray `{{var}}` mention as a signal —
// docs that merely describe prompt syntax would false-positive.
function isPromptDoc(path, content) {
  if (!MD_EXT.test(path)) return false;
  if (PROMPT_DOC_DIR.test(path)) return true;
  const fm = (content.match(FRONTMATTER) || [""])[0];
  return /\bname:\s*\S/.test(fm) && /\bdescription:\s*\S/.test(fm);
}

export function discoverPrompts(files = []) {
  const found = [];
  for (const { path, content } of files) {
    if (!content) continue;
    if (isPromptFile(path)) {
      const text = stripFrontmatter(content);
      // A dedicated prompt file is a prompt regardless of length; only require it be
      // non-empty (the length floor is for inline code strings, below).
      if (text.trim().length > 0)
        found.push({ file: path, kind: "prompt-file", text });
      continue;
    }
    if (isPromptDoc(path, content)) {
      const text = stripFrontmatter(content).trim();
      if (text.length >= MIN_PROMPT_LEN)
        found.push({ file: path, kind: "prompt-doc", text });
      continue;
    }
    // Reset lastIndex defensively (ASSIGN is a shared /g literal) and scan the source.
    ASSIGN.lastIndex = 0;
    let m;
    while ((m = ASSIGN.exec(content)) !== null) {
      const text = m[2];
      if (text.trim().length >= MIN_PROMPT_LEN)
        found.push({ file: path, kind: "system-prompt", identifier: m[1], text });
    }
  }
  return found;
}
