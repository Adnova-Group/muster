# ChatGPT Work

This is Muster's private/local ChatGPT Work integration lane. Plugins are available in ChatGPT Work on the web and in the ChatGPT desktop app when ChatGPT → Work is selected. Codex Desktop is a separate product surface; Work does not inherit Codex configuration, skills, hooks, MCP servers, or `config.toml`.

## Support boundary

OpenAI's universal plugin format lets the same plugin directory serve supported ChatGPT and Codex surfaces. For local development, use a repo or personal Plugins Directory marketplace. The documented local/repo source is the desktop proof lane: restart or refresh ChatGPT Desktop, select the local/repo marketplace source, and install the plugin. Do not generalize local marketplace ingestion to Work web; use Work web only when an independently supported source is available. A tunnel-backed local plugin is not eligible for public submission: Secure MCP Tunnel is private transport, while public distribution requires a stable public HTTPS MCP endpoint.

Muster's recommended `pro-safe` Work profile is read-only and narrow. Pro users can use developer-mode MCP connections for read/fetch access, subject to a successful native **Scan Tools** gate in the active Work host; full MCP is not a Pro entitlement. The [`developer mode and MCP apps` policy](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt-beta) describes the current Business/Enterprise/Edu full-MCP rollout. Muster's `full` profile is the existing 28-tool deterministic MCP surface—not write support—and requires that workspace entitlement plus both installer and server opt-ins.

## Install the mapping

Register the developer-mode MCP connection in ChatGPT, then pass its technical ID to Muster. OpenAI displays IDs with a `plugin_asdk_app_...` prefix; Muster accepts that spelling and removes only the initial `plugin_` before persisting it. The normalized `asdk_app_...` value is an identifier, not a secret.

```sh
muster install chatgpt-work --connection-id plugin_asdk_app_... \
  --profile pro-safe --scope project --dry-run
muster install chatgpt-work --connection-id plugin_asdk_app_... \
  --profile pro-safe --scope project
```

Use `--scope user` for a personal install. The exact full-profile command is:

```sh
muster install chatgpt-work --connection-id asdk_app_... \
  --profile full --allow-full-actions --scope user
```

`--dry-run` performs validation and prints the target without writing. Muster keeps this mapping in its own receipt (`.git/muster/chatgpt-work.json` for project scope or `<home>/.muster/chatgpt-work.json` for user scope) and carries it into later generated Codex builds; it never commits a workspace-specific ID to the repository.

`--profile` is mandatory; `pro-safe` is the recommended Pro-compatible profile. The installer returns `pluginPath`: `<cwd>/.agents/plugins/plugin` for project scope or `<home>/.agents/plugins/plugin` for user scope. The receipt is `.git/muster/chatgpt-work.json` for project scope or `<home>/.muster/chatgpt-work.json` for user scope. Inspect the returned path and receipt rather than assuming another plugin copy.

The generated plugin's minimal app wiring is:

```json
{
  "apps": {
    "muster": { "id": "asdk_app_<normalized-id>" }
  }
}
```

`.codex-plugin/plugin.json` points to it with `"apps": "./.app.json"`; the Work bundle's minimal `.mcp.json` is self-contained and does not inherit Codex configuration.

## Register and run the private tunnel

Enable ChatGPT developer mode with the workspace policy required by your plan. Register a Tunnel connection in ChatGPT Plugins and associate the tunnel with the target ChatGPT workspace and the Platform organization that owns it. Personal Platform association does not automatically grant visibility in an Enterprise/Edu workspace.

Secure MCP Tunnel is outbound-only. In the generated plugin root, keep the local server private and start the latest `tunnel-client` against its generated server:

```sh
export CONTROL_PLANE_API_KEY="sk-..."
tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile muster-chatgpt-work \
  --tunnel-id tunnel_... \
  --mcp-command "node runtime/chatgpt-work-server.mjs"
tunnel-client doctor --profile muster-chatgpt-work --explain
tunnel-client run --profile muster-chatgpt-work
```

For the native proof run, use an existing private probe directory and a new attestation path. Export the variables before `tunnel-client init` so they are inherited by the `--mcp-command` child. The generated runtime's dedicated probe mode is selected only by these variables; it strips unrelated credentials, permits one exact call, and writes the server attestation:

