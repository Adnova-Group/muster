// test/test-support-hook-helpers.test.js — unit coverage for the shared
// hook-test helpers that are not exercised through a spawned hook.
//
// uniqueSid (test-support/hook-helpers.js) is the per-run session-id isolator:
// every hook test that keys a HOST-GLOBAL os.tmpdir() marker path off its
// session id (the Codex hook's `muster-codex-border-*` files) derives that id
// from uniqueSid("<base>") instead of a fixed literal, so two concurrent
// full-suite runners never share a marker file. These tests pin the two
// properties every call site relies on: the result is (1) unique per call, and
// (2) filename-safe -- it survives a [A-Za-z0-9_-] session sanitizer
// byte-for-byte, so the derived marker path is exactly the intended one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { uniqueSid } from "./test-support/hook-helpers.js";

const sanitize = (sid) => sid.replace(/[^a-zA-Z0-9_-]/g, "");

test("uniqueSid: survives session sanitization unchanged (marker path stays exactly the sid)", () => {
  for (const base of ["border-flap", "e1-repro-a", "ss-cum-1", "sid"]) {
    const sid = uniqueSid(base);
    assert.equal(sanitize(sid), sid, "no character is stripped by sanitization");
    assert.match(sid, /^[A-Za-z0-9_-]+$/, "only filename-safe characters");
    assert.ok(sid.startsWith(`${base}-`), "keeps the human-readable base prefix");
  }
});

test("uniqueSid: distinct on every call, giving each run a private marker path", () => {
  const ids = new Set();
  for (let i = 0; i < 1000; i += 1) ids.add(uniqueSid("border"));
  assert.equal(ids.size, 1000, "1000 calls yield 1000 distinct sids");
});

test("uniqueSid: default base is filename-safe too", () => {
  const sid = uniqueSid();
  assert.equal(sanitize(sid), sid);
});
