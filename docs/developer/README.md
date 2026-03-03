# Developer Docs

These docs are for contributors maintaining protocol, CLI, extension runtime, and release quality.

## Read In Order

1. [Architecture](./architecture.md): how the system is wired.
2. [Protocol + RPC](./protocol-rpc.md): contracts and compatibility.
3. [Ops + Release](./ops-release.md): quality gates and shipping workflow.
4. [Security + Privacy](./security-privacy.md): default protections and policies.

## Agent-First Dev Principle

- End-user setup flow must stay simple enough for agent execution from one quickstart URL.
- If runtime behavior changes, update docs in this order:
  1. `docs/user/quickstart.md`
  2. `docs/user/cli-guide.md`
  3. `docs/user/troubleshooting.md`
  4. this developer section

## Fast Links

- Canonical protocol matrix: [docs/PROTOCOL_V2.md](../PROTOCOL_V2.md)
- Generated quality artifacts: [docs/reference/README.md](../reference/README.md)
