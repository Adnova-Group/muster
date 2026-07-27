# Documentation index

The website is the reader-facing manual. This directory holds repository-level design notes, operating references, research records, and historical decisions.

## Architecture

- [Architecture](architecture.md): runtime layers, routing, modes, execution, and enforcement.
- [Anti-patterns](anti-patterns.md): implementation and orchestration mistakes the project rejects.

## Binding

- [Harness binding interface](binding-interface.md): the primitives each harness must provide and their degradation paths.

## Operations

- [Configuration reference](https://adnova-group.github.io/muster/reference/configuration): supported environment variables and runtime controls.
- [Commands reference](https://adnova-group.github.io/muster/reference/commands): CLI and mode command details.
- [Security policy](../SECURITY.md): private reporting, support, and disclosure expectations.

## Research

- [`research/`](research/): dated, source-backed harness investigations. These records support implementation decisions but are not the user contract.

## Historical

Other focused notes in this directory record completed investigations, validation receipts, and compatibility decisions. Treat current code, tests, the architecture document, and the published website as authoritative when a historical note differs.
