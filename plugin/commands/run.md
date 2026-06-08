---
name: run
description: "Interactive router. Detects context, discovers capabilities, assembles the crew, and shows the glass-box Crew Manifest + plan, then STOPS for your approval. Plans and shows; does not execute (use /muster:autopilot to run it end to end). Usage: /muster:run <outcome>"
---

The user's outcome: `$ARGUMENTS`

If `$ARGUMENTS` is empty, ask for the outcome and stop — Muster never runs without a stated outcome.

1. Run `npx muster assess "$ARGUMENTS"` → `{ clear, signals }`. If `clear: false`, invoke the **interview**
   skill (the `signals` name the gaps) to enrich the outcome and gather `successCriteria` BEFORE detect/route.
   The interview's approved enriched outcome replaces `$ARGUMENTS` for the rest of this flow — it feeds the
   detect/capabilities/router steps below and is written (with `successCriteria`) into `.muster/manifest.json`.
   If `clear: true`, skip the interview and proceed.
2. Run `npx muster detect .` (pass the explicit path so a drifted cwd doesn't misdetect) and
   `npx muster capabilities`. Capture both JSON blobs.
3. Run `npx muster memory read .muster/memory "<key terms from the outcome>"` and skim any prior entries.
4. Invoke the **router** skill with the outcome, the two JSON blobs, and any memory hits.
5. The router emits a Crew Manifest. Write it to `.muster/manifest.json`, then validate:
   `npx muster manifest validate .muster/manifest.json` — repair and re-validate until `ok: true`.
6. Show the manifest to the user (the Glass Box) and collect approval via the **AskUserQuestion** selection UI
   with options **Approve & run** (hands off to `/muster:autopilot`) / **Adjust the plan** (loop back to the
   router) / **Cancel**. This command plans and shows; it does not execute the plan itself.
7. Optionally append a memory entry: `npx muster memory write .muster/memory <entry.json>`.
