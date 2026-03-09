# Protocol And RPC

## Transport

- JSON-RPC 2.0
- stdio JSON-RPC from the daemon
- WebSocket JSON-RPC at `ws://127.0.0.1:<rpcPort>/rpc`
- extension bridge at `ws://127.0.0.1:<port>/extension?token=<pairToken>`

## Canonical Definitions

- protocol types: `packages/protocol/src/types.ts`
- protocol schema: `packages/protocol/schemas/protocol.schema.json`
- CLI builder: `packages/cli/src/program.ts`

## CLI Vs RPC

The CLI is intentionally task-oriented. The protocol is broader.

Use first-class CLI commands for common workflows such as:

- workspace creation and tab targeting
- page reads and snapshots
- element actions
- explicit memory workflows

Use `bak call` when the protocol has a method without a dedicated CLI command.

```powershell
bak call --method page.reload --params "{}" --rpc-ws-port 17374
```

## Health And Compatibility

- `session.info` reports protocol version, compatible versions, extension connection state, active tab summary, context stack, and memory backend status
- `bak doctor` surfaces protocol and version drift as warnings instead of silent failures
