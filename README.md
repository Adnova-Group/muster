# Muster

Glass-box, multi-domain agentic orchestrator for Claude Code. Give it an outcome; it assembles the right crew and shows its reasoning before it acts.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

## What it is

Muster turns an outcome into finished work. It detects your project, discovers the capabilities you already have installed, picks the best tool for each piece of the job, and runs a crew of specialists toward your success criteria. Every decision is inspectable: which role resolved to which provider, on which model, and why.

It runs on bare Claude Code with no extra services and no separate model API, and it gets better as you install more tools. The work is not limited to code. Product, business, content, and operations are first-class.

## Quickstart

```sh
npx muster install
```

`install` copies Muster's output style to `~/.claude/output-styles/muster.md` (idempotent: it skips an identical file and backs up a different one to `.bak`), then prints the steps it cannot do for you:

```sh
/plugin marketplace add <repo>      # register the local marketplace
/plugin install muster@muster-local # install the plugin
/output-style muster                # enable the glass-box voice
```

Plugin install is a Claude Code action, so the running session picks Muster up only after you (re)install it through `/plugin`. Then run your first outcome:

```
/muster:run Add rate limiting to the public API with tests
```

## The four modes

| Mode | Command | What it does |
| --- | --- | --- |
| Run | `/muster:run <outcome>` | Plans, shows the crew manifest and plan, then stops for your approval. Does not execute. |
| Autopilot | `/muster:autopilot <outcome>` | Hands-off lifecycle: branch, route, run waves, commit per wave, present the merge. Stops only for the merge decision or an escalation. |
| Diagnose | `/muster:diagnose <symptom>` | Failure-first bug fix: reproduce, find root cause, fix, add a regression test, verify. No symptom-patching. |
| Audit | `/muster:audit [path]` | Breadth-first whole-codebase review and fix across six dimensions, then fixes everything with tests and verifies. |

Run and Autopilot accept a GitHub issue reference (a bare number, `#123`, or an issues URL) as the outcome. A thin outcome gets refined first: `muster assess` does a deterministic gap-check, and if the outcome is vague, an interview skill asks one question at a time behind an approval gate before any crew is assembled.

## How it works

The novel core is a capability and domain router. Muster names a fixed vocabulary of roles (the kinds of work a crew might need), and each role resolves through a ladder, best available first:

1. An installed external provider (a plugin, agent, or MCP server you already have)
2. A Muster built-in agent
3. A Muster built-in skill
4. Inline (the model does it directly)

`muster capabilities` walks this ladder for every role and reports the winner, the full fallback chain, installable recommendations, and the chosen model. Because the chain always ends at inline, every role resolves to something, so Muster works on bare Claude Code and improves as you add tools.

The role set is fixed but the provider set is not. When an outcome does not fit a named role, description-search bridges the gap: `muster match "<task>"` ranks every catalog provider by deterministic token overlap (no model call), so "audit this code for security vulnerabilities" surfaces the security specialist even though it never names a role.

Each role also carries a model picked to fit the work: mechanical roles run on Haiku, the default is Sonnet, and heavy judgment runs on Opus. Muster composes the tools you already have and falls back to its own. For the full design, see [docs/architecture.md](docs/architecture.md).

## Pipelines

A pipeline is a phased, gated recipe for producing one kind of artifact. Each declares a domain, an ordered list of phases, and a gate. Gating uses a floor principle: the weakest dimension must clear the floor and the total must clear a pass threshold, so a strong average cannot rescue one weak dimension.

The set spans software and knowledge work. A few examples: PRD, business-case, launch-plan, executive-summary, OKRs, AI implementation spec, competitive-battlecard, blog-post, case-study, runbook, and book (fiction and non-fiction). Roadmap prioritization is one to call out: goals go in, and a RICE-ranked now/next/later roadmap comes out, with the model estimating the factors and the CLI doing the arithmetic. Human-facing pipelines end with a humanize phase that strips em-dashes, AI-tell words, and robotic cadence.

## Built on

Muster's design was inspired by atomic-claude, superpowers, gsd-core, and book-genesis. It vendors a curated set of MIT-licensed skills and agents, with every source and item recorded for attribution:

| Source | License | Provides |
| --- | --- | --- |
| obra/superpowers | MIT | Brainstorming, planning, TDD, code-review, debugging, verification skills |
| wshobson/agents | MIT | Software and knowledge-work agents across many specialties |
| open-gsd/gsd-core | MIT | Plan, execute, and verify workflow phases |

Alongside the vendored material, Muster ships its own clean-room specialists, authored fresh from the role concept. Full provenance lives in [NOTICE](NOTICE).

## Contributing and license

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

Muster is licensed under Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
