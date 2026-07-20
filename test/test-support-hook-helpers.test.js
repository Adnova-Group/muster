// test/test-support-hook-helpers.test.js — unit coverage for the shared
// hook-test helpers that are not exercised through a spawned hook.
//
// uniqueSid (test-support/hook-helpers.js) is the per-run session-id isolator:
// every hook test that keys a HOST-GLOBAL os.tmpdir() marker path off its
// session id derives that id from uniqueSid("<base>") instead of a fixed
// literal, so two concurrent full-suite runners never share a marker file.
// These tests pin the two properties every call site relies on: the result is
// (1) unique per call, and (2) safeSession-safe -- it survives inline-budget's
// filename sanitizer byte-for-byte, so the derived marker path is exactly the
// intended one and never collapses to null.

import { test } from "node:test";
import assert from "node:assert/strict";
import { uniqueSid } from "./test-support/hook-helpers.js";
import { safeSession, cumFile } from "../plugin/hooks/inline-budget.js";

test("uniqueSid: survives safeSession unchanged (marker path stays exactly the sid)", () => {
  for (const base of ["border-flap", "e1-repro-a", "ss-cum-1", "sid"]) {
    const sid = uniqueSid(base);
    assert.equal(safeSession(sid), sid, "no character is stripped by safeSession");
    assert.match(sid, /^[A-Za-z0-9_-]+$/, "only filename-safe characters");
    assert.ok(sid.startsWith(`${base}-`), "keeps the human-readable base prefix");
  }
});

test("uniqueSid: distinct on every call, giving each run a private marker path", () => {
  const ids = new Set();
  for (let i = 0; i < 1000; i += 1) ids.add(uniqueSid("border"));
  assert.equal(ids.size, 1000, "1000 calls yield 1000 distinct sids");

  // The whole point: distinct sids => distinct HOST-GLOBAL marker paths.
  const a = uniqueSid("border");
  const b = uniqueSid("border");
  assert.notEqual(cumFile(a, "/tmp"), cumFile(b, "/tmp"), "distinct cumFile paths");
});

test("uniqueSid: default base is safeSession-safe too", () => {
  const sid = uniqueSid();
  assert.equal(safeSession(sid), sid);
});
