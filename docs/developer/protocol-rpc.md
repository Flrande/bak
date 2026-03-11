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

## Public Command Families

- `bak session ...`: create, inspect, repair, focus, reset, and close agent-isolated browser state plus session-owned tabs
- `bak tabs ...`: direct browser-wide tab inspection and control outside the session helpers
- `bak page`, `bak context`, `bak element`, `bak debug`, `bak network`, `bak table`, `bak inspect`, `bak capture`, `bak keyboard`, `bak mouse`, and `bak file`: tab-scoped reads and actions that default to the current session tab
- `bak call`: protocol fallback for methods that do not have a dedicated command yet

## CLI Vs RPC

The CLI is intentionally task-oriented. The protocol is broader.

Use first-class CLI commands for common workflows such as:

- session creation, binding repair, session focus/reset, and tab targeting
- direct browser tab inspection and recovery
- page reads, runtime JS extraction, page-context fetches, freshness checks, and snapshots
- network inspection, request replay, table extraction, inspect workflows, and capture exports
- element actions

Use `bak call` when the protocol has a method without a dedicated CLI command.

Planned command growth should preserve the current noun-based surface instead of reviving `workspace` terminology. For example, protocol-only navigation helpers such as `page.back`, `page.forward`, `page.reload`, and `page.scrollTo` would naturally become `bak page ...` commands if they graduate out of `bak call`.

```powershell
bak call --method page.reload --params "{}" --rpc-ws-port 17374
```

## Health And Compatibility

- `runtime.info` reports protocol version, compatible versions, extension connection state, and runtime health
- `session.info` reports the session descriptor, active session tab summary, and current context snapshot
- `context.get` and `context.set` expose the saved frame/shadow snapshot for the current session tab
- `bak doctor` surfaces protocol and version drift as warnings instead of silent failures
