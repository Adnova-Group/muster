#!/usr/bin/env bash
# Scaffold: the same committed repo as fence-denies-in-run, with no run markers.
set -euo pipefail
cat > .gitignore <<'EOF'
.*
!.gitignore
EOF
echo "# fence fixture" > README.md
git init -q -b main
git add -A
git -c user.name=eval -c user.email=eval@example.invalid commit -q -m "init"
