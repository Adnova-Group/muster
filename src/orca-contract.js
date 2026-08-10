import { posix } from "node:path";

/**
 * The single canonical Orca worktree identity contract.
 *
 * Before this module the adapter, the receipt normalizer, and the merge-gate
 * cleanup evaluator each encoded their own idea of a valid selector and a valid
 * runtime path, so a context produced by one was rejected by the next. Every
 * module now imports these predicates instead of restating them.
 *
 * Documented Orca surface this encodes:
 *
 * - `orca worktree rm --worktree id:<worktreeId> --json` and
 *   `orca worktree show --worktree path:/abs/path --json` are both public
 *   selector forms [Orca CLI reference].
 * - For a remote runtime the caller must pass an explicit server-side selector,
 *   `id:<repoId>::<absolute-worktree-path>` or `path:<absolute-server-path>`;
 *   a local `active`/`current` alias is invalid there [Orca CLI reference].
 *
 * `id:<worktreeId>` is therefore the canonical form for every host: it is
 * explicit, it is never a cwd alias, and it is the form Orca's own removal
 * example uses. `path:<absolute-path>` stays accepted for a local worktree only,
 * because that is the only host where the path is unambiguous to the caller.
 */

export const ORCA_SELECTOR_SCHEMA_VERSION = 1;
export const ORCA_WORKTREE_ID_SEPARATOR = "::";

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const UNC_PREFIX = /^\\\\[^\\/]+[\\/][^\\/]+/;

/**
 * Classify an absolute runtime path without rewriting it.
 *
 * Orca ships macOS, Windows, and Linux builds, so a runtime path is not always
 * a POSIX path. The value is compared verbatim across modules, so this never
 * normalizes a path -- it only reports whether the path is already canonical.
 */
export function classifyRuntimePath(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  if (UNC_PREFIX.test(value)) return "unc";
  if (WINDOWS_DRIVE.test(value)) return "windows";
  if (value.startsWith("/")) return "posix";
  return null;
}

export function isAbsoluteRuntimePath(value) {
  return classifyRuntimePath(value) !== null;
}

/**
 * True when the path is absolute AND already in canonical form: no `.` or `..`
 * segment, no repeated separator, no trailing separator below the root. Non-
 * canonical input fails closed rather than being silently rewritten, because a
 * rewritten path would no longer string-match the identity Orca reported.
 */
export function isCanonicalRuntimePath(value) {
  const kind = classifyRuntimePath(value);
  if (kind === null) return false;
  if (kind === "posix") return posix.normalize(value) === value;
  const body = kind === "unc" ? value.slice(2) : value.slice(3);
  if (/[\\/]{2}/.test(body)) return false;
  const segments = body.split(/[\\/]/);
  if (segments.some((segment) => segment === "." || segment === "..")) return false;
  return segments.length > 1 ? segments.at(-1) !== "" : true;
}

/**
 * A worktree id must carry its repository id. This is a shape check, not a
 * parser for arbitrary future ids: the public selector contract makes the
 * `<repoId>::` prefix the safe minimum invariant.
 */
export function worktreeIdBelongsToRepository(worktreeId, repositoryId) {
  return typeof worktreeId === "string"
    && typeof repositoryId === "string"
    && repositoryId.length > 0
    && worktreeId.startsWith(`${repositoryId}${ORCA_WORKTREE_ID_SEPARATOR}`);
}

/** The one selector every module should emit when it has a choice. */
export function canonicalOrcaSelector(worktreeId) {
  return `id:${worktreeId}`;
}

/**
 * Every selector form that identifies this exact worktree. Order is
 * significant only in that the canonical form is first.
 */
export function acceptedOrcaSelectors({ worktreeId, path, host }) {
  const accepted = [canonicalOrcaSelector(worktreeId)];
  if (host === "local") accepted.push(`path:${path}`);
  return accepted;
}

export function isAcceptedOrcaSelector(selector, identity) {
  return acceptedOrcaSelectors(identity).includes(selector);
}

/**
 * Shared-path classification vocabulary.
 *
 * Orca documents exactly three mechanisms by which a gitignored path reaches a
 * worktree [Orca docs, Worktrees]:
 *
 * 1. Worktree Shared Paths -- "materialize from the primary checkout into each
 *    new worktree (APFS clone-copy on macOS when possible, otherwise a symlink)".
 * 2. `worktree.sharedDirectories` in `orca.yaml` -- "gitignored directories to
 *    share the same way (symlink/share, not copy)".
 * 3. `.worktreeinclude` at the repo root -- "gitignored files or directories to
 *    copy (not symlink) into each new worktree".
 *
 * The canonical names below are the four categories the research note requires
 * a receipt to distinguish: tracked checkout content, Orca-linked shared
 * content, Orca-copied include content, and a Muster-owned artifact. The
 * content-hint names are retained because they carry the reproducibility signal
 * (a mutable cache or a secret is never an independent worker artifact).
 */
export const ORCA_MECHANISM_CLASSIFICATIONS = Object.freeze([
  "tracked",
  "orca-shared-link",
  "orca-include-copy",
  "worker-owned",
  "unknown",
]);

export const ORCA_CONTENT_CLASSIFICATIONS = Object.freeze([
  "shared",
  "shared-cache",
  "shared-secret",
  "shared-generated",
]);

export const ORCA_SHARED_CLASSIFICATIONS = Object.freeze([
  ...ORCA_MECHANISM_CLASSIFICATIONS,
  ...ORCA_CONTENT_CLASSIFICATIONS,
]);

/** Classifications that are never an independently reproducible worker artifact. */
export const ORCA_NON_REPRODUCIBLE_CLASSIFICATIONS = Object.freeze([
  "orca-shared-link",
  "shared",
  "shared-cache",
  "shared-secret",
  "shared-generated",
]);

export function isOrcaSharedClassification(value) {
  return ORCA_SHARED_CLASSIFICATIONS.includes(value);
}
