import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySteer } from "../src/steer.js";

// --- each action from a representative message ---

test("stop: 'please stop the run' -> stop (explicit halt is the safest first action)", () => {
  assert.deepEqual(classifySteer("please stop the run"), { action: "stop" });
});
test("stop: 'halt the process' -> stop", () => {
  assert.deepEqual(classifySteer("halt the process"), { action: "stop" });
});
test("stop: 'abort!' -> stop", () => {
  assert.deepEqual(classifySteer("abort!"), { action: "stop" });
});
test("stop: 'cancel that' -> stop", () => {
  assert.deepEqual(classifySteer("cancel that"), { action: "stop" });
});
test("stop: 'pause for now' -> stop", () => {
  assert.deepEqual(classifySteer("pause for now"), { action: "stop" });
});
test("stop: 'hold on' -> stop", () => {
  assert.deepEqual(classifySteer("hold on"), { action: "stop" });
});

test("retarget: 'do the auth task instead' -> retarget (scope change must not be silently approved)", () => {
  assert.deepEqual(classifySteer("do the auth task instead"), { action: "retarget" });
});
test("retarget: 'retarget to the billing module' -> retarget", () => {
  assert.deepEqual(classifySteer("retarget to the billing module"), { action: "retarget" });
});
test("retarget: 'redirect to the login flow' -> retarget", () => {
  assert.deepEqual(classifySteer("redirect to the login flow"), { action: "retarget" });
});
test("retarget: 'switch to the new branch' -> retarget", () => {
  assert.deepEqual(classifySteer("switch to the new branch"), { action: "retarget" });
});
test("retarget: 'change scope to auth' -> retarget", () => {
  assert.deepEqual(classifySteer("change scope to auth"), { action: "retarget" });
});
test("retarget: 'also do the tests' -> retarget", () => {
  assert.deepEqual(classifySteer("also do the tests"), { action: "retarget" });
});
test("retarget: 'rescope to performance' -> retarget", () => {
  assert.deepEqual(classifySteer("rescope to performance"), { action: "retarget" });
});

test("approve: 'approve and continue' -> approve (advance the work)", () => {
  assert.deepEqual(classifySteer("approve and continue"), { action: "approve" });
});
test("approve: 'approved' -> approve", () => {
  assert.deepEqual(classifySteer("approved"), { action: "approve" });
});
test("approve: 'proceed with that' -> approve", () => {
  assert.deepEqual(classifySteer("proceed with that"), { action: "approve" });
});
test("approve: 'lgtm' -> approve", () => {
  assert.deepEqual(classifySteer("lgtm"), { action: "approve" });
});
test("approve: 'go ahead' -> approve", () => {
  assert.deepEqual(classifySteer("go ahead"), { action: "approve" });
});
test("approve: 'ship it' -> approve", () => {
  assert.deepEqual(classifySteer("ship it"), { action: "approve" });
});
test("approve: 'yes' -> approve", () => {
  assert.deepEqual(classifySteer("yes"), { action: "approve" });
});
test("approve: 'ok' -> approve", () => {
  assert.deepEqual(classifySteer("ok"), { action: "approve" });
});
test("approve: 'okay sounds good' -> approve", () => {
  assert.deepEqual(classifySteer("okay sounds good"), { action: "approve" });
});

test("status: 'what\\'s the status?' -> status (informational, lowest priority)", () => {
  assert.deepEqual(classifySteer("what's the status?"), { action: "status" });
});
test("status: 'any progress?' -> status", () => {
  assert.deepEqual(classifySteer("any progress?"), { action: "status" });
});
test("status: 'give me an update' -> status", () => {
  assert.deepEqual(classifySteer("give me an update"), { action: "status" });
});
test("status: 'show me the checklist' -> status", () => {
  assert.deepEqual(classifySteer("show me the checklist"), { action: "status" });
});
test("status: 'where are we?' -> status", () => {
  assert.deepEqual(classifySteer("where are we?"), { action: "status" });
});
test("status: 'how\\'s it going' -> status", () => {
  assert.deepEqual(classifySteer("how's it going"), { action: "status" });
});
test("status: 'how is it going' -> status", () => {
  assert.deepEqual(classifySteer("how is it going"), { action: "status" });
});

// --- word-boundary safety: partial matches must not fire ---

test("word-boundary: 'stopwatch feature' must NOT match stop (substring is not a whole word)", () => {
  assert.deepEqual(classifySteer("stopwatch feature"), { action: "unknown" });
});
test("word-boundary: 'statistics dashboard' must NOT match status (stat != status at word boundary)", () => {
  assert.deepEqual(classifySteer("statistics dashboard"), { action: "unknown" });
});
test("word-boundary: 'cancellation flow' must NOT match cancel", () => {
  assert.deepEqual(classifySteer("cancellation flow"), { action: "unknown" });
});

// --- precedence ---

test("precedence stop>retarget: 'stop, do X instead' -> stop (explicit halt honored before scope change)", () => {
  assert.deepEqual(classifySteer("stop, do X instead"), { action: "stop" });
});
test("precedence retarget>approve: 'approved, but switch to the other repo' -> retarget (scope change wins over approval)", () => {
  assert.deepEqual(classifySteer("approved, but switch to the other repo"), { action: "retarget" });
});
test("precedence stop>approve: 'yes please abort' -> stop", () => {
  assert.deepEqual(classifySteer("yes please abort"), { action: "stop" });
});
test("precedence retarget>status: 'give me an update and redirect to auth' -> retarget", () => {
  assert.deepEqual(classifySteer("give me an update and redirect to auth"), { action: "retarget" });
});
test("precedence approve>status: 'okay, what\\'s the status' -> approve (advance wins over informational)", () => {
  assert.deepEqual(classifySteer("okay, what's the status"), { action: "approve" });
});

// --- unknown / edge cases ---

test("unknown: empty string -> unknown", () => {
  assert.deepEqual(classifySteer(""), { action: "unknown" });
});
test("unknown: whitespace-only -> unknown", () => {
  assert.deepEqual(classifySteer("   "), { action: "unknown" });
});
test("unknown: null -> unknown (guard against non-string input)", () => {
  assert.deepEqual(classifySteer(null), { action: "unknown" });
});
test("unknown: number -> unknown (guard against non-string input)", () => {
  assert.deepEqual(classifySteer(42), { action: "unknown" });
});
test("unknown: undefined -> unknown (guard against non-string input)", () => {
  assert.deepEqual(classifySteer(undefined), { action: "unknown" });
});
test("unknown: no keyword match -> unknown", () => {
  assert.deepEqual(classifySteer("let's keep going with the original plan"), { action: "unknown" });
});
