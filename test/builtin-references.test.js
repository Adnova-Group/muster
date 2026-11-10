import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, access } from "node:fs/promises";
import { join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Every relative file a builtin's SKILL.md points at must ship inside the plugin, or the model
// is told to read a file that is not there. Upstream skills split detail into references/,
// scripts/ and assets/; a vendored copy that keeps the pointer must keep the file too.
//
// What counts as a pointer (prose only; fenced code blocks are examples of the user's project):
//   - a relative markdown link target: [text](references/details.md), [x](../wsh-y/SKILL.md)
//   - a references/ | scripts/ | assets/ | templates/ path, backticked or bare
//   - an @file.md include and a backticked bare file name such as `root-cause-tracing.md`

const pluginRoot = fileURLToPath(new URL("../plugin/", import.meta.url));
const builtinsRoot = join(pluginRoot, "builtins");

// Names that are not files of the builtin (the skill tells the user to create them).
const NOT_A_FILE = {
  "wsh-architecture-decision-records": ["template.md", "NNNN-title-with-dashes.md"] // ADR naming in the user's repo
};

// Dangling pointers owned by other tracks (2026-11-10). Each entry must still dangle: delete it
// when the file ships or the pointer is fixed, so the list only shrinks.
// Empty since the superpowers v7.0.2 refresh shipped every sp-* supporting file. Add an entry only
// with a dated reason; the test fails once a listed entry resolves, so the list can only shrink.
const KNOWN_DANGLING = {};

export function relativePointers(markdown) {
  const out = new Set();
  let fence = null;
  for (const raw of markdown.split("\n")) {
    const open = raw.match(/^\s*(```+|~~~+)/);
    if (open) {
      if (!fence) fence = open[1][0];
      else if (open[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    for (const m of raw.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      const target = m[1].split("#")[0];
      if (target && !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(m[1])) out.add(target);
    }
    // Link targets are handled above; drop them so their labels and URLs are not re-read.
    const line = raw.replace(/\[[^\]]*\]\([^)]*\)/g, " ");
    for (const m of line.matchAll(/(?:^|[\s`("'*])((?:\.\/)?(?:references|scripts|assets|templates)\/[\w./-]*\w)/g)) out.add(m[1]);
    for (const m of line.matchAll(/(?:^|\s)@([\w./-]+\.md)\b/g)) out.add(m[1]);
    for (const m of line.matchAll(/`([\w.-]+\.md)`/g)) out.add(m[1]);
  }
  return [...out];
}

async function present(path) {
  try { await access(path); return true; } catch { return false; }
}

const builtins = (await readdir(builtinsRoot, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort();

test("every relative file a builtin SKILL.md points at ships in the plugin", async () => {
  const missing = [];
  const stillDangling = [];
  for (const id of builtins) {
    const skillPath = join(builtinsRoot, id, "SKILL.md");
    if (!(await present(skillPath))) continue;
    for (const target of relativePointers(await readFile(skillPath, "utf8"))) {
      if ((NOT_A_FILE[id] || []).includes(target)) continue;
      const abs = resolve(builtinsRoot, id, target);
      const inside = !relative(pluginRoot, abs).startsWith("..") && !relative(pluginRoot, abs).split(sep).includes("..");
      const ok = inside && (await present(abs));
      if ((KNOWN_DANGLING[id] || []).includes(target)) { if (ok) stillDangling.push(`${id}: ${target}`); continue; }
      if (!ok) missing.push(`plugin/builtins/${id}/SKILL.md -> ${target}`);
    }
  }
  assert.deepEqual(missing, [], `SKILL.md points at files the plugin does not ship:\n${missing.join("\n")}`);
  assert.deepEqual(stillDangling, [], `these KNOWN_DANGLING entries now resolve; delete them from the list:\n${stillDangling.join("\n")}`);
});

test("every relative file a wsh-* reference links ships beside it", async () => {
  // Reference files are loaded on demand by the skill; a link inside one must resolve too.
  const missing = [];
  for (const id of builtins.filter(b => b.startsWith("wsh-"))) {
    const dir = join(builtinsRoot, id, "references");
    const files = await readdir(dir).catch(() => []);
    for (const name of files.filter(f => f.endsWith(".md"))) {
      const text = await readFile(join(dir, name), "utf8");
      for (const m of text.matchAll(/\]\(\s*([^)\s]+)\s*\)/g)) {
        const target = m[1].split("#")[0];
        if (!target || /^([a-z][a-z0-9+.-]*:|\/|#)/i.test(m[1])) continue;
        if (!(await present(resolve(dir, target)))) missing.push(`plugin/builtins/${id}/references/${name} -> ${target}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test("relativePointers reads prose pointers and skips fenced examples", () => {
  const md = [
    "Read `references/details.md` and see [more](references/more.md#x) or [web](https://x.y/z.md).",
    "Use @testing-anti-patterns.md and `root-cause-tracing.md`; [`advanced.md`](https://e.x/a.md).",
    "```bash", "./scripts/run-sast.sh", "cat references/inside-fence.md", "```",
    "See [sibling](../wsh-other/SKILL.md)."
  ].join("\n");
  assert.deepEqual(relativePointers(md).sort(), [
    "../wsh-other/SKILL.md", "references/details.md", "references/more.md", "root-cause-tracing.md", "testing-anti-patterns.md"
  ]);
});
