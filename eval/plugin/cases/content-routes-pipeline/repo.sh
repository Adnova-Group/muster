#!/usr/bin/env bash
# Scaffold: a committed docs-only repo (clean tree, so /muster:plan can branch).
set -euo pipefail
# The eval sandbox masks dotfiles in the workspace with device nodes; ignore them.
cat > .gitignore <<'EOF'
.*
!.gitignore
!.muster/
EOF
cat > README.md <<'EOF'
# Ledgerly

Ledgerly exports invoices and payments as CSV. Since 2.4, every date column is written as
YYYY-MM-DD and every timestamp as ISO 8601 with a UTC offset, instead of the viewer's locale.
EOF
git init -q -b main
git add -A
git -c user.name=eval -c user.email=eval@example.invalid commit -q -m "init"
