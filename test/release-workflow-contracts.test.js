import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("remote issue text is byte-bounded and cannot close its data delimiter", async () => {
  for (const file of ["plugin/commands/plan.md", "plugin/commands/go.md", "plugin/commands/go-backlog.md"]) {
    const text = await read(file);
    assert.match(text, /16 KiB UTF-8 byte cap/i, `${file} must bound remote issue text`);
    assert.match(text, /case-insensitive literal `?<\/remote-text>`?.*`&lt;\/remote-text&gt;`/is,
      `${file} must neutralize closing remote-text tags before interpolation`);
    assert.match(text, /truncate at a UTF-8 code-point boundary/i, `${file} must not split UTF-8 while bounding text`);
  }
});

test("Approve & run binds go execution to the exact approved manifest digest", async () => {
  const plan = await read("plugin/commands/plan.md");
  assert.match(plan, /SHA-256 digest/i);
  assert.match(plan, /approved manifest digest/i);
  assert.match(plan, /byte-for-byte/i);
  assert.match(plan, /fresh approval/i);
  assert.match(plan, /rerout|amend/i);

  const go = await read("plugin/commands/go.md");
  assert.match(go, /approved manifest digest/i);
  assert.match(go, /recompute.*SHA-256|SHA-256.*recompute/is);
  assert.match(go, /mismatch.*fresh approval|fresh approval.*mismatch/is);
});

test("router output and backlog annotations cannot authorize local merge or push", async () => {
  const go = await read("plugin/commands/go.md");
  assert.match(go, /router output.*never authoriz/is);
  assert.match(go, /explicit authenticated user approval/i);
  assert.match(go, /merge-local.*merge-push/is);

  const backlog = await read("plugin/commands/go-backlog.md");
  assert.match(backlog, /backlog annotation.*never authoriz/is);
  assert.match(backlog, /explicit authenticated user approval/i);
  assert.doesNotMatch(backlog, /backlog annotation is the human's declaration/i);
});

test("every write-capable go path requires verified linked-worktree isolation", async () => {
  for (const file of ["plugin/commands/go.md", "plugin/commands/go-backlog.md"]) {
    const text = await read(file);
    assert.match(text, /verified isolated (?:git )?worktree/i, `${file} must require verified isolation`);
    assert.match(text, /git rev-parse --git-common-dir/i, `${file} must name the verification input`);
    assert.match(text, /git rev-parse --git-dir/i, `${file} must distinguish a linked worktree`);
    assert.match(text, /refuse|stop|abort/i, `${file} must fail closed`);
  }
  const go = await read("plugin/commands/go.md");
  assert.doesNotMatch(go, /a plain branch is fine otherwise/i);
});

test("go-backlog self-heals a primary-checkout launch into a verified driver worktree", async () => {
  const backlog = await read("plugin/commands/go-backlog.md");
  assert.match(backlog, /self-healing transition/i);
  assert.match(backlog, /git worktree list --porcelain/i);
  assert.match(backlog, /git worktree add/i);
  assert.match(backlog, /change every subsequent command's cwd to that driver/i);
  assert.match(backlog, /Continue the batch automatically/i);
  assert.match(backlog, /backlog-publish --expect <source digest>/i);
  assert.match(backlog, /reject symlinks, special files/i);
  assert.match(backlog, /never\s+delete, reset, or repurpose an existing path or branch/i);
  assert.doesNotMatch(
    backlog,
    /paths; if they do not, refuse all writes and stop\. A plain branch in the primary checkout/i,
    "primary-checkout detection must no longer be a fail-only terminal",
  );
});

test("the full CI suite fetches history required by pinned diff probes", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  const fullSuiteJob = workflow.split(/^  windows-smoke:/m)[0];
  assert.match(fullSuiteJob, /uses: actions\/checkout@v4\s+with:\s+(?:#[^\n]*\s+)*fetch-depth: 0/m);
});
