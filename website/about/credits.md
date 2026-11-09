# Credits

Muster's design was inspired by [atomic-claude](https://github.com/damusix/atomic-claude) ([site](https://atomic.alonso.network/)), [superpowers](https://github.com/obra/superpowers), and [gsd-core](https://github.com/open-gsd/gsd-core). It vendors a curated set of MIT-licensed skills and agents, and every skill, agent, command, output style and pipeline that is based on an external repository says which one in its own `upstream:` field.

## How provenance is recorded

[`vendor/manifest.yaml`](https://github.com/Adnova-Group/muster/blob/main/vendor/manifest.yaml) is the single source of truth. Each item's `upstream:` field, the catalog provenance summary, and [NOTICE](https://github.com/Adnova-Group/muster/blob/main/NOTICE) (with each upstream's copyright line) are generated from it by `muster provenance --write`, and the test suite fails when any of them drift. An item with `upstream: []` is Muster-authored. Each entry names the repository, the pinned commit, the upstream path, the license, and the relation:

| Relation | Meaning |
| --- | --- |
| vendored | upstream text carried essentially unchanged |
| adapted | upstream text edited |
| mechanism-port | a mechanism re-implemented in new text |
| inspired-by | an idea, structure, or framework named; no text carried over |

The Codex plugin carries the same record as `NOTICE` and `PROVENANCE.md`, since Codex skill headers cannot hold the field.

## Vendored sources

| Source | License | Provides |
| --- | --- | --- |
| obra/superpowers | MIT | Brainstorming, planning, TDD, code-review, debugging, verification skills |
| wshobson/agents | MIT | Software and knowledge-work agents and skills across many specialties |
| open-gsd/gsd-core | MIT | Plan, execute, and verify workflow phases (and the Codex `muster-gsd-*` fallbacks) |

## Other sources

| Source | License | Basis for | Relation |
| --- | --- | --- | --- |
| pbakaus/impeccable @ `32930818a109fafa87199babe92fa8e530cff5d3` | Apache-2.0 | `/muster:design` workflow vocabulary, the design-UX audit pattern | inspired-by |
| blader/humanizer, rudra496/StealthHumanizer, conorbronsdon/avoid-ai-writing, aaaronmiller/humanize-writing | MIT | muster-humanizer | adapted |
| jalaalrd/anti-ai-slop-writing | none | muster-humanizer (tell taxonomy, tiered vocabulary) | adapted |
| hermes-labs-ai/lintlang | Apache-2.0 | muster-prompt-smith lint taxonomy | mechanism-port |
| promptfoo/promptfoo, shobrook/promptimal | MIT | muster-prompt-smith eval and optimizer patterns | inspired-by |
| felipelobomotta-blip/book-genesis-studio (formerly book-genesis-v4) | MIT | book pipeline, muster-scorer | mechanism-port, inspired-by |
| NousResearch/autonovel | none | book pipeline (phase order, continuity ledger) | mechanism-port |
| damusix/atomic-claude | MIT | the six muster role agents, the Muster output style | inspired-by |
| obra/superpowers, wshobson/agents, VoltAgent/awesome-claude-code-subagents, humanlayer/12-factor-agents, contains-studio/agents, disler/infinite-agentic-loop | MIT, MIT, MIT, Apache-2.0 + CC BY-SA 4.0, none, none | muster-runner (clean-room synthesis) | mechanism-port |
| hesreallyhim/awesome-claude-code | CC BY-NC-ND 4.0 | muster-runner research index | inspired-by |
| deanpeters/product-manager-prompts, deanpeters/Product-Manager-Skills, phuryn/pm-skills, anthropics/knowledge-work-plugins, joelparkerhenderson/objectives-and-key-results, architecture-decision-record/architecture-decision-record | CC BY-NC-SA 4.0, CC BY-NC-SA 4.0, MIT, Apache-2.0, none, CC BY-NC-SA 4.0 | PM and engineering-document pipelines | inspired-by |
| coreyhaines31/marketingskills, CosmoBlk/email-marketing-bible, AgriciDaniel/claude-email | MIT | battlecard, lead-magnet, case-study, newsletter pipelines | inspired-by |
| SkeltonThatcher/run-book-template, dastergon/awesome-sre, runbear-io/awesome-runbook | none, CC0-1.0, CC0-1.0 | runbook pipeline | inspired-by |

Sources with no license or a NonCommercial license each carry a `licenseWaivers` entry in the manifest that records the open question for the maintainers.

## Upstream routing on Codex

On Codex, Muster prefers an enabled authoritative upstream implementation over its own copy whenever one exists: the official [Superpowers](https://github.com/obra/superpowers) plugin, [wshobson](https://github.com/wshobson/agents)'s per-plugin Codex skills, and GSD's installer-generated Codex skills.

The bundled `sp-*`, `wsh-*`, and `muster-gsd-*` skills are deterministic **fallbacks**: they keep every role resolvable when an upstream is absent, and they never implicitly install those providers on your behalf. The pinned compatibility survey — which upstreams were checked, at which refs, including Atomic Codex, Book Genesis, the humanizer sources, and Promptfoo — is recorded in [`codex/upstreams.json`](https://github.com/Adnova-Group/muster/blob/main/codex/upstreams.json).

## Clean-room specialists

Alongside the vendored material, Muster ships its own specialists in `plugin/agents/`, authored fresh from atomic-claude's role concept (muster-runner from the lifecycle mechanisms listed above):

- **muster-surgeon**: precise 1-2 file edits
- **muster-builder**: a cohesive vertical slice
- **muster-reviewer**: verdict-emitting review
- **muster-investigator**: read-only locator
- **muster-strategist**: heavyweight reasoning
- **muster-improver**: read-only post-run retrospective that proposes self-improvement edits
- **muster-runner**: single-item lifecycle driver — TDD build, explicit-PASS review gate, receipts-backed PR (the dispatchable subagent form of the runner mode)

## Additional inspiration (clean-room, mechanism-level)

A cluster of systems introduced in 0.5.0 -- the sprint coordination protocol (claim/receipt/ledger discipline), the citation-guard gate, QA runbook memory, the voice/audience/brand profile system, newsletter signal-diff, the assumption checker, and the document-ingestion contract -- were designed with mechanism-level inspiration from Nate B. Jones's Unlock AI open-skills/open-engine patterns ([unlock-ai.natebjones.com](https://unlock-ai.natebjones.com)). No code, prose, or configuration was copied; Muster's implementations are original, adapted to its own deterministic-CLI/model-facing-skill architecture.

## License

Muster is licensed under Apache-2.0. See [LICENSE](https://github.com/Adnova-Group/muster/blob/main/LICENSE) and [NOTICE](https://github.com/Adnova-Group/muster/blob/main/NOTICE).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](https://github.com/Adnova-Group/muster/blob/main/CONTRIBUTING.md) to get started.
