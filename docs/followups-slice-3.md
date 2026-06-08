# Slice 3 — deferred follow-ups

Non-blocking nits from the final review (2026-06-07, VERDICT: PASS). Hardening already applied before
merge: single-line `adapted_from` (`lineWidth: 0`) + guard against overwriting NOTICE/builtins with
empty output.

Status:

- **`tech-debt` role has no vendored builtin.** Curated wshobson set mapped specialists to refactor
  but not tech-debt; on a bare machine `tech-debt` → inline (with the `wshobson-agents` external
  recommended). Add a tech-debt-mapped item to the manifest if desired.
  **RESOLVED (earlier)** — `tech-debt` now resolves to `wsh-legacy-modernizer` [agent]; no longer
  falls to inline on a bare machine.
- **`code-navigation` has no builtin** (the grep-nav stub was removed and not re-vendored). Bare
  machine → inline + serena recommendation. Fine by design; add a real nav built-in later if wanted.
  **RESOLVED (earlier)** — `code-navigation` now resolves to `serena` [mcp], with the built-in
  `muster-investigator` agent as the bare-machine fallback (no longer inline).
- **`fetchSourceRoot` drops the git error detail.** On clone failure the warning says "could not
  fetch (github)" without the underlying error. Include `e.message` in the warning.
  **RESOLVED 2026-06-08** — vendor fetch-error now includes the underlying error detail.
- **`test/vendor.test.js` imports `generateNotice` mid-file.** Hoist to top-of-file with the other
  imports (cosmetic; ESM hoists regardless).
  **RESOLVED 2026-06-08** — `generateNotice` import hoisted to top-of-file with the other imports.
- **Built-in role taxonomy.** Many wshobson specialists were mapped onto Muster's 11 roles; a future
  slice may add a `specialist` role + description-search path so breadth isn't squeezed into 11 roles.
  **DEFERRED — future slice** — `specialist` role + description-search taxonomy is net-new scope (joins
  the slice-5 PM-domain built-ins item); not a fix to slice-3 behavior.
