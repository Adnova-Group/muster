// run-5 security audit Low #12 (src/codex-install.js): a hook runtime path that
// carries a control character -- newline, carriage return, or NUL -- must be
// rejected BEFORE any managed hook/profile/manifest file is written. Such a
// character in the resolved `.codex/muster/hooks/muster-hook.mjs` command token
// could break out of the generated hooks.json `command` string or enable
// command injection on every Codex lifecycle event, so `muster install codex`
// must fail closed at preparation time and leave the filesystem untouched.
//
// These fixtures PIN the already-present rejection (no src change accompanies
// them); they exercise the REAL rejection path per character:
//   * \n and \r are rejected by muster's own control-char guard in
//     `shellCommand` (`/[\r\n\0]/`), which throws while `prepareHooks` is still
//     assembling the command -- strictly before the write transaction.
//   * \0 (NUL) is rejected earlier still, at the Node fs boundary
//     (`ERR_INVALID_ARG_VALUE`, "path ... without null bytes") the first time a
//     path syscall touches the cwd-derived config dir (`ordinaryDirectoryPath`
//     -> `lstat`), before `shellCommand`'s guard is even reached. Node forbids
//     null bytes in path arguments, so the fs layer -- not a muster guard --
//     is what stops it; the guard would also reject it if reached. Either way
//     the rejection precedes every managed write, which is the invariant these
//     tests protect.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodexInstall } from "../src/codex-install.js";
import { repoRoot } from "../test-support/codex-helpers.js";

// Codex is treated as absent so the install skips the marketplace/plugin build
// yet still runs its full write transaction (registry + profiles + hooks.json +
// manifest) when not blocked -- exactly as test/codex-hook-node-pin.test.js does.
const absent = async () => { throw new Error("not found"); };

// The managed artifacts a successful project install writes under `<cwd>/.codex`.
// None of these may exist after a control-char rejection.
function managedArtifacts(cwd) {
  const configDir = join(cwd, ".codex");
  return {
    configDir,
    agents: join(configDir, "agents"),
    hooksJson: join(configDir, "hooks.json"),
    manifest: join(configDir, "muster", ".muster-managed.json"),
    hookRuntime: join(configDir, "muster", "hooks", "muster-hook.mjs")
  };
}

const CONTROL_CHARS = [
  {
    label: "newline (\\n)",
    ch: "\n",
    rejectedBy: "muster shellCommand control-char guard",
    matches: error => /unsupported control characters/.test(error.message)
  },
  {
    label: "carriage return (\\r)",
    ch: "\r",
    rejectedBy: "muster shellCommand control-char guard",
    matches: error => /unsupported control characters/.test(error.message)
  },
  {
    label: "NUL (\\0)",
    ch: "\0",
    rejectedBy: "Node fs null-byte boundary (before the muster guard)",
    // Pins the CURRENT reality: the Node fs layer throws ERR_INVALID_ARG_VALUE
    // ("without null bytes") before the muster guard is reached. Kept specific
    // to that boundary on purpose -- if a future change ever routes NUL through
    // muster's own guard instead, this SHOULD fail so the fs-boundary claim in
    // the header comment gets re-verified rather than silently drifting green.
    matches: error =>
      error.code === "ERR_INVALID_ARG_VALUE"
      || /null byte/i.test(error.message)
  }
];

// Positive control: with a clean config-dir path, the very same install
// (identical repoRoot / absent Codex) DOES write the managed artifacts. This
// proves the harness is capable of writing them here, so the "no managed write"
// assertions below register the control-char guard's effect -- not a harness
// that never writes anything.
test("Codex install writes the managed hook artifacts when the config dir path is clean (positive control)", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-ctrlchar-ok-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home");
  await runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absent });
  const artifacts = managedArtifacts(cwd);
  assert.ok(existsSync(artifacts.hooksJson), "clean install must write .codex/hooks.json");
  assert.ok(existsSync(artifacts.manifest), "clean install must write the hook manifest");
  assert.ok(existsSync(artifacts.hookRuntime), "clean install must write the hook runtime script");
  assert.ok(existsSync(artifacts.agents), "clean install must write the .codex/agents profiles dir");
});

for (const { label, ch, rejectedBy, matches } of CONTROL_CHARS) {
  test(`Codex install rejects ${label} in the hook runtime path before any managed write (via ${rejectedBy})`, async () => {
    const tmp = await mkdtemp(join(tmpdir(), "muster-codex-ctrlchar-"));
    // The control char rides in `cwd`, so it lands in the resolved config dir
    // (`<cwd>/.codex`) AND the hook runtime path (`.../muster/hooks/muster-hook.mjs`).
    const cwd = join(tmp, `pro${ch}ject`), home = join(tmp, "home");

    await assert.rejects(
      () => runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absent }),
      error => {
        assert.ok(error instanceof Error, `expected an Error, got ${error}`);
        assert.ok(
          matches(error),
          `rejection for ${label} did not match the expected path (${rejectedBy}); got: ${error.code || ""} ${error.message}`
        );
        return true;
      }
    );

    // Pre-write invariant: no managed file/dir was created at the config dir.
    // (The throw precedes the entire write transaction, so `.codex` itself is
    // never even created -- assert the individual managed targets the task
    // names, plus the parent, so any partial write would fail this.)
    const artifacts = managedArtifacts(cwd);
    assert.ok(!existsSync(artifacts.agents), `no .codex/agents may be written for ${label}`);
    assert.ok(!existsSync(artifacts.hooksJson), `no .codex/hooks.json may be written for ${label}`);
    assert.ok(!existsSync(artifacts.manifest), `no hook manifest may be written for ${label}`);
    assert.ok(!existsSync(artifacts.hookRuntime), `no hook runtime script may be written for ${label}`);
    assert.ok(!existsSync(artifacts.configDir), `.codex must not be created for ${label}`);
  });
}
