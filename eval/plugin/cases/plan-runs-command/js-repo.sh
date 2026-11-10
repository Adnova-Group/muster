#!/usr/bin/env bash
# Scaffold: a small, committed JavaScript project (clean tree, so /muster:plan can branch).
set -euo pipefail
cat > package.json <<'EOF'
{
  "name": "tally",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "test": "node --test" }
}
EOF
cat > index.js <<'EOF'
export function tally(items) {
  const out = {};
  for (const item of items) {
    if (out[item] === undefined) out[item] = 0;
    out[item] = out[item] + 1;
  }
  return out;
}
EOF
# The eval sandbox masks dotfiles in the workspace (.bashrc, .mcp.json, .vscode, ...) with
# device nodes; ignore them so preflight and the branch step see a clean tree.
cat > .gitignore <<'EOF'
.*
!.gitignore
!.muster/
EOF
git init -q -b main
git add -A
git -c user.name=eval -c user.email=eval@example.invalid commit -q -m "init"
