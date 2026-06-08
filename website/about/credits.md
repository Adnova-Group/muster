# Credits

Muster's design was inspired by [atomic-claude](https://atomic.alonso.network/), [superpowers](https://github.com/obra/superpowers), and gsd-core. It vendors a curated set of MIT-licensed skills and agents, with every source and item recorded for attribution.

## Vendored sources

| Source | License | Provides |
| --- | --- | --- |
| obra/superpowers | MIT | Brainstorming, planning, TDD, code-review, debugging, verification skills |
| wshobson/agents | MIT | Software and knowledge-work agents and skills across many specialties |
| open-gsd/gsd-core | MIT | Plan, execute, and verify workflow phases |

Every vendored item is listed in `vendor/manifest.yaml` with its repository, license, and ref, and provenance is written into [NOTICE](https://github.com/Adnova-Group/muster/blob/main/NOTICE).

## Clean-room specialists

Alongside the vendored material, Muster ships its own specialists in `plugin/agents/`, authored fresh from the role concept:

- **muster-surgeon**: precise 1-2 file edits
- **muster-builder**: a cohesive vertical slice
- **muster-reviewer**: verdict-emitting review
- **muster-investigator**: read-only locator
- **muster-strategist**: heavyweight reasoning

## License

Muster is licensed under Apache-2.0. See [LICENSE](https://github.com/Adnova-Group/muster/blob/main/LICENSE) and [NOTICE](https://github.com/Adnova-Group/muster/blob/main/NOTICE).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](https://github.com/Adnova-Group/muster/blob/main/CONTRIBUTING.md) to get started.
