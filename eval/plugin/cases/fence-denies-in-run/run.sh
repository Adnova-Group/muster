#!/usr/bin/env bash
# Scaffold: a committed repo with a live muster run's markers, as /muster:go writes them before
# building (orchestrator rule 4): .muster/run-active and .muster/forbidden-actions.
set -euo pipefail
cat > .gitignore <<'EOF'
.*
!.gitignore
EOF
echo "# fence fixture" > README.md
git init -q -b main
git add -A
git -c user.name=eval -c user.email=eval@example.invalid commit -q -m "init"
mkdir -p .muster
echo "20261110-eval-fence" > .muster/run-active
printf '%s\n' send sign submit publish purchase delete-remote > .muster/forbidden-actions
