# Protocol And RPC

## Transport

- JSON-RPC 2.0
- CLI daemon supports:
  - stdio JSON-RPC
  - WebSocket JSON-RPC: `ws://127.0.0.1:<rpcPort>/rpc`
- Extension bridge endpoint:
  - `ws://127.0.0.1:<port>/extension?token=<pairToken>`

## Canonical Definitions

- Method/type source: `packages/protocol/src/types.ts`
- JSON schema: `packages/protocol/schemas/protocol.schema.json`
- Full v2 capability matrix: [docs/PROTOCOL_V2.md](../PROTOCOL_V2.md)
- Legacy baseline notes: [docs/PROTOCOL.md](../PROTOCOL.md)

## Error Codes

- `E_NOT_PAIRED`
- `E_PERMISSION`
- `E_NOT_FOUND`
- `E_NEED_USER_CONFIRM`
- `E_TIMEOUT`
- `E_INVALID_PARAMS`
- `E_INTERNAL`
- `E_NOT_READY`

## CLI Surface Vs RPC Surface

- `packages/cli/src/bin.ts` exposes high-frequency workflows as explicit subcommands.
- Long-tail methods remain available through:

```powershell
node packages/cli/dist/bin.js call --method <method.name> --params '<json>'
```

This keeps CLI usability and protocol completeness decoupled.

## Versioning And Compatibility

- v2 is additive over v1 (concurrent clients are supported).
- New fields/methods should not break existing request/response shapes.
- Protocol changes must update both TS types and schema artifacts.
