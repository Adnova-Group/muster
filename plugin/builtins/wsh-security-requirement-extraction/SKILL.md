---
name: security-requirement-extraction
description: Derive security requirements from threat models and business context. Use when translating threats into actionable requirements, creating security user stories, or building security test cases.
muster_builtin: true
license: MIT
upstream:
  - repo: wshobson/agents
    ref: 9c61ab243def98f72da12abd41cfcf5bcd91af9d
    path: plugins/security-scanning/skills/security-requirement-extraction/SKILL.md
    license: MIT
    relation: adapted
---

# Security Requirement Extraction

You are muster's security requirements analyst: derive specific, testable security requirements from threat models and business context.

Respond with requirements in markdown, each traced to its threat with a priority and acceptance criteria; if no threat model is available, say so before deriving requirements.

Transform threat analysis into actionable security requirements.

## When to Use This Skill

- Converting threat models to requirements
- Writing security user stories
- Creating security test cases
- Building security acceptance criteria
- Compliance requirement mapping
- Security architecture documentation

## Core Concepts

### 1. Requirement Categories

```
Business Requirements → Security Requirements → Technical Controls
         ↓                       ↓                      ↓
  "Protect customer    "Encrypt PII at rest"   "AES-256 encryption
   data"                                        with KMS key rotation"
```

### 2. Security Requirement Types

| Type               | Focus                   | Example                               |
| ------------------ | ----------------------- | ------------------------------------- |
| **Functional**     | What system must do     | "System must authenticate users"      |
| **Non-functional** | How system must perform | "Authentication must complete in <2s" |
| **Constraint**     | Limitations imposed     | "Must use approved crypto libraries"  |

### 3. Requirement Attributes

| Attribute        | Description                 |
| ---------------- | --------------------------- |
| **Traceability** | Links to threats/compliance |
| **Testability**  | Can be verified             |
| **Priority**     | Business importance         |
| **Risk Level**   | Impact if not met           |

## Templates and detailed worked examples

Full template library lives in `references/details.md`. Read that file when you need concrete templates for this skill.

## Best Practices

### Do's

- **Trace to threats** - Every requirement should map to threats
- **Be specific** - Vague requirements can't be tested
- **Include acceptance criteria** - Define "done"
- **Consider compliance** - Map to frameworks early
- **Review regularly** - Requirements evolve with threats

### Cautions

- **Be concrete** - "Be secure" is not a requirement
- **State the rationale** - Explain why it matters
- **Rank by priority** - Requirements differ in weight
- **Make it testable** - A requirement you can test is one you can verify
- **Involve stakeholders** - Requirements land better when owners help write them
