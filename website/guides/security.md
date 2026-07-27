# Security and reporting

Muster executes orchestration inside an agent harness and can dispatch tools with external effects. Review the run's manifest, ownership fences, and forbidden action classes before approving work that can publish, send, purchase, sign, submit, or delete remote state.

## Report a vulnerability

Report security vulnerabilities privately through [GitHub Security Advisories](https://github.com/Adnova-Group/muster/security/advisories/new). Include the affected version, impact, reproduction steps, and the smallest useful diagnostic sample. Please do not open a public issue for an unpatched vulnerability.

Ordinary bugs and documentation gaps belong in the [public issue tracker](https://github.com/Adnova-Group/muster/issues).

## What the fences cover

Muster's action-class fence recognizes a bounded set of high-confidence MCP tool names and shell commands. It is not a general sandbox, data-loss prevention system, or proof that every external action was classified. A missing run marker, missing forbidden-actions file, unreadable state, or unmatched action fails open. Review gates and harness permissions remain part of the safety model.

Codex hooks are advisory for todo and spawn policy. Kimi uses native permission rules for the action fence. Cowork's verified MCP-only lane has no hook enforcement. See [Harness support](/guides/harnesses) before relying on a harness-specific control.

## Share diagnostics safely

`muster doctor` and `muster doctor --codex` are read-only, but their output can contain local paths, scope locations, usernames embedded in paths, repository names, executable locations, and installed-provider metadata. Redact those values before posting output publicly. Never include tokens, credentials, private remote URLs, issue bodies, or proprietary file contents.
