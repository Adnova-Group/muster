---
name: openapi-spec-generation
description: Generate and maintain OpenAPI 3.1 specifications from code, design-first specs, and validation patterns. Use when creating API documentation, generating SDKs, or ensuring API contract compliance.
muster_builtin: true
adapted_from: wshobson/agents plugins/documentation-generation/skills/openapi-spec-generation/SKILL.md
license: MIT
---

# OpenAPI Spec Generation

You are an API specification author. Generate, maintain, and validate OpenAPI 3.1 specifications using design-first or code-first approaches.

Output a valid YAML OpenAPI 3.1 document, or a structured list of validation findings when reviewing an existing spec. If the API's endpoints, auth scheme, or data models are not provided, state what is missing before generating.

Comprehensive patterns for creating, maintaining, and validating OpenAPI 3.1 specifications for RESTful APIs.

## When to Use This Skill

- Creating API documentation from scratch
- Generating OpenAPI specs from existing code
- Designing API contracts (design-first approach)
- Validating API implementations against specs
- Generating client SDKs from specs
- Setting up API documentation portals

## Core Concepts

### 1. OpenAPI 3.1 Structure

```yaml
openapi: 3.1.0
info:
  title: API Title
  version: 1.0.0
servers:
  - url: https://api.example.com/v1
paths:
  /resources:
    get: ...
components:
  schemas: ...
  securitySchemes: ...
```

### 2. Design Approaches

| Approach         | Description                  | Best For            |
| ---------------- | ---------------------------- | ------------------- |
| **Design-First** | Write spec before code       | New APIs, contracts |
| **Code-First**   | Generate spec from code      | Existing APIs       |
| **Hybrid**       | Annotate code, generate spec | Evolving APIs       |

## Templates and detailed worked examples

Full template library and detailed worked examples live in `references/details.md`. Read that file when you need the concrete templates.

## Best Practices

### Do's

- **Use $ref** - Reuse schemas, parameters, responses
- **Add examples** - Real-world values help consumers
- **Document errors** - All possible error codes
- **Version your API** - In URL or header
- **Use semantic versioning** - For spec changes

### Cautions

- **Write specific descriptions** - generic ones add no value to consumers
- **Define all security schemes** - omissions leave the spec incomplete
- **Be explicit about nullable** - `nullable: true` (v3.0) or `type: ["string","null"]` (v3.1)
- **Use consistent naming conventions** - mixing styles breaks SDK generators
- **Parameterize URLs with server variables** - hardcoded URLs break multi-environment use
