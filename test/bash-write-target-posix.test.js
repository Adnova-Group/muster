// Regression: bash-write-target.js must normalize redirect/tee/cp targets with
// POSIX semantics on every host. Claude Code's Bash tool runs a POSIX shell
// (Git Bash on Windows), so `/dev/null` is a POSIX path everywhere. Platform
// path.normalize() on Windows rewrote it to `\dev\null`, the exemption regex
// never matched, and read-only commands like `ls 2>/dev/null` were counted as
// inline file writes. This file also runs in the Windows CI job.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { bashWriteTarget } from "../plugin/hooks/bash-write-target.js";

const SRC = fileURLToPath(new URL("../plugin/hooks/bash-write-target.js", import.meta.url));

test("bash-write-target: no platform-dependent path.normalize call", () => {
  const code = fs
    .readFileSync(SRC, "utf8")
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(
    code,
    /\bpath\.normalize\(/,
    "use path.posix.normalize: platform normalize turns /dev/null into \\dev\\null on Windows",
  );
});

test("bash-write-target: exempt POSIX targets stay exempt on this host", () => {
  for (const cmd of [
    "ls 2>/dev/null",
    "git status > /dev/null",
    "echo x > /tmp/out.txt",
    "echo x >> .muster/STATE.md",
    "cmd | tee /dev/stderr",
    "cmd | tee -a .muster/log.txt",
    "cp a.json /tmp/a.json",
    "mv x .muster/x",
  ]) {
    assert.equal(bashWriteTarget(cmd), null, cmd);
  }
});

test("bash-write-target: traversal out of an exempt dir is still a write", () => {
  assert.equal(bashWriteTarget("echo x > .muster/../app.js"), "> .muster/../app.js");
  assert.equal(bashWriteTarget("cmd | tee /tmp/../etc/x"), "tee /tmp/../etc/x");
  assert.equal(bashWriteTarget("cp a .muster/../src/a.js"), "cp .muster/../src/a.js");
});
