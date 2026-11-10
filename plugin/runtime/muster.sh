#!/bin/sh
# Resolve the muster CLI per call. Commands call `sh "${CLAUDE_PLUGIN_ROOT}/runtime/muster.sh" <verb>`
# because Bash tool calls do not share shell variables.
#   1. The source checkout this plugin was loaded from (--plugin-dir development).
#   2. npx pinned to this plugin's own version.
# A globally or project-installed `muster` is never used: it may be an older release that lacks
# the verbs these commands call (test/plugin-runtime-resolver.test.js).
d=$(dirname "$0")
if [ -f "$d/../../src/cli.js" ]; then exec node "$d/../../src/cli.js" "$@"; fi
v=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$d/../.claude-plugin/plugin.json" | head -n 1)
exec npx -y "@adnova-group/muster@${v:-latest}" "$@"
