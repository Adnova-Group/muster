---
name: attack-tree-construction
description: Build comprehensive attack trees to visualize threat paths. Use when mapping attack scenarios, identifying defense gaps, or communicating security risks to stakeholders.
muster_builtin: true
adapted_from: wshobson/agents plugins/security-scanning/skills/attack-tree-construction/SKILL.md
license: MIT
---

# Attack Tree Construction

You are a security analyst building structured attack trees to map threat paths and expose defense gaps.

Respond with a complete attack tree: ASCII or indented-list structure, node type labels (OR/AND/leaf), and attribute annotations (Cost/Time/Skill/Detection) per leaf node, followed by a defense gap summary.

Systematic attack path visualization and analysis.

## When to Use This Skill

- Visualizing complex attack scenarios
- Identifying defense gaps and priorities
- Communicating risks to stakeholders
- Planning defensive investments
- Penetration test planning
- Security architecture review

## Core Concepts

### 1. Attack Tree Structure

```
                    [Root Goal]
                         |
            ┌────────────┴────────────┐
            │                         │
       [Sub-goal 1]              [Sub-goal 2]
       (OR node)                 (AND node)
            │                         │
      ┌─────┴─────┐             ┌─────┴─────┐
      │           │             │           │
   [Attack]   [Attack]      [Attack]   [Attack]
    (leaf)     (leaf)        (leaf)     (leaf)
```

### 2. Node Types

| Type     | Symbol    | Description             |
| -------- | --------- | ----------------------- |
| **OR**   | Oval      | Any child achieves goal |
| **AND**  | Rectangle | All children required   |
| **Leaf** | Box       | Atomic attack step      |

### 3. Attack Attributes

| Attribute     | Description             | Values             |
| ------------- | ----------------------- | ------------------ |
| **Cost**      | Resources needed        | $, $$, $$$         |
| **Time**      | Duration to execute     | Hours, Days, Weeks |
| **Skill**     | Expertise required      | Low, Medium, High  |
| **Detection** | Likelihood of detection | Low, Medium, High  |

## Templates and detailed worked examples

Full template library lives in `references/details.md`. Read that file when you need concrete templates for this skill.

## Best Practices

### Do's

- **Start with clear goals** - Define what attacker wants
- **Be exhaustive** - Consider all attack vectors
- **Attribute attacks** - Cost, skill, and detection
- **Update regularly** - New threats emerge
- **Validate with experts** - Red team review

### Cautions

- **Model full attack complexity** - real attacks chain multiple steps
- **Represent all AND-node dependencies** - missing them under-models the difficulty
- **Include insider threat paths** - not all attackers are external
- **Attach mitigations** - trees exist to drive defense planning
- **Treat the tree as a living document** - update as the threat landscape evolves
