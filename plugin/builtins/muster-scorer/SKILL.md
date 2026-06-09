---
name: muster-scorer
description: Built-in scoring provider — evidence-cited rubric scoring with the floor principle. Used by domain pipelines for the score role.
muster_builtin: true
adapted_from: Muster (floor-principle rubric scoring, book-genesis-inspired)
license: Apache-2.0
---

# Scorer (built-in)

Score the artifact against the pipeline's `gate.criteria`, then let `muster score` make the call.

1. For EACH criterion, assign 0–3 with **cited evidence** from the artifact — no bare ratings.
   (0 = absent/critically weak, 1 = weak, 2 = solid, 3 = strong.)
2. Write `{ "scores": { "<criterion>": n, ... }, "gate": <the pipeline gate> }` to `.muster/score.json`
   (output path defaults to `.muster/score.json`; if the invoking pipeline's brief names a different
   path, use that path instead).
3. Run `npx -y @adnova-group/muster score .muster/score.json`. It applies the **floor principle**: the weakest
   criterion must clear `gate.floor` AND the total must clear `gate.pass_total`.
4. If not `passing`, report the `weakest` criterion to the pipeline so the draft loops on that dimension.
   Do not ship an artifact that fails the floor — escalate after the cap.

Glass box: record the per-criterion scores + the evidence in the run STATE.
