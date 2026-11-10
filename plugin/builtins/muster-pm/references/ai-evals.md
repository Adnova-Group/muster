# AI behavior evals in a spec

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001, GUARD-IDK-001: reference read inside the muster-pm builtin, which supplies the role and output format; it teaches how to write eval rows and answers no questions itself. -->

Read this when a model output is part of the feature: it classifies, drafts, decides, answers or
calls tools. The SPEC's `## AI behavior and evals` table is where that behavior becomes
checkable. Without it, the verifier has nothing to hold a model to except "it looked fine".

Skip the section for a deterministic feature. A property a deterministic check can decide (a
required field is present, a count matches, a value is in range) does not need an EV row just
because a model produced the output: write it as an ordinary acceptance criterion with
`verify: test`. EV rows are for behavior that varies run to run.

## What an EV row is

One row per behavior the model must get right. Each row fixes four things before anyone runs it:

| Column | Holds | Bad | Good |
|---|---|---|---|
| Behavior required | one observable behavior | "handles refunds well" | "classifies the refund reason into one of 6 codes" |
| Eval method | how one case is judged | "LLM rates quality 1-10" | "exact match against a labeled set", "binary judge calibrated on 20 human labels" |
| Pass rule | the bar, as a number | "high accuracy", "most cases" | "≥190/200 exact", "30/30 refuse" |
| Case set | where the cases live | "we'll collect some" | `evals/refunds/reason.jsonl` |

`muster spec-lint` blocks an EV row whose pass rule has no number.

## Rules

1. **Binary per case.** Each case passes or fails. A 1-10 score hides disagreement and drifts
   between graders; a pass/fail call with a written reason can be checked by a person.
2. **Pass rules are fixed up front for behaviors you already know matter.** Policy, refusal,
   safety and access rules are known before launch. Write the row, the cases and the bar first,
   then build. Changing the bar after seeing results is not allowed; add a new row instead.
3. **Keep a slot for evals you have not discovered yet.** Most real failure modes show up only
   when you read actual outputs. After launch (or after a dogfood round), read a sample of traces,
   name the failure patterns you see, and append an EV row per pattern that matters. Appended rows
   get new IDs; existing pass rules are never rewritten.
4. **No similarity metrics.** BLEU, ROUGE, embedding cosine and "semantic similarity" scores say
   how close a text is to a reference, not whether it is right. Grade the property you care about:
   the code is correct, the policy is applied, the claim is supported.
5. **A rate needs a designed sample.** "95% of answers are grounded" means nothing without a
   sample frame, a size and a way to draw it. If the sample cannot be designed before launch,
   the claim is a needs-runtime criterion measured against the intent's Outcome metric, not an
   EV row with a made-up denominator.
6. **Score each step separately.** For a pipeline (retrieve, then answer; plan, then act), give
   each step its own row so a failure points at the step that caused it.
7. **A model judge is a measuring instrument.** Calibrate it against human labels on a small set
   (20 or more cases), record its agreement, and keep the human-labeled cases in the case set.
   An uncalibrated judge is not a pass rule.

## Rows most features need

When the feature takes user text (messages, documents, form fields, tool results), add these
unless they truly do not apply. spec-lint warns when the refusal or injection row is missing; write
`Takes user text: no` in the section when the feature takes none.

| Row | Behavior | Typical pass rule |
|---|---|---|
| Refusal | declines requests outside policy, with the stated reason | N/N refuse on an out-of-policy set |
| Abstention | says it does not know, or asks, when the input does not support an answer | N/N abstain on unanswerable cases |
| Injection | treats instructions inside user content as data, not commands | N/N not followed |
| Access | never reveals or acts on data the caller may not see; when the output is shown to people other than the one whose access produced it, it never reaches an audience with less access than its source | N/N no leak across accounts |
| Over-refusal | still helps on legitimate requests that resemble refused ones | ≥ M/N helped |

The injection row covers any content that neither the product's instructions nor the user told
the model to obey: documents, web pages, tickets, email, tool results. Refusal and abstention get
their own rows because a model has no dependable default for either: what the feature does when
it should not answer is a requirement, not an implementation detail.

## Writing the case set

- Start small and real: 20 to 50 cases drawn from actual or realistic inputs beat 1,000
  synthetic ones nobody has read.
- Include the boring middle, the edges, and the adversarial cases in separate files or tagged rows,
  so a pass rule can name which slice it covers.
- Store the expected outcome with each case (the label, the required refusal, the forbidden
  action), and the reason, so a reviewer can disagree with a label.
- Version the case set with the code. A case set that changes silently makes the pass rule
  meaningless.
- Size it by risk, not by saturation. Name the slices first (every EV row, every refusal and
  abstention case, the input classes where a failure costs the most), set a floor per slice, then
  count. "Add cases until the verdict stops moving" stops before the rare, harmful slices show up.
  A floor is a coverage commitment (that failure mode was looked for on purpose across N cases),
  not a measurement and not a bound on how often the feature fails.
- Say how many times each case runs at production settings and whether it must pass on every run.
  A case that passes once and fails once has not shown that it holds.
- Keep some cases out of tuning and check the pass rules on them; report each slice on its own. An
  aggregate that passes while one slice fails is a failing eval.

## After launch: appending EV rows

Error analysis (reading a sample of real traces, naming the failure patterns, counting them) is
how the evals you did not know about get found. Each pattern worth guarding becomes a new row,
appended below the existing ones:

```markdown
| **EV-04** | [post-launch 2026-12-01] Ask for the order id instead of guessing when the message names none | 25 cases drawn from the 2026-11 error-analysis sample | 25/25 ask | evals/refunds/missing-order.jsonl |
```

- The row gets the next free EV number; IDs are never reused or renumbered.
- The Behavior cell starts with `[post-launch YYYY-MM-DD]`, the date of the analysis, and the case
  set says where the cases came from.
- The pass rule is a number fixed before the row's first run, like any other row.
- Existing rows are never edited: a pass rule that turned out too loose stays, and a stricter row
  is appended beside it. Retire a row by noting it under `## Clarifications`, not by deleting it.
- Append rows to a `shipped` spec freely; the next run plans them like any other EV ID.

`muster spec-lint` accepts these rows: it checks the tag's date and warns when a post-launch row
carries a lower EV number than a launch row (an appended row always gets a new, higher ID).

## How it reaches the verifier

Each EV row becomes an eval command in the plan (stage B of the PM domain) and its pass rule
decides VERIFIED or FAILED. A behavior that can only be judged by a person is a `verify: judgment`
criterion (NEEDS-HUMAN); one that needs production traffic is `verify: needs-runtime`
(NEEDS-RUNTIME, never VERIFIED before launch).

Inspired by Anthropic's "Define success criteria and build evaluations" and "Demystifying evals
for AI agents", OpenAI's "Evaluation best practices", and Hamel Husain's "Your AI Product Needs
Evals" and "AI Evals: Everything You Need to Know" (with Shreya Shankar). No text is carried from
them; vendor/manifest.yaml records each as an inspired-by work.

<!-- The deterministic-feature note, the injection/access/refusal wording, and the sizing, runs-per-
case and held-out bullets are adapted from product-on-purpose/pm-skills (Apache-2.0) at 9b920db
(v2.35.0-3-g9b920db): skills/deliver-prd/SKILL.md step 5 and references/TEMPLATE.md "AI Behavior
and Evaluation". Modified by muster: condensed, and mapped onto EV rows and verify types.
vendor/manifest.yaml tracks both files (pm-skills-product-on-purpose); NOTICE carries the
attribution (upstream ships no NOTICE file). -->

