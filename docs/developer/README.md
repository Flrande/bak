# Developer Docs

Primary references:

- [architecture.md](./architecture.md)
- [../TECH_SPEC.md](../TECH_SPEC.md)
- [../PROTOCOL.md](../PROTOCOL.md)
- [protocol-rpc.md](./protocol-rpc.md)
- [security-privacy.md](./security-privacy.md)
- [ops-release.md](./ops-release.md)

Current implementation assumptions:

- the product surface is the CLI daemon plus the Chromium extension
- the workspace is the default agent isolation boundary
- browser reads, actions, and debug output share one context stack
