// Deterministic resolution of how to invoke the muster CLI WITHOUT paying an `npx -y`
// cold start on every call. `npx -y <pkg>` re-verifies against the npm registry/cache on
// EVERY invocation — across one `/muster:go` run that calls the CLI a dozen-plus times
// (scope, detect, assess, capabilities, manifest validate, wave, plan-checklist, tally,
// ...) that is a dozen-plus avoidable round-trips. Measured on this repo: 10 sequential
// `npx -y @adnova-group/muster ...` calls average ~268ms/call vs ~92ms/call for the
// equivalent resolved local invocation (see docs/performance-pass.md) — resolving ONCE
// and reusing the answer for the rest of the run removes nearly all of that.
//
// Preference order (first existing wins):
//   1. vendored plugin runtime  — `${CLAUDE_PLUGIN_ROOT}/runtime/muster.mjs`, a bundled
//      copy shipped alongside an installed Claude Code/Codex plugin (see
//      scripts/build-codex.mjs for the Codex-side equivalent this mirrors). Zero
//      install, zero registry contact.
//   2. local checkout — `<cwd>/src/cli.js`, guarded by a second existence check on
//      `<cwd>/src/cli-resolve.js` (this very file) as a marker: an unrelated project
//      that happens to have its own `src/cli.js` must NOT be mistaken for a muster
//      checkout.
//   3. local/global bin — `<cwd>/node_modules/.bin/muster` (an npm-installed
//      dependency), else a `muster` binary already on PATH.
//   4. npx fallback — last resort; still correct, but the one path this module exists
//      to avoid paying on every call. Marked `degraded: true` so a caller logs the fact
//      honestly (glass box) instead of silently eating the cost run after run.
//
// Pure and side-effect-free beyond the read-only existence checks passed in via `exists`
// (defaults to a real fs stat) and `hasBin` (defaults to a PATH scan using that same
// `exists`) — both injectable so tests never touch the real filesystem or PATH.
//
// `RESOLUTION_SHELL_SNIPPET` below is the same four-tier decision expressed as a plain
// shell snippet: an installed plugin (or a plugin/skill markdown file) cannot `import`
// this module without already having resolved SOME way to run node, so the bootstrap
// decision for a fresh shell session has to be pure shell (`test -f` / `command -v`),
// never a CLI call. Callers embed this snippet verbatim at the top of a run and reuse
// `$MUSTER_CLI` for every later call in that same shell session (Claude Code's Bash
// tool keeps one persistent shell per session, so the variable survives across calls).
// A consistency test (test/hotpath-cli-resolution.test.js) asserts the hot-path command
// files embed this exact text, so the doc and this module cannot silently drift apart.

import { join, delimiter } from "node:path";
import { stat } from "node:fs/promises";

async function defaultExists(p) {
  try { await stat(p); return true; }
  catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return false;
    throw err;
  }
}

async function defaultHasBin(name, env, exists = defaultExists) {
  const pathVar = env.PATH || env.Path || "";
  const dirs = pathVar.split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    if (await exists(join(dir, name))) return true;
    if (await exists(join(dir, `${name}.cmd`))) return true; // Windows shim
  }
  return false;
}

export async function resolveMusterCli({
  env = process.env,
  cwd = process.cwd(),
  exists = defaultExists,
  hasBin,
} = {}) {
  const resolveBin = hasBin || ((name) => defaultHasBin(name, env, exists));

  if (env.CLAUDE_PLUGIN_ROOT) {
    const vendored = join(env.CLAUDE_PLUGIN_ROOT, "runtime", "muster.mjs");
    if (await exists(vendored)) {
      return { command: "node", args: [vendored], source: "vendored-plugin", degraded: false };
    }
  }

  const localCheckout = join(cwd, "src", "cli.js");
  const localCheckoutMarker = join(cwd, "src", "cli-resolve.js");
  if ((await exists(localCheckout)) && (await exists(localCheckoutMarker))) {
    return { command: "node", args: [localCheckout], source: "local-checkout", degraded: false };
  }

  const localBin = join(cwd, "node_modules", ".bin", "muster");
  if (await exists(localBin)) {
    return { command: localBin, args: [], source: "local-bin", degraded: false };
  }

  if (await resolveBin("muster")) {
    return { command: "muster", args: [], source: "global-bin", degraded: false };
  }

  return { command: "npx", args: ["-y", "@adnova-group/muster"], source: "npx-fallback", degraded: true };
}

// Joins a resolved { command, args } into one shell-ready invocation string.
export function formatInvocation({ command, args }) {
  return [command, ...args].join(" ");
}

export const RESOLUTION_SHELL_SNIPPET = `if [ -n "$CLAUDE_PLUGIN_ROOT" ] && [ -f "$CLAUDE_PLUGIN_ROOT/runtime/muster.mjs" ]; then
  MUSTER_CLI="node $CLAUDE_PLUGIN_ROOT/runtime/muster.mjs"
elif [ -f "./src/cli.js" ] && [ -f "./src/cli-resolve.js" ]; then
  MUSTER_CLI="node ./src/cli.js"
elif [ -f "./node_modules/.bin/muster" ]; then
  MUSTER_CLI="./node_modules/.bin/muster"
elif command -v muster >/dev/null 2>&1; then
  MUSTER_CLI="muster"
else
  MUSTER_CLI="npx -y @adnova-group/muster"
fi`;
