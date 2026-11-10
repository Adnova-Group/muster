// `muster init pm-link [dir] [--approve pm-link]` (PM domain stage E): an optional pointer in the
// project's AGENTS.md to its product intents and change specs, so any agent reading the root
// instructions finds them. Attended only: without --approve it previews the line; with it, it
// appends exactly one marked line to an existing AGENTS.md and nothing else.
//
// AGENTS.md is user-owned (plugin/commands/init.md): this never creates it (native init does),
// never rewrites existing text, and is a no-op when the marked line is already there. The write
// goes through the root-scoped, no-follow, locked fs-safe helpers, so a symlinked or hard-linked
// AGENTS.md is refused rather than followed.
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readContainedFile, updateContainedFile, sha256 } from "./fs-safe.js";

export const PM_LINK_MARKER = "<!-- muster:pm-docs -->";
export const PM_LINK_LINE = `${PM_LINK_MARKER} Product intents live in \`docs/intent/\` and change specs in \`docs/specs/<slug>/SPEC.md\`: read the ones covering a feature before changing it; a spec's acceptance criteria and invariants are the contract.`;
const MAX_AGENTS_BYTES = 1024 * 1024;

export async function linkPmDocs(dir, { approved = false } = {}) {
  const root = await realpath(resolve(dir));
  const path = join(root, "AGENTS.md");
  const current = await readContainedFile(root, path, { maxBytes: MAX_AGENTS_BYTES, allowMissing: true });
  if (current === null) return { ok: false, status: "absent", path: "AGENTS.md", line: PM_LINK_LINE, detail: "AGENTS.md does not exist; run native instruction init first (muster never creates it)" };
  if (current.toString("utf8").includes(PM_LINK_MARKER)) return { ok: true, status: "present", path: "AGENTS.md", sha256: sha256(current) };
  if (!approved) return { ok: true, status: "preview", path: "AGENTS.md", line: PM_LINK_LINE, expectSha256: sha256(current) };
  let after = null;
  await updateContainedFile(root, path, (bytes) => {
    if (bytes === null) throw new Error("AGENTS.md disappeared before the approved append");
    const text = bytes.toString("utf8");
    if (text.includes(PM_LINK_MARKER)) { after = bytes; return bytes; }
    const sep = text.length === 0 || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    after = Buffer.from(`${text}${sep}${PM_LINK_LINE}\n`, "utf8");
    return after;
  });
  return { ok: true, status: "added", path: "AGENTS.md", line: PM_LINK_LINE, sha256: sha256(after) };
}
