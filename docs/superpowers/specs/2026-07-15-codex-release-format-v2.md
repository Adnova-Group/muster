# Codex release format 2 migration

## Decision

Codex releases use `plugin/agents/*.toml` as the single profile tree and `plugin/runtime/muster.mjs` as the single CLI bundle. `plugin/src/cli.js` remains only as a 52-byte regular-file adapter for consumers that still invoke the historical path. Format 2 releases must not contain a top-level `profiles/` directory.

Source and upgraded bootstrap resolvers accept formats 1 and 2 and choose the profile root from release metadata. A cached format-1 bootstrap still rejects format 2, skips that selection, and resolves the retained format-1 generation.

## Transition window

The three-generation retention topology is preserved during the transition:

1. the selected format-2 generation;
2. a deterministic format-2 LKG made from the newest coherent format-1 release by removing only byte-identical profile and CLI copies; and
3. the original format-1 LKG for pre-upgrade cached bootstraps.

Legacy conversion fails closed if the two profile trees differ. It uses regular files only; symlinks and hard links are not compatibility mechanisms. Subsequent builds reuse an existing format-2 LKG and retain one format-1 fallback.

## Exit and rollback

The format-1 fallback remains throughout the 0.5.x compatibility window. Removing format-1 resolver support or the final format-1 LKG requires a separately reviewed bootstrap-format change and a release note that requires Codex/Desktop restart. Rollback during this window means selecting the retained format-1 generation; no payload reconstruction is required.

## Quantitative gates

The frozen pre-change package baseline is 10,785,588 unpacked bytes with three retained generations. With the same three-generation topology, format 2 must remain at or below 9,707,029 bytes (10% reduction). Duplicate-bearing release paths must remain at or below 844,756 bytes, a 40% reduction from the 1,407,928-byte baseline. The reviewed implementation measures 9,426,480 unpacked bytes (12.6% lower) and 530,577 duplicate-bearing bytes (62.3% lower) for the selected generation.
