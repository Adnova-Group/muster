# Slice 3 — deferred follow-ups

Non-blocking nits from the final review (2026-06-07, VERDICT: PASS). Hardening already applied before
merge: single-line `adapted_from` (`lineWidth: 0`) + guard against overwriting NOTICE/builtins with
empty output.

Deferred (nits, safe to address later):

- **`tech-debt` role has no vendored builtin.** Curated wshobson set mapped specialists to refactor
  but not tech-debt; on a bare machine `tech-debt` → inline (with the `wshobson-agents` external
  recommended). Add a tech-debt-mapped item to the manifest if desired.
- **`code-navigation` has no builtin** (the grep-nav stub was removed and not re-vendored). Bare
  machine → inline + serena recommendation. Fine by design; add a real nav built-in later if wanted.
- **`fetchSourceRoot` drops the git error detail.** On clone failure the warning says "could not
  fetch (github)" without the underlying error. Include `e.message` in the warning.
- **`test/vendor.test.js` imports `generateNotice` mid-file.** Hoist to top-of-file with the other
  imports (cosmetic; ESM hoists regardless).
- **Built-in role taxonomy.** Many wshobson specialists were mapped onto Muster's 11 roles; a future
  slice may add a `specialist` role + description-search path so breadth isn't squeezed into 11 roles.
