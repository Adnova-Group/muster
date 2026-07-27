// ───────────────────────────────────────────────────────────────────────────
// Kimi-native steer delivery: the steer queue, driven over `kimi web`'s HTTP API
//
// Kimi's agent loop has a native seam for muster's "inject a correction without
// restarting" pattern (docs/research/kimi-code-cli.md sec 1, "Steer"): user
// interjections queue in the steer queue and inject BETWEEN STEPS without
// ending the turn. The documented surfaces into that queue:
//
//   TUI Ctrl-S    -- interactive only; a muster `kimi -p` run has no TUI
//   Wire `steer`  -- gen1 kimi-cli only (JSON-RPC-2.0 over stdio); gen2
//                    replaced Wire with ACP + `kimi web`
//   ACP mid-turn  -- gen2's protocol surface (`kimi acp`); muster does not
//                    speak ACP today
//
// The drivable gen2 surface is `kimi web`'s HTTP API. EVIDENCE NOTE. The route
// shapes below are read from the shipped kimi binary's own route definitions
// (v0.29.x, unstripped), the same evidence posture as src/kimi-dispatch.js --
// where the published docs name a seam without giving its shape, the binary is
// what actually runs:
//
//   POST /sessions/{session_id}/prompts          submitRoute -- enqueue a user
//                                                message; the response carries
//                                                the prompt handle (promptId)
//   POST /sessions/{session_id}/prompts::steer   steerManyRoute, described in
//                                                the binary verbatim as "Steer
//                                                queued prompts into the
//                                                active turn"; body
//                                                {prompt_ids: [...]}
//
// so delivery is two requests: submit the correction as a queued prompt, then
// steer that prompt id into the active turn, where it injects at the next step
// boundary -- the turn keeps running.
//
// THE HONEST LIMIT. muster's own run loop launches Kimi as a one-shot
// `kimi -p "/goal ..."` and holds no live session handle, so this module
// CONSTRUCTS the native delivery for the driver that does hold one (an
// attached `kimi web` operator, an ACP client, or the TUI user at Ctrl-S) --
// it does not open the connection itself. Same posture as the classifier it
// sits next to: muster steer decides WHAT the message means and HOW it must be
// delivered; the harness-side driver performs the send.
// ───────────────────────────────────────────────────────────────────────────

// The seam, named exactly the way docs/research/kimi-code-cli.md sec 1
// documents it. Prose and tests pin this string -- rename it in all three.
export const KIMI_STEER_SEAM =
  "Kimi's steer queue: queued injection between steps without ending the turn";

// Verbatim route templates from the shipped binary's route definitions.
export const KIMI_STEER_SUBMIT_PATH = "/sessions/{session_id}/prompts";
export const KIMI_STEER_STEER_PATH = "/sessions/{session_id}/prompts::steer";

// Placeholder used in the steer request body when the caller does not yet have
// the submit response's prompt id (the common case: construction happens
// before the submit request is sent).
export const KIMI_STEER_PROMPT_ID_PLACEHOLDER = "<promptId from the submit response>";

// Build the native steer delivery for a correction message: the seam it rides,
// every documented surface into that queue, and the concrete two-request
// `kimi web` delivery (submit the message as a queued prompt, then steer that
// prompt id into the active turn).
//
// `sessionId` / `promptId` are optional: a driver that already knows the live
// session gets concrete paths; without them the binary's own `{session_id}`
// route template and the prompt-id placeholder are carried through, so the
// constructed delivery is still exactly what the driver fills in and sends.
export function kimiSteerDelivery({ message, sessionId, promptId } = {}) {
  if (typeof message !== "string" || !message.trim()) {
    throw new Error("kimiSteerDelivery: message is required (the correction text to inject between steps)");
  }
  if (sessionId !== undefined && (typeof sessionId !== "string" || !sessionId)) {
    throw new Error("kimiSteerDelivery: sessionId must be the live Kimi session id (a non-empty string)");
  }
  if (promptId !== undefined && (typeof promptId !== "string" || !promptId)) {
    throw new Error("kimiSteerDelivery: promptId must be the queued prompt's id from the submit response (a non-empty string)");
  }
  const sid = sessionId ?? "{session_id}";
  return {
    seam: KIMI_STEER_SEAM,
    message,
    // Every surface docs/research/kimi-code-cli.md documents into the steer
    // queue, with its drivability from muster's side stated plainly.
    surfaces: {
      tui: "Ctrl-S (interactive TUI only -- a `kimi -p` run has no TUI)",
      wire: "Wire `steer` (gen1 kimi-cli only; gen2 replaced Wire with ACP + `kimi web`)",
      acp: "ACP mid-turn injection (`kimi acp`; muster does not speak ACP today)",
      kimiWeb: "`kimi web` HTTP: POST /sessions/{session_id}/prompts then POST /sessions/{session_id}/prompts::steer (routes read from the shipped binary)"
    },
    requests: [
      {
        step: "submit",
        method: "POST",
        path: `/sessions/${sid}/prompts`,
        body: { content: [{ type: "text", text: message }] }
      },
      {
        step: "steer",
        method: "POST",
        path: `/sessions/${sid}/prompts::steer`,
        // The binary's steerManyRoute: "Steer queued prompts into the active
        // turn" -- this is the request that lands the message in the steer
        // queue for injection at the next step boundary.
        body: { prompt_ids: [promptId ?? KIMI_STEER_PROMPT_ID_PLACEHOLDER] }
      }
    ]
  };
}
