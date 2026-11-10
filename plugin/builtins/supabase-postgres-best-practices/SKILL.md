---
name: supabase-postgres-best-practices
description: "Supabase's Postgres rules for schema design, indexes, RLS, connection pooling, locking, migrations and query diagnosis, for Postgres running anywhere."
muster_builtin: true
license: MIT
upstream:
  - repo: supabase/agent-skills
    ref: c9be0e931b7930f7d02126d04774d904c381e7d7
    path: skills/supabase-postgres-best-practices/SKILL.md
    license: MIT
    relation: vendored
---

# Supabase Postgres Best Practices

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-POS-001, ANTH-FMT-001: vendored upstream skill body (supabase/agent-skills), kept as upstream wrote it so `muster vendor update` can 3-way merge it; muster loads it on demand for database schema, query and migration work, which supplies the role and output format. -->

Comprehensive performance optimization guide for Postgres, maintained by Supabase. Contains rules across 8 categories, prioritized by impact to guide automated query optimization and schema design.

## When to Apply

Reference these guidelines when:
- Writing SQL queries or designing schemas
- Implementing indexes or query optimization
- Reviewing database performance issues
- Configuring connection pooling or scaling
- Optimizing for Postgres-specific features
- Working with Row-Level Security (RLS)

## Rule Categories by Priority

| Priority | Category | Impact | Prefix |
|----------|----------|--------|--------|
| 1 | Query Performance | CRITICAL | `query-` |
| 2 | Connection Management | CRITICAL | `conn-` |
| 3 | Security & RLS | CRITICAL | `security-` |
| 4 | Schema Design | HIGH | `schema-` |
| 5 | Concurrency & Locking | MEDIUM-HIGH | `lock-` |
| 6 | Data Access Patterns | MEDIUM | `data-` |
| 7 | Monitoring & Diagnostics | LOW-MEDIUM | `monitor-` |
| 8 | Advanced Features | LOW | `advanced-` |

## How to Use

Read individual rule files for detailed explanations and SQL examples:

```
references/query-missing-indexes.md
references/query-partial-indexes.md
references/_sections.md
```

Each rule file contains:
- Brief explanation of why it matters
- Incorrect SQL example with explanation
- Correct SQL example with explanation
- Optional EXPLAIN output or metrics
- Additional context and references
- Supabase-specific notes (when applicable)

## References

- https://www.postgresql.org/docs/current/
- https://supabase.com/docs
- https://wiki.postgresql.org/wiki/Performance_Optimization
- https://supabase.com/docs/guides/database/overview
- https://supabase.com/docs/guides/auth/row-level-security
