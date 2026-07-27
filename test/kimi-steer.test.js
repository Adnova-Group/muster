// Kimi-native steer binding (kimi-native-steer-binding item).
// The Kimi arm of `muster steer` constructs the native steer delivery --
// queued injection between steps without ending the turn (docs/research/
// kimi-code-cli.md sec 1 "Steer") -- while every non-Kimi steer path stays
// byte-identical to today. Route shapes are pinned to the shipped kimi
// binary's own route definitions (v0.29.x): submitRoute
// POST /sessions/{session_id}/prompts and steerManyRoute
// POST /sessions/{session_id}/prompts::steer ("Steer queued prompts into the
// active turn").
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import {
  kimiSteerDelivery,
  KIMI_STEER_SEAM,
  KIMI_STEER_SUBMIT_PATH,
  KIMI_STEER_STEER_PATH,
  KIMI_STEER_PROMPT_ID_PLACEHOLDER
} from "../src/kimi-steer.js";
import { classifySteer } from "../src/steer.js";

const pexec = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

// --- the seam is named exactly ------------------------------------------------

test("the seam constant names the documented mechanism exactly", () => {
  assert.equal(KIMI_STEER_SEAM, "Kimi's steer queue: queued injection between steps without ending the turn");
  assert.equal(KIMI_STEER_SUBMIT_PATH, "/sessions/{session_id}/prompts");
  assert.equal(KIMI_STEER_STEER_PATH, "/sessions/{session_id}/prompts::steer");
});

// --- delivery construction ----------------------------------------------------

test("kimiSteerDelivery: builds the two-request native delivery (submit, then steer into the active turn)", () => {
  const d = kimiSteerDelivery({ message: "hold the deploy wave" });
  assert.equal(d.seam, KIMI_STEER_SEAM);
  assert.equal(d.message, "hold the deploy wave");
  assert.equal(d.requests.length, 2);

  const [submit, steer] = d.requests;
  assert.deepEqual(submit, {
    step: "submit",
    method: "POST",
    path: "/sessions/{session_id}/prompts",
    body: { content: [{ type: "text", text: "hold the deploy wave" }] }
  });
  assert.deepEqual(steer, {
    step: "steer",
    method: "POST",
    path: "/sessions/{session_id}/prompts::steer",
    body: { prompt_ids: [KIMI_STEER_PROMPT_ID_PLACEHOLDER] }
  });
});

test("kimiSteerDelivery: a known session/prompt id produces concrete paths and body", () => {
  const d = kimiSteerDelivery({ message: "stop", sessionId: "sess-123", promptId: "p-9" });
  assert.equal(d.requests[0].path, "/sessions/sess-123/prompts");
  assert.equal(d.requests[1].path, "/sessions/sess-123/prompts::steer");
  assert.deepEqual(d.requests[1].body, { prompt_ids: ["p-9"] });
});

test("kimiSteerDelivery: names every documented surface into the steer queue", () => {
  const { surfaces } = kimiSteerDelivery({ message: "status?" });
  assert.match(surfaces.tui, /Ctrl-S/);
  assert.match(surfaces.wire, /Wire `steer`.*gen1/);
  assert.match(surfaces.acp, /ACP mid-turn/);
  assert.match(surfaces.kimiWeb, /kimi web.*POST \/sessions\/\{session_id\}\/prompts::steer/s);
});

test("kimiSteerDelivery: validates its inputs loud, before any delivery is built", () => {
  assert.throws(() => kimiSteerDelivery(), /message is required/);
  assert.throws(() => kimiSteerDelivery({ message: "" }), /message is required/);
  assert.throws(() => kimiSteerDelivery({ message: "   " }), /message is required/);
  assert.throws(() => kimiSteerDelivery({ message: 42 }), /message is required/);
  assert.throws(() => kimiSteerDelivery({ message: "x", sessionId: "" }), /sessionId must be/);
  assert.throws(() => kimiSteerDelivery({ message: "x", promptId: 7 }), /promptId must be/);
});

// --- the CLI arm: harness-conditional ------------------------------------------

test("muster steer --harness kimi: classification composes with the native delivery", async () => {
  const { stdout } = await pexec("node", [CLI, "steer", "--harness", "kimi", "please stop the run"]);
  const result = JSON.parse(stdout);
  assert.equal(result.action, "stop");
  assert.equal(result.harness, "kimi");
  assert.equal(result.delivery.seam, KIMI_STEER_SEAM);
  assert.equal(result.delivery.requests[1].path, "/sessions/{session_id}/prompts::steer");
  assert.deepEqual(result.delivery.requests[0].body, { content: [{ type: "text", text: "please stop the run" }] });
});

