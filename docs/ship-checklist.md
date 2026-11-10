# Ship checklist (`TARGET_VERSION` bar)

Run this checklist from the release checkout. Set `TARGET_VERSION` to the version being
shipped; when it is omitted, the package manifest supplies the target:

```sh
export TARGET_VERSION="${TARGET_VERSION:-$(node -p "require('./package.json').version")}"
printf 'Shipping %s\n' "$TARGET_VERSION"
```

The bar is finite. Complete every gate below before publishing, and record the command output
with the release receipt.

1. **Manifest gate**: every published manifest carries `TARGET_VERSION` and the lockfile root
   agrees with it.

   ```sh
   node -e 'const fs=require("fs"); const target=process.env.TARGET_VERSION; const files=["package.json","package-lock.json","plugin.json","plugin/.claude-plugin/plugin.json"]; for (const file of files) { const value=JSON.parse(fs.readFileSync(file,"utf8")); if (value.version!==target) throw new Error(`${file}: ${value.version} != ${target}`); } if (JSON.parse(fs.readFileSync("package-lock.json","utf8")).packages[""].version!==target) throw new Error("package-lock root version does not match TARGET_VERSION");'
   ```

2. **Changelog gate**: `CHANGELOG.md` has a dated heading and comparison link for
   `TARGET_VERSION`; the release notes are not left only under `[Unreleased]`.

   ```sh
   grep -Eq "^## \\[${TARGET_VERSION//./\\.}\\] - [0-9]{4}-[0-9]{2}-[0-9]{2}$" CHANGELOG.md
   grep -Eq "^\\[${TARGET_VERSION//./\\.}\\]: https://github.com/Adnova-Group/muster/compare/v" CHANGELOG.md
   ```

3. **Plugin runtime gate**: every marketplace install runs the CLI bundled at
   `plugin/runtime/cli/` (built by `scripts/build-plugin-runtime.mjs`), so the committed bundle
   must be rebuilt after the version bump and match its sources byte for byte. `npm test` and
   `prepublishOnly` run the same check; a stale bundle names the paths that differ.

   ```sh
   npm run build:plugin
   npm run check:plugin
   node -e 'const v=require("./plugin/runtime/cli/package.json").version; if (v!==process.env.TARGET_VERSION) throw new Error(`plugin runtime ${v} != ${process.env.TARGET_VERSION}`)'
   ```

   `runtime/muster.sh` falls back to `npx -y @adnova-group/muster@<plugin version>` only for a
   plugin copy without the bundle, so publish `@adnova-group/muster@${TARGET_VERSION}` to npm
   before the release commit reaches the marketplace branch as well:

   ```sh
   npm view "@adnova-group/muster@${TARGET_VERSION}" version
   ```

4. **Tag gate**: after the release commit is published, the annotated or lightweight tag
   `v${TARGET_VERSION}` resolves to a commit.

   ```sh
   git rev-parse --verify "refs/tags/v${TARGET_VERSION}^{commit}"
   ```

5. **Green suite**: `npm test` (the pretest hook builds the Codex bundle; never gate on bare
   `node --test`).
6. **Codex package gate**: `npm run check:codex` passes against the generated distribution.
7. **Dependency audit**: `npm audit --json` at the repository root and in `website/` reports
   zero vulnerabilities.
8. **Package inspection**: run `npm pack --dry-run --json`, inspect the reported file list,
   identity, version, size, and entry count, and confirm no secrets, local state, or machine paths
   are included. The dry run must not leave a tarball behind.
9. **Documentation website**: from `website/`, run `npm run docs:build`; then run the repository's
   website/docs tests so navigation, links, anchors, public support claims, release pins, and brand
   assets are checked together.
10. **Tree integrity**: `git diff --check` passes and `git status --short` is empty at the reviewed
   release commit.
11. **Install/doctor smoke**: `muster install <harness> --dry-run` plus `muster doctor` is clean
   on at least the Claude Code harness.

Context-health checks (Claude-5 context-engineering adoption, 2026-07-29):

12. **Prompt surface**: `node src/cli.js prompt scan .` reports zero failing files. The
   CTX-EXAMPLE-001 and CTX-RULE-001 ratchets guard against example and rule densification of
   Muster-authored prompts (`src/prompt-lint.js`).
13. **`claude doctor`**: run it in a session with the Muster plugin enabled and act on anything
   it reports about Muster's skills or `CLAUDE.md` footprint, Anthropic's own tooling for
   context-engineering drift.
