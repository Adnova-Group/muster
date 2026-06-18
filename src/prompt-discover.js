// Repo prompt-discovery: locate candidate prompts in a codebase so the audit's
// prompt-quality dimension can lint them. Pure + deterministic — given a list of
// { path, content } it returns the prompts it found, no IO of its own.
//
// Two sources: (1) files that ARE prompts (a `.prompt`/`.prompt.md` file, or anything
// under a `prompts/` directory), and (2) backtick template-literal assignments to a
// prompt-ish identifier (system / systemPrompt / prompt / instructions / persona) in
// source files. A length floor filters trivial strings so labels and one-liners don't
// register as prompts.

const PROMPT_EXT = /\.(prompt|prompt\.md|tmpl)$/i;
// Plural `prompts/` only — a singular `prompt/` is usually a code utility folder, not a
// directory of prompt assets, so matching it would misclassify ordinary source files.
const PROMPT_DIR = /(^|\/)prompts\//i;
// Assignment to a prompt-ish identifier holding a backtick template literal.
const ASSIGN = /\b(system|systemprompt|prompt|instructions|persona)\s*[:=]\s*`([\s\S]*?)`/gi;
const MIN_PROMPT_LEN = 40;

export function isPromptFile(path) {
  return PROMPT_EXT.test(path) || PROMPT_DIR.test(path);
}

export function discoverPrompts(files = []) {
  const found = [];
  for (const { path, content } of files) {
    if (!content) continue;
    if (isPromptFile(path)) {
      // A dedicated prompt file is a prompt regardless of length; only require it be
      // non-empty (the length floor is for inline code strings, below).
      if (content.trim().length > 0)
        found.push({ file: path, kind: "prompt-file", text: content });
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
