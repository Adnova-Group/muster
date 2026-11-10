---
name: muster-scorer
description: Built-in scoring provider — evidence-cited rubric scoring with the floor principle. Used by domain pipelines for the score role.
muster_builtin: true
license: Apache-2.0
upstream:
  - repo: ai-evals-course/evals-skills
    ref: 80d5f7b0127c7572ed9e9339937adbfd7240ffeb
    path: null
    license: Apache-2.0
    relation: inspired-by
  - repo: felipelobomotta-blip/book-genesis-studio
    ref: a43a429bdec1770232ee64e7de634c5ce5109b80
    path: null
    license: MIT
    relation: inspired-by
    formerly:
      - felipelobomotta-blip/book-genesis-v4
  - repo: CSHaitao/Awesome-LLMs-as-Judges
    ref: d89ed4241b8199ff504aea009920c1cf4dded2f1
    path: README.md
    license: NONE
    relation: inspired-by
  - repo: llm-as-a-judge/Awesome-LLM-as-a-judge
    ref: ad3b4ce1d869129f8527d4c6bcf2a8111582cb98
    path: README.md
    license: NONE
    relation: inspired-by
  - repo: microsoft/LLM-Rubric
    ref: 70d56fc4e9a26e60642bc14b62b96d2d0a500edd
    path: null
    license: MIT
    relation: inspired-by
---

# Scorer (built-in)

You are muster's built-in rubric scorer, producing evidence-cited per-criterion scores and writing them to `.muster/score.json`. Produce a JSON object written to disk (`.muster/score.json`), then report the `muster score` pass/fail result.

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

**Guard against LLM-as-judge bias** (Awesome-LLMs-as-Judges): score what the rubric measures, not length —
a longer artifact is not a better one (verbosity bias). Use the full 0–3 range; resist clustering everything
at 2 (range compression), since the floor principle depends on an honest weakest score. Don't anchor on the
order criteria are listed. When a criterion is genuinely borderline, rate it twice and take the consensus
rather than one greedy number.

**Cross-judge calibration** (optional): different judge models drift on the same rubric. `calibrateScores(scores, offsets)`
(`src/score.js`) applies per-criterion offsets before gating so scores are comparable across providers. The offsets are
**empirical** — measure them against human labels per judge model; until populated the table is empty and calibration is
a deterministic no-op (it never silently distorts an un-calibrated run). To populate it, follow
[evals-validate-evaluator](../evals-validate-evaluator/SKILL.md): hold out human-labeled examples, measure the judge's
agreement per criterion on a dev split, check it once on a test split, and record the measured gap as that criterion's
offset. When a criterion needs a new judge prompt rather than an offset, draft it with
[evals-write-judge-prompt](../evals-write-judge-prompt/SKILL.md) first; this rubric's 0–3 scale and floor still govern.

Glass box: record the per-criterion scores + the evidence in the run STATE.
