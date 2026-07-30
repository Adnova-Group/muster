# Kimi builtin-provider reachability

Status: accepted

## Decision

`muster install kimi` materializes both `plugin/skills` and
`plugin/builtins` under Kimi's `skills/` root. It recursively copies each
directory containing `SKILL.md`, records every copied file in the existing
ownership manifest, stamps each catalog builtin's installed frontmatter
`name` to its catalog/directory ID, and rejects duplicate skill names across
the two source trees.

## Rationale

`capabilities --kimi` uses the shared catalog and can resolve catalog builtins
as role providers or list them in its skill inventory. Kimi Code natively loads
the Agent-Skills directory format those builtins already use, so filtering them
out would unnecessarily reduce the shared catalog and make Kimi routing differ
from the other plugin-capable harnesses.

Kimi invokes skills by frontmatter `name`, not by directory. Many vendored
builtins retain an upstream name that differs from Muster's catalog ID, so the
installer rewrites that one field in the installed copy. Source files remain
unchanged.

Materializing the builtins preserves the catalog's routing intent while keeping
the existing install guarantees: recursive assets are copied, stale owned files
are pruned, and uninstall removes only manifest-owned paths.

## Verification

The Kimi install test builds `capabilities --kimi` from the real catalog,
installs Muster into a temporary Kimi root, reads that root back through
`readInstalledKimi`, and asserts that every builtin agent or skill exposed by
capabilities is present in the corresponding dispatch inventory. For skills,
the test also verifies that the installed frontmatter name equals the exposed
capability ID.
