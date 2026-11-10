---
name: property-based-testing
description: "Write, review and triage property-based tests (Hypothesis, fast-check, proptest, Echidna): roundtrip, invariant and oracle properties."
muster_builtin: true
license: CC-BY-SA-4.0
upstream:
  - repo: trailofbits/skills
    ref: e4dd0bb5b15535f7c5a0834187dffba6ac37e4ff
    path: plugins/property-based-testing/skills/property-based-testing/SKILL.md
    license: CC-BY-SA-4.0
    relation: adapted
---
<!-- License: CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/). This file is adapted from trailofbits/skills @ e4dd0bb5b15535f7c5a0834187dffba6ac37e4ff plugins/property-based-testing/skills/property-based-testing/SKILL.md, made by Trail of Bits. Changes made by Muster: frontmatter (one-line description, muster_builtin, license, upstream provenance; effort dropped), this header, and a prompt-lint directive. -->

# Property-Based Testing

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001, GUARD-IDK-001: CC BY-SA 4.0 upstream skill body (trailofbits/skills), carried verbatim apart from the changes its license header lists; muster loads it on demand, which supplies the role and output format. -->

An example test asserts one point. A property asserts a rule over the whole input
domain and lets the generator hunt for the counterexample. That trade is worth making
when the code has an algebraic shape — an inverse, an invariant, an oracle — and not
otherwise. Code with no such shape gets example tests; saying so is a valid outcome.

Check first whether the shape is missing or merely buried. A calculation wrapped in I/O,
a string built by concatenation, an in-place mutation — each has a property and no seam
to assert it through. See [references/refactoring.md](references/refactoring.md) before
concluding there is nothing to assert.

## Property catalog

| Property | Formula | Where it applies |
|---|---|---|
| Roundtrip | `decode(encode(x)) == x` | Serialization, conversion pairs |
| Inverse | `f(g(x)) == x` | encrypt/decrypt, compress/decompress |
| Oracle | `new(x) == reference(x)` | Optimization, refactoring, reimplementation |
| Idempotence | `f(f(x)) == f(x)` | Normalization, formatting, sorting |
| Invariant | Holds before and after | Any transformation, contract state |
| Easy to verify | `is_sorted(sort(x))` | Complex algorithms with cheap checkers |
| Commutativity | `f(a, b) == f(b, a)` | Binary and set operations |
| Associativity | `f(f(a,b), c) == f(a, f(b,c))` | Combining operations |
| Identity | `f(x, e) == x` | Operations with a neutral element |

Strength ordering, weakest to strongest:
`no crash → type preservation → invariant → idempotence → roundtrip / oracle`.

Assert the strongest property the code supports. "No crash" alone rarely justifies the
dependency — if that is all you can find, either a small rearrangement exposes something
stronger, or the honest report is that this code is a poor PBT candidate. Rule out the
first before settling for the second.

## The two ways a property test asserts nothing

- **Tautology.** `assert add(a, b) == a + b` restates the implementation; no bug they
  share can fail it. Pick a property that constrains the function without recomputing
  it. Note the exception: `f(x) == f(x)` is a genuine determinism property when `f`
  is not obviously pure — serializers over dicts or sets, hashing, anything reading
  the clock.
- **Vacuity.** `assume()` that filters out nearly every input passes without
  exercising anything, and self-contradictory `assume()` passes having run zero cases.
  Push constraints into the strategy so the generator produces valid inputs directly.

## Where to look next

Load the one that matches the task in front of you:

| Task | File |
|---|---|
| Writing new tests, designing strategies | [references/generating.md](references/generating.md) |
| The code has no property to assert yet | [references/refactoring.md](references/refactoring.md) |
| Reviewing existing property tests | [references/reviewing.md](references/reviewing.md) |
| A property test just failed | [references/interpreting-failures.md](references/interpreting-failures.md) |
| Library choice, Echidna and Medusa | [references/libraries.md](references/libraries.md) |

## Introducing PBT to a project that lacks it

If the project already uses a PBT library, just write the tests in it. If it does not,
adding one is a dependency decision that belongs to the user — offer it once with the
specific property you would write, and take the answer either way.
