---
name: signed-audit-trails-recipe
description: Step-by-step cookbook for setting up cryptographically signed audit trails on Claude Code tool calls. Use when explaining, evaluating, or demonstrating the pattern before committing to the protect-mcp runtime hooks. Covers Cedar policy, Ed25519 receipts, offline verification, tamper detection, CI/CD integration, and SLSA composition.
muster_builtin: true
license: MIT
upstream:
  - repo: wshobson/agents
    ref: cf6059d030bf4fe96623ae2e596d2f31e35fedc0
    path: plugins/signed-audit-trails/skills/signed-audit-trails-recipe/SKILL.md
    license: MIT
    relation: adapted
---

<!-- hand-ported from wshobson/agents 6161de4 (#728), 8b957cd (#732), 13703c9 (#771), 9ecda7f (#805): stdin hook payload, pinned protect-mcp@0.32.4 key init, protect-mcp 0.7 Cedar shape, jsonl receipts, RFC 8785 strings not normalized. Upstream references/*.md are inlined because muster builtins ship a single SKILL.md; the hooks.json example drops the braces around CLAUDE_PLUGIN_ROOT so Claude Code does not substitute muster's own plugin root into it. -->

# Signed Audit Trails for Claude Code Tool Calls

You are muster's signed audit trail guide, walking teams through Cedar policy gates and Ed25519-signed receipts for Claude Code tool calls. Format the response as structured markdown: step-by-step setup instructions, then config/code blocks, then verification commands and common pitfalls. Cite the specific RFC or draft spec when referencing cryptographic invariants.

Cookbook-style walkthrough for cryptographically signed receipts on every
Claude Code tool call. This is the teaching skill. For the runtime
implementation, install the [`protect-mcp`](https://github.com/wshobson/agents/tree/9ecda7f8fe82dde1b0f6a7d4d26e3b6f1f2f3cca/plugins/protect-mcp) plugin. If the target compliance framework or environment constraints are not stated, say so before recommending a policy configuration.

## What this gives you

Every tool call (`Bash`, `Edit`, `Write`, `WebFetch`) is:

1. **Evaluated against a Cedar policy** before execution. If the policy denies
   the call, the tool does not run.
2. **Signed as an Ed25519 receipt** after execution. Receipts are
   JCS-canonical and verifiable offline by anyone with the public key.

An auditor, regulator, or counterparty can verify every receipt later
(Step 5). No network call, no vendor lookup, no trust in the operator.

## When to use the pattern

- **Regulated environments** (finance, healthcare, critical infrastructure)
  where you need tamper-evident evidence of agent behavior
- **CI/CD pipelines** where you want to prove that a policy gate held for
  every automated build step
- **Multi-party collaboration** where a counterparty wants to verify your
  agent's behavior without trusting your operator
- **Compliance contexts** (EU AI Act Article 12, SLSA provenance for
  agent-built software) where standard logging is not sufficient

## Step 1: Install the hook configuration

Install the `protect-mcp` plugin with `/plugin install protect-mcp`. Its hooks
run `evaluate.sh` before each tool call and `sign.sh` after it. Both scripts
read the hook event from stdin, because Claude Code sets no `TOOL_NAME` or
`TOOL_INPUT` variables. The plugin registers both hooks in its
`hooks/hooks.json`, so you do not need to edit `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": ".*", "hooks": [{ "type": "command", "command": "\"$CLAUDE_PLUGIN_ROOT\"/hooks/evaluate.sh" }] }
    ],
    "PostToolUse": [
      { "matcher": ".*", "hooks": [{ "type": "command", "command": "\"$CLAUDE_PLUGIN_ROOT\"/hooks/sign.sh" }] }
    ]
  }
}
```

Claude Code sends each hook event to the command as JSON on stdin. Each script
reads the JSON with `node` and passes the fields to protect-mcp as flags:

- `evaluate.sh` reads `tool_name` and `tool_input`, and it runs
  `protect-mcp@0.32.4 evaluate --policy ./protect.cedar --tool <name> --input <json>`.
  Exit 0 allows the call, and exit 2 blocks it. If the evaluator cannot run,
  the script also exits 2, so the call is blocked.
- `sign.sh` reads `tool_name`, and it runs
  `protect-mcp@0.7.4 sign --tool <name> --receipts ./receipts/ --key ./protect-mcp.key`.
  The 0.7.4 signer records only the tool name, and it appends each receipt to
  `./receipts/receipts.jsonl`.

Set `PROTECT_MCP_POLICY`, `PROTECT_MCP_RECEIPTS`, or `PROTECT_MCP_KEY` to
change these paths.

protect-mcp 0.7.4 does not create the signing key, and without a key the
receipts are unsigned. Create `./protect-mcp.key` once. The command never
replaces an existing key:

```bash
if [ ! -e ./protect-mcp.key ]; then
  d=$(mktemp -d) && npx protect-mcp@0.32.4 init --dir "$d" && mv "$d/keys/gateway.json" ./protect-mcp.key
fi
chmod 600 ./protect-mcp.key
```

Give auditors the `publicKey` value from that file. Do not commit the file,
because it also holds the private key.

Add the private key and receipt directory to `.gitignore`:

```bash
echo "/protect-mcp.key" >> .gitignore
echo "/receipts/" >> .gitignore
```

## Step 2: Write a Cedar policy

Create `./protect.cedar`. protect-mcp 0.7 and later evaluate each tool call
against it before the tool runs:

```cedar
// protect-mcp >= 0.7 evaluates each call as Action::"MCP::Tool::call" on
// Tool::"<name>", with the tool input at context.input.

// Allow all read-oriented tools by default.
permit (principal, action == Action::"MCP::Tool::call", resource) when {
    resource == Tool::"Read" || resource == Tool::"Glob" ||
    resource == Tool::"Grep" || resource == Tool::"WebSearch"
};

// Allow Bash commands from a safe list only (prefix match; git limited to
// read subcommands). Package-manager and build permits (npm, pnpm, yarn,
// make) run arbitrary code, so they are only as safe as the project's scripts.
permit (principal, action == Action::"MCP::Tool::call", resource == Tool::"Bash") when {
    context has input && context.input has command &&
    (context.input.command like "git status*" || context.input.command like "git diff*" ||
     context.input.command like "git log*" || context.input.command like "git show*" ||
     context.input.command like "npm*" ||
     context.input.command like "pnpm*" || context.input.command like "yarn*" ||
     context.input.command like "ls*" || context.input.command like "cat*" ||
     context.input.command like "pwd*" || context.input.command like "echo*" ||
     context.input.command like "test*" || context.input.command like "make*")
};

// Explicit deny on destructive commands. Cedar deny is authoritative.
// Substring matching on shell commands is best-effort.
forbid (principal, action == Action::"MCP::Tool::call", resource == Tool::"Bash") when {
    context has input && context.input has command &&
    (context.input.command like "*rm -rf*" || context.input.command like "*dd if=*" ||
     context.input.command like "*mkfs*" || context.input.command like "*shred*")
};

// No chaining, `$` expansion, redirection, or file output, so a permitted
// prefix cannot carry a second command, read a secret such as
// `echo "$API_TOKEN"`, or write a file (`git diff --output`). `&` also covers
// `&&` and denies `2>&1`, `$` covers `$(`, and `<` covers input redirects,
// `<(` and `<<`, which suits a strict allow list.
forbid (principal, action == Action::"MCP::Tool::call", resource == Tool::"Bash") when {
    context has input && context.input has command &&
    (context.input.command like "*;*" || context.input.command like "*&*" ||
     context.input.command like "*|*" || context.input.command like "*$*" ||
     context.input.command like "*`*" || context.input.command like "*>*" ||
     context.input.command like "*<*" || context.input.command like "*\n*" ||
     context.input.command like "*--output*")
};

// Restrict writes to the project (Claude Code passes absolute paths).
// `like` matches the raw string, so it is not a path containment check:
// the forbid rejects `..` segments.
permit (principal, action == Action::"MCP::Tool::call", resource) when {
    (resource == Tool::"Write" || resource == Tool::"Edit") &&
    context has input && context.input has file_path &&
    context.input.file_path like "/path/to/project/*"
};
forbid (principal, action == Action::"MCP::Tool::call", resource) when {
    (resource == Tool::"Write" || resource == Tool::"Edit") &&
    context has input && context.input has file_path &&
    (context.input.file_path like "*/../*" || context.input.file_path like "*/..")
};
```

Six rules:

- Read-oriented tools always allowed
- `Bash` allowed for safe command patterns (`git status`, `npm`, etc.)
- `Bash rm -rf` and similar destructive commands explicitly denied
- Shell chaining, substitution, redirection, and `--output` explicitly denied
- Writes allowed only within the project (its path prefix)
- Writes through a `..` path segment explicitly denied

Cedar `forbid` rules take precedence over `permit` rules, so destructive
commands cannot be bypassed by a later permissive rule.

## Step 3: Use Claude Code normally

Start Claude Code. Every tool call goes through both hooks:

```
You: Please read the README and summarize it.

Claude: I will read README.md.
  [PreToolUse: Read ./README.md -> allow]
  [Tool: Read executes]
  [PostToolUse: receipt rcpt-a8f3c9d2 signed to ./receipts/]

... summary of README ...
```

A session of 20 tool calls appends 20 receipts to `./receipts/receipts.jsonl`.

## Step 4: Inspect a receipt

protect-mcp 0.7.4 appends each receipt as one line of
`./receipts/receipts.jsonl`. Print the newest one:

```bash
tail -n 1 ./receipts/receipts.jsonl | python3 -m json.tool
```

Each line is a signed v2 envelope like this one:

```json
{
  "v": 2,
  "type": "decision_receipt",
  "algorithm": "ed25519",
  "kid": "generated",
  "issuer": "protect-mcp",
  "issued_at": "2026-09-26T12:59:48.265Z",
  "payload": {
    "tool": "Read",
    "decision": "allow",
    "reason_code": "post_execution_receipt",
    "policy_digest": "none",
    "scope": "tu-1790427588265-c8x5",
    "mode": "enforce",
    "request_id": "tu-1790427588265-c8x5",
    "spec": "draft-farley-acta-signed-receipts-01",
    "issuer_certification": "self-signed"
  },
  "signature": "0b5d28f45db30666c6addbc6e417e4825104b04b..."
}
```

The receipt records the tool name, and it does not record the tool input or
output. Changing any signed field after signing, such as `issued_at`,
`issuer`, or `payload.decision`, makes verification fail. The receipt holds no
public key: the verifier needs the `publicKey` value from `./protect-mcp.key`,
which you pass with `--key`.

## Step 5: Verify the receipts

Pass the `publicKey` value from `./protect-mcp.key` to the verifier:

```bash
PUB=$(node -p 'JSON.parse(require("fs").readFileSync("./protect-mcp.key")).publicKey')
npx @veritasacta/verify@0.9.2 --replay-chain ./receipts/receipts.jsonl --key "$PUB"
```

Exit codes:

| Code | Meaning |
|------|---------|
| `0`  | Every receipt verified |
| `1`  | A receipt failed verification (tampered, wrong key, or malformed line) |
| `2`  | The receipts file could not be read |

## Step 6: Demonstrate tamper detection

Change the newest receipt's `decision` from `allow` to `deny`:

```bash
python3 -c "
import json
path = './receipts/receipts.jsonl'
lines = open(path).read().splitlines()
r = json.loads(lines[-1])
r['payload']['decision'] = 'deny'
lines[-1] = json.dumps(r)
open(path, 'w').write('\n'.join(lines) + '\n')
"

npx @veritasacta/verify@0.9.2 --replay-chain ./receipts/receipts.jsonl --key "$PUB"
```

The verifier exits with code `1` and reports which line failed. The
Ed25519 signature no longer matches the JCS-canonical bytes of the
tampered payload.

Restore the field and verification passes again.

## How the cryptography works

Two invariants make receipts verifiable offline across any conformant
implementation:

1. **JCS canonicalization (RFC 8785)** before signing. Keys sorted by
   UTF-16 code units, whitespace minimized, strings not normalized. Two
   independent implementations produce byte-identical signing payloads for
   the same receipt content.
2. **Ed25519 signatures (RFC 8032)** over the canonical bytes.
   Deterministic, fixed-size, no nonce dependency.

protect-mcp 0.7.4 receipts carry no link to the previous receipt, so a
deleted or reordered receipt goes undetected: the verifier checks each
signature, not the sequence.

For the formal wire format see
[draft-farley-acta-signed-receipts](https://datatracker.ietf.org/doc/draft-farley-acta-signed-receipts/).

## Cross-implementation interop

The receipt format has four independent implementations today:

| Implementation | Language | Use case |
|----------------|----------|----------|
| [protect-mcp](https://www.npmjs.com/package/protect-mcp) | TypeScript | Claude Code, Cursor, MCP hosts |
| [protect-mcp-adk](https://pypi.org/project/protect-mcp-adk/) | Python | Google Agent Development Kit |
| [sb-runtime](https://github.com/ScopeBlind/sb-runtime) | Rust | OS-level sandbox (Landlock + seccomp) |
| APS governance hook | Python | CrewAI, LangChain |

A receipt produced by any of them verifies against
[`@veritasacta/verify`](https://www.npmjs.com/package/@veritasacta/verify).
The auditor does not need to trust the operator's tooling choice: the format
is the contract.

## CI/CD integration

Verify receipts in CI so a tampered receipt fails the build. The signing key
is gitignored, so a CI job needs it from a secret. Create an environment named
`receipt-signing` and limit its deployment branches to the default branch.
Store the contents of `./protect-mcp.key` as that environment's secret
`PROTECT_MCP_KEY`, and store its `publicKey` value as the repository variable
`PROTECT_MCP_PUBLIC_KEY`. Without the key, the receipts are unsigned and the
verify step exits 1.

Run this job only on reviewed code, such as pushes to the default branch. Do
not run it on pull requests: GitHub passes no secrets to a fork's pull request
run, and on a same-repository branch the job would run that branch's
`scripts/run_agent.py` after it writes the key to disk, so the branch could
exfiltrate the key. The environment's branch limit is a second guard if
someone later adds a pull request trigger.

```yaml
# .github/workflows/verify-receipts.yml
name: Verify Decision Receipts
on:
  push:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    environment: receipt-signing
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - name: Install signing key
        env: { KEY: '${{ secrets.PROTECT_MCP_KEY }}' }
        run: umask 077 && printf '%s' "$KEY" > protect-mcp.key
      - name: Run governed agent
        run: python scripts/run_agent.py
      - name: Verify receipts
        env: { PUB: '${{ vars.PROTECT_MCP_PUBLIC_KEY }}' }
        run: npx @veritasacta/verify@0.9.2 --replay-chain receipts/receipts.jsonl --key "$PUB"
      - name: Upload receipts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: decision-receipts
          path: receipts/
```

The upload step keeps the receipts after the job ends, including when the
verify step fails.

## Composition with SLSA provenance for agent-built software

When Claude Code builds and releases software (running `npm install`,
`npm build`, `npm publish` as tool calls), the receipt chain is the
per-step build log. SLSA Provenance v1 has an extension point for this: the
`byproducts` field can reference the receipt chain alongside the build
attestation.

The [agent-commit build type](https://refs.arewm.com/agent-commit/v0.2)
documents the pattern using the ResourceDescriptor shape:

```json
{
  "name": "decision-receipts",
  "digest": { "sha256": "..." },
  "uri": "oci://registry/org/build-xyz/receipts:sha256-...",
  "annotations": {
    "predicateType": "https://veritasacta.com/attestation/decision-receipt/v0.1",
    "signerRole": "supervisor-hook"
  }
}
```

The SLSA provenance is signed by the builder identity; the receipt
attestation is signed by the supervisor-hook identity. Two trust domains,
cross-referenced at the byproduct layer. See
[slsa-framework/slsa#1594](https://github.com/slsa-framework/slsa/issues/1594)
for the composition discussion.

## Common pitfalls

**Private key in version control.** The generated `./protect-mcp.key` must
not be committed. The examples above add it to `.gitignore`. If a key is
accidentally committed, rotate it immediately. Move the key and
`./receipts/receipts.jsonl` to an archive, then run the Step 1 key command
again. Verify the archived receipts with the old public key.

**Hook payload on stdin.** Claude Code sets no `$TOOL_NAME` or `$TOOL_INPUT`
variables. A hook command that passes `--tool "$TOOL_NAME"` sends an empty
tool name, so the policy denies every call. Read the payload from stdin as the
plugin scripts do.

**Receipts directory in CI.** If Claude Code runs in CI, upload receipts as
an artifact at the end of the job or the receipts are lost at job end.

**Policy is missing.** When `./protect.cedar` does not exist, `evaluate.sh`
prints a warning to stderr and allows the call. No call is gated until you
create the policy in Step 2.

## Related in this marketplace

- [`protect-mcp`](https://github.com/wshobson/agents/tree/9ecda7f8fe82dde1b0f6a7d4d26e3b6f1f2f3cca/plugins/protect-mcp) — the runtime hook implementation
  (use this plugin in production)
- [`review-agent-governance`](https://github.com/wshobson/agents/tree/9ecda7f8fe82dde1b0f6a7d4d26e3b6f1f2f3cca/plugins/review-agent-governance) — require
  human approval before review-surface actions; composes with protect-mcp

## References

- [`draft-farley-acta-signed-receipts`](https://datatracker.ietf.org/doc/draft-farley-acta-signed-receipts/) — IETF draft, receipt wire format
- [RFC 8032](https://datatracker.ietf.org/doc/html/rfc8032) — Ed25519
- [RFC 8785](https://datatracker.ietf.org/doc/html/rfc8785) — JCS
- [Cedar policy language](https://docs.cedarpolicy.com/)
- [protect-mcp on npm](https://www.npmjs.com/package/protect-mcp)
- [@veritasacta/verify on npm](https://www.npmjs.com/package/@veritasacta/verify)
- [in-toto/attestation#549](https://github.com/in-toto/attestation/pull/549) — Decision Receipt predicate proposal
- [agent-commit build type](https://refs.arewm.com/agent-commit/v0.2) — SLSA provenance for agent-produced commits
- [Microsoft Agent Governance Toolkit](https://github.com/microsoft/agent-governance-toolkit) (`examples/protect-mcp-governed/`)
- [AWS Cedar for Agents](https://github.com/cedar-policy/cedar-for-agents)
