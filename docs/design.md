# Design mode

Muster Design gives human-facing work one canonical context and one digest receipt before implementation. Its workflows run on [Impeccable](https://github.com/pbakaus/impeccable)'s own skill and references, vendored as `impeccable-*` builtins from commit `b856e5010f2dd86bd97f9b2d5e38e33f3d5bd992` (skill-v4.8.2) under Apache-2.0 and merge-tracked in `vendor/manifest.yaml`; each workflow names supporting skills from other vendored families as well. Muster does not silently import or overwrite upstream content: an upstream update is a reviewed 3-way merge.

## Establish context

Run `muster design status .` to resolve the nearest canonical `DESIGN.md`. In a monorepo, a package-local file wins; otherwise the repository root file is inherited. Resolution emits the exact scope, path, and SHA-256 digest used by later waves.

`muster design init` is attended. With no confirmed content it returns `HUMAN-HOLD` and asks for the product direction, visual constraints, typography, color, and component principles. After that answer has been saved to a file, pass it explicitly:

```sh
muster design init . --content-file confirmed-design.md
```

Initialization creates a missing canonical file atomically and never overwrites an existing one.

## Gate and detect

Human-facing write work must pass:

```sh
muster design gate . --outcome "implement responsive checkout UI" --write
```

A missing context blocks qualifying writes with `HUMAN-HOLD`. Read-only design audits continue and report the missing context as a risk finding. Outcomes without design, UI, UX, frontend, accessibility, or other human-facing signals return immediately without design-tree traversal or provider startup.

`muster design detect [scope]` performs a bounded scan: at most 250 files, 500 ms, and 64 KiB of evidence. Add stable exclusions with `muster design ignores [dir] --add <pattern>`.

## Providers and workflows

The internal provider works on Muster's supported Node 20 baseline. The optional detector is enabled only on Node 22.12 or newer:

```sh
muster design provider check .
muster design provider install .
```

Run a workflow with `muster design run <workflow> [dir] --target <path>`, or use the harness shortcut `/muster:design <workflow> [target]`. The 24 pinned workflow names are:

`craft`, `init`, `document`, `extract`, `live`, `generate`, `adapt`, `animate`, `audit`, `bolder`, `clarify`, `colorize`, `critique`, `delight`, `distill`, `harden`, `onboard`, `layout`, `optimize`, `overdrive`, `polish`, `quieter`, `shape`, and `typeset`.

`generate` turns one request ("3 bolder variants of the pricing cards") into a set of complete variants of a named element for the user to choose from. Its direction must map onto an existing refinement workflow (`bolder`, `quieter`, `distill`, `polish`, `typeset`, `colorize`, `layout`, `adapt`, `animate`, `delight`, `overdrive`); it defaults to 3 variants, caps at 8, and is web-only.

Every workflow packet carries its resolved `DESIGN.md` digest, target scope, provider, and pinned source reference. The same contract is available through `muster_design` in MCP-only runtimes.

## Optional: Mobbin MCP

Muster never bundles Mobbin. If your session already has the Mobbin MCP server, the workflows that choose a pattern, flow or screen structure (`craft`, `generate`, `bolder`, `onboard`, `layout`, `overdrive`, `shape`) search it for real app references first and cite the apps and screens they used. Without it they skip that step silently. Mobbin's MCP server needs a paid Mobbin Pro, Team or Enterprise plan. Set it up from [Mobbin's Claude guide](https://docs.mobbin.com/mcp/clients/claude-desktop-web), or from the CLI:

```sh
claude mcp add mobbin --scope user --transport http https://api.mobbin.com/mcp
```

Then run `/mcp` and authenticate. Mobbin screens are third-party product screenshots, used as reference only: never copy their proprietary assets or brand elements into your product.
