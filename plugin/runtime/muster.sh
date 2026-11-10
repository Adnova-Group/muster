#!/bin/sh
# Resolve the muster CLI per call, cheapest first: a bundled runtime, the source checkout this
# plugin was loaded from (--plugin-dir or a marketplace clone), the project's local install,
# a global install, then npx. Commands call `sh "$CLAUDE_PLUGIN_ROOT/runtime/muster.sh" <verb>`
# because Bash tool calls do not share shell variables.
d=$(dirname "$0")
if [ -f "$d/muster.mjs" ]; then exec node "$d/muster.mjs" "$@"; fi
if [ -f "$d/../../src/cli.js" ]; then exec node "$d/../../src/cli.js" "$@"; fi
if [ -f ./node_modules/.bin/muster ]; then exec ./node_modules/.bin/muster "$@"; fi
if command -v muster >/dev/null 2>&1; then exec muster "$@"; fi
exec npx -y @adnova-group/muster "$@"