```sh
export MUSTER_CHATGPT_WORK_PROFILE=pro-safe
export MUSTER_CHATGPT_WORK_PROBE_NONCE=<32-lowercase-hex-nonce>
export MUSTER_CHATGPT_WORK_PROBE_ATTESTATION_PATH=/absolute/private/probe-dir/server-attestation.json
export MUSTER_CHATGPT_WORK_CONNECTION_ID=asdk_app_...
export MUSTER_CHATGPT_WORK_APP_JSON_PATH=/absolute/path/to/installed/.app.json
export MUSTER_CHATGPT_WORK_PLUGIN_VERSION=0.5.0
export MUSTER_CHATGPT_WORK_CONNECTION_LABEL="Muster ChatGPT Work"
tunnel-client init --sample sample_mcp_stdio_local --profile muster-chatgpt-work \
  --tunnel-id tunnel_... --mcp-command "node runtime/chatgpt-work-server.mjs"
tunnel-client run --profile muster-chatgpt-work
```

On POSIX, the probe directory must already exist, be owned by the current user, and have no group/world permissions (for example `0700`); the attestation file is created as a new `0600` file. Windows native proof is `HUMAN-HOLD` until privacy and ownership can be established. On every platform, an attestation collision is `HUMAN-HOLD`, not an overwrite.

The runtime key authenticates the OpenAI Platform tunnel control plane and incurs Platform API billing. It is separate from a ChatGPT Pro subscription and must never be placed in a plugin, receipt, screenshot, or documentation example beyond the redacted placeholder. A tunnel ID is also treated as sensitive operational data; retain only a digest in proof records.

For `pro-safe`, use `MUSTER_CHATGPT_WORK_PROFILE=pro-safe`. The server exposes only `muster_prioritize`, titled **Prioritize backlog items**, with `readOnlyHint=true`, `destructiveHint=false`, and `openWorldHint=false`. For full, use `MUSTER_CHATGPT_WORK_PROFILE=full` together with `MUSTER_CHATGPT_WORK_SERVER_ALLOW_FULL_ACTIONS=1`; the generated full install supplies the installer-side opt-in. Missing or unknown profiles fail closed.

## Refresh after metadata changes

Tool metadata can be frozen by the ChatGPT workspace. After changing the profile, title, annotations, schema, or description, use **Refresh** in the app/workspace controls when available. If Refresh is unavailable—or on a workspace where published app metadata cannot be updated—recreate the developer connection/app and reinstall the local plugin copy, then start a new Work chat. Do not infer that a changed file is loaded merely because it exists on disk.

## Native proof contract

Run the probe with the real installed identity to emit a fresh nonce-bearing run sheet. A passing record requires all of the following:

```sh
node scripts/chatgpt-work-native-probe.mjs \
  --connection-id asdk_app_... --app-json /path/to/installed/.app.json \
  --plugin-version 0.5.0 --connection-label "Muster ChatGPT Work"
```

- the operator sees a completed native `muster_prioritize` card in Work (web or desktop), with the exact nonce request and deterministic result;
- the local server writes a separate attestation naming the same nonce/tool/request/result, `invocationCount: 1`, and a normalized timestamp;
- the record binds SHA-256(normalized connection ID), SHA-256(installed `.app.json`), plugin name/version, and connection label;
- independent before/during inventories show probe-owned connection/profile/plugin/marketplace/cache/UI artifacts as absent/present, and phase-1 `after` remains present while the attestation is retained; collisions are `HUMAN-HOLD`;
- the tunnel is stopped and only provably probe-owned artifacts are deleted after the evidence grade; re-inventory must verify absence and zero retained artifacts before cleanup finalization.

Operator UI evidence is an observation, not cryptographic provenance. Skill discovery, `tools/list`, assistant prose, tunnel health, screenshots, logs, and a Codex invocation do not satisfy the gate. Never fabricate native proof, retain secrets, or publish it.

For an identity-bound grade, provide the normalized ID and exact installed `.app.json` bytes; the grader recomputes both SHA-256 values:

```sh
node scripts/chatgpt-work-native-probe.mjs --grade receipt.json --nonce <nonce> \
  --server-attestation attestation.json --connection-id asdk_app_... \
  --app-json /path/to/installed/.app.json --plugin-version 0.5.0 \
  --connection-label "Muster ChatGPT Work"
```

The grade is phase 1 and must run before deleting the attestation. Do not invent an uninstall command: after `evidence-graded`, stop the tunnel, verify ownership of the exact plugin/marketplace/receipt/probe paths, remove only this run's artifacts, and use `HUMAN-HOLD` for collisions or uncertain ownership. Write the verified-absence cleanup record and finalize phase 2:

```sh
node scripts/chatgpt-work-native-probe.mjs --finalize-cleanup cleanup.json --nonce <nonce> \
  --connection-id asdk_app_... --app-json /path/to/installed/.app.json \
  --plugin-version 0.5.0 --connection-label "Muster ChatGPT Work"
```
