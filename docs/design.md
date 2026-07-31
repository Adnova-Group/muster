# Design mode

Muster Design gives human-facing work one canonical context and one digest receipt before implementation. It is inspired by the workflow vocabulary in [Impeccable](https://github.com/pbakaus/impeccable), pinned at commit `32930818a109fafa87199babe92fa8e530cff5d3` under Apache-2.0. Muster does not silently import or overwrite upstream content.

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

Run a workflow with `muster design run <workflow> [dir] --target <path>`, or use the harness shortcut `/muster:design <workflow> [target]`. The 23 pinned workflow names are:

`craft`, `init`, `document`, `extract`, `live`, `adapt`, `animate`, `audit`, `bolder`, `clarify`, `colorize`, `critique`, `delight`, `distill`, `harden`, `onboard`, `layout`, `optimize`, `overdrive`, `polish`, `quieter`, `shape`, and `typeset`.

Every workflow packet carries its resolved `DESIGN.md` digest, target scope, provider, and pinned source reference. The same contract is available through `muster_design` in MCP-only runtimes.