test("muster steer --harness kimi: --session and --prompt-id concretize the delivery", async () => {
  const { stdout } = await pexec("node", [CLI, "steer", "retarget to auth", "--harness", "kimi", "--session", "sess-1", "--prompt-id", "p-2"]);
  const result = JSON.parse(stdout);
  assert.equal(result.action, "retarget");
  assert.equal(result.delivery.requests[0].path, "/sessions/sess-1/prompts");
  assert.deepEqual(result.delivery.requests[1].body, { prompt_ids: ["p-2"] });
});

test("muster steer --harness kimi: a missing message fails loud", async () => {
  await assert.rejects(
    pexec("node", [CLI, "steer", "--harness", "kimi"]),
    (err) => {
      assert.match(err.stderr, /missing message/);
      return true;
    }
  );
});

// --- non-Kimi steer paths are byte-identical to today --------------------------
// Today `muster steer <anything>` prints JSON.stringify(classifySteer(raw args),
// null, 2) -- no flag parsing at all, so even a `--harness <other>` token pair is
// classified as message text. These tests pin that exact stdout for the no-flag
// invocation and for each non-Kimi harness token, proving the binding added a
// Kimi-only branch without touching any existing path.

const baseline = (msg) => JSON.stringify(classifySteer(msg), null, 2) + "\n";

test("byte-identical: bare steer output matches the pre-binding classifier output exactly", async () => {
  for (const msg of ["approve", "please stop the run", "hello world", "where are we?"]) {
    const { stdout } = await pexec("node", [CLI, "steer", msg]);
    assert.equal(stdout, baseline(msg), `bare steer output for ${JSON.stringify(msg)} must be byte-identical`);
  }
});

test("byte-identical: --harness <claude-code|codex|hermes> is still classified as message text (today's behavior)", async () => {
  for (const harness of ["claude-code", "codex", "hermes"]) {
    const args = ["steer", "approve", "--harness", harness];
    const { stdout } = await pexec("node", [CLI, ...args]);
    // No Kimi branch may fire: the raw joined args classify exactly as today,
    // and the output carries no harness/delivery fields.
    assert.equal(stdout, baseline("approve --harness " + harness), `${harness} steer path must be byte-identical`);
    const result = JSON.parse(stdout);
    assert.deepEqual(Object.keys(result), ["action"], `${harness} output must carry only the action field`);
  }
});

// --- prose wiring: the orchestrator skill names the seam exactly ----------------

test("orchestrator/SKILL.md's Channel steering section carries the Kimi steer-seam paragraph", async () => {
  const text = await readFile(new URL("../plugin/skills/orchestrator/SKILL.md", import.meta.url), "utf8");
  const start = text.indexOf("## Channel steering (remote)");
  assert.ok(start >= 0, "orchestrator/SKILL.md must carry the Channel steering section");
  const section = text.slice(start, text.indexOf("\n## ", start + 1));
  const kstart = section.indexOf("**On Kimi the same message arrives through the harness's native steer seam.**");
  assert.ok(kstart >= 0, "the Channel steering section must carry the Kimi steer-seam paragraph");
  const paragraph = section.slice(kstart);
  // the seam, named exactly as the research documents it
  assert.match(paragraph, /steer queue/, "the paragraph must name the steer queue");
  assert.match(paragraph, /BETWEEN STEPS without ending the\s+turn/, "the paragraph must state the between-steps injection exactly");
  assert.match(paragraph, /docs\/research\/kimi-code-cli\.md sec 1 "Steer"/, "the paragraph must cite the research section");
  // every documented surface, and the shipped-binary routes
  assert.match(paragraph, /Ctrl-S/, "the paragraph must name the TUI Ctrl-S surface");
  assert.match(paragraph, /Wire `steer`/, "the paragraph must name the Wire steer surface");
  assert.match(paragraph, /ACP mid-turn/, "the paragraph must name the ACP mid-turn surface");
  assert.match(paragraph, /POST \/sessions\/\{session_id\}\/prompts::steer/, "the paragraph must name the exact kimi web steer route");
  // the shipped constructor and the honest limit
  assert.match(paragraph, /muster steer --harness kimi/, "the paragraph must name the Kimi arm of the steer command");
  assert.match(paragraph, /kimiSteerDelivery` in `src\/kimi-steer\.js/, "the paragraph must cite the shipped constructor");
  assert.match(paragraph, /does not open the connection itself/, "the paragraph must state the no-live-session-handle limit");
  // the existing behavior is explicitly unchanged
  assert.match(paragraph, /the action mapping is unchanged/, "the paragraph must state the action mapping is unchanged");
});
