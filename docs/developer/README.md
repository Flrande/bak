# Developer Onboarding

Use this page when you are contributing to `bak`, not when you are trying to install it for an agent.

## Read In This Order

1. [../../README.md](../../README.md) for the product surface and public terminology
2. [architecture.md](./architecture.md) for the runtime shape and subsystem boundaries
3. [../TECH_SPEC.md](../TECH_SPEC.md) for session targeting, context behavior, and product invariants
4. [../PROTOCOL.md](../PROTOCOL.md) for the public method and payload surface
5. [protocol-rpc.md](./protocol-rpc.md) for CLI/RPC mapping and transport behavior
6. [security-privacy.md](./security-privacy.md) for runtime trust boundaries
7. [ops-release.md](./ops-release.md) for release gates and generated artifacts

## Current Implementation Assumptions

- the product surface is the CLI daemon plus the Chromium extension
- `session` is the default agent isolation boundary
- reads, actions, debug output, and dynamic-data helpers all resolve against the same session tab plus context stack
- public docs and CLI help use `session` and `tabs` as the top-level nouns, not `workspace`
- low-change protocol and reporting material lives under [../reference/README.md](../reference/README.md)
