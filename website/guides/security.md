# Security and reporting

Muster executes orchestration inside an agent harness and can dispatch tools with external effects. Review the run's manifest, ownership fences, and forbidden action classes before approving work that can publish, send, purchase, sign, submit, or delete remote state.

## Codex Security integration

`/muster:security review` scans a diff or working tree; `/muster:security audit` scans a repository or selected paths. Ordinary delivery and review gates run it only when deterministic intent or changed-path risk warrants a security audit. The integration pins official Apache-2.0 `@openai/codex-security` 0.1.5 (tag `npm-v0.1.5`, commit `66778d0d85f478d7832854b81d0a6ddb93a3ce4c`) and rejects version drift.

The upstream CLI requires Node 22.13.x, 24.x, or 26.x; Python 3.10+; Codex Security access; and ChatGPT login or `OPENAI_API_KEY`/`CODEX_API_KEY`. Keep its private state and result directory outside the scanned worktree. npm installs resolve Muster's exact optional dependency. A generated Codex plugin cache instead requires exact version 0.1.5 in the project or on `PATH`; version drift is rejected before a scan. Muster preserves exit 1 as a completed severity-policy finding and exit 2 as incomplete coverage/runtime failure. Every finding receipt includes severity and concrete evidence; a missing prerequisite or malformed finding blocks loudly.

## Report a vulnerability

Report security vulnerabilities privately through [GitHub Security Advisories](https://github.com/Adnova-Group/muster/security/advisories/new). Include the affected version, impact, reproduction steps, and the smallest useful diagnostic sample. Please do not open a public issue for an unpatched vulnerability.

Ordinary bugs and documentation gaps belong in the [public issue tracker](https://github.com/Adnova-Group/muster/issues).

## What the fences cover

Muster's action-class fence recognizes a bounded set of high-confidence MCP tool names and shell commands. It is not a general sandbox, data-loss prevention system, or proof that every external action was classified. A missing run marker, missing forbidden-actions file, unreadable state, or unmatched action fails open. Review gates and harness permissions remain part of the safety model.

Codex hooks are advisory for todo and spawn policy. Kimi uses native permission rules for the action fence. Cowork's verified MCP-only lane has no hook enforcement. See [Harness support](/guides/harnesses) before relying on a harness-specific control.

## Share diagnostics safely

`muster doctor` and `muster doctor --codex` are read-only, but their output can contain local paths, scope locations, usernames embedded in paths, repository names, executable locations, and installed-provider metadata. Redact those values before posting output publicly. Never include tokens, credentials, private remote URLs, issue bodies, or proprietary file contents.
