# Developer Docs

Primary references:
- [architecture.md](./architecture.md)
- [../TECH_SPEC.md](../TECH_SPEC.md)
- [../PROTOCOL.md](../PROTOCOL.md)
- [protocol-rpc.md](./protocol-rpc.md)
- [security-privacy.md](./security-privacy.md)

Current architecture assumptions:
- protocol baseline is `v3`
- memory storage is sqlite-only
- route, procedure, and composite memories replace the old skill-centric design
- browser read/debug APIs must honor the same context stack used by actions
