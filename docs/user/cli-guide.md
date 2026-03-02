# CLI Guide

`bak` exposes common workflows as subcommands and keeps full method coverage via `call`.

In this repo, invoke `bak` as:

```powershell
node packages/cli/dist/bin.js <command>
```

## Common Commands

### Runtime

- `bak serve`: start daemon and RPC endpoints.
- `bak doctor`: local diagnostics (blocking errors + non-blocking warnings).
- `bak export`: export redacted diagnostics zip.
- `bak gc`: retention cleanup (dry-run unless `--force`).

### Pairing

- `bak pair`
- `bak pair status`
- `bak pair revoke`

### Browser Basics

- `bak tabs list|new|focus|get|close|active`
- `bak page goto|wait|url|title`
- `bak debug console`

### Memory

- `bak record start|stop`
- `bak skills list|show|retrieve|run|delete`
- `bak memory migrate|export`

## Full Capability Via `call`

When a method has no dedicated subcommand, use:

```powershell
node packages/cli/dist/bin.js call --method <method.name> --params '<json>'
```

Examples:

```powershell
node packages/cli/dist/bin.js call --method page.snapshot --params "{}"
node packages/cli/dist/bin.js call --method element.click --params '{"locator":{"css":"button[type=submit]"}}'
node packages/cli/dist/bin.js call --method network.list --params '{}'
```

## Useful Options

- RPC port override: `--rpc-ws-port <port>` (default `17374`)
- Extension bridge port: `--port <port>` (default `17373`, used by `serve`/`doctor`/`export`)
- Data dir override: `--data-dir <path>` on selected commands

## Environment Variables

- `BAK_DATA_DIR`: data root (`.bak-data` by default)
- `BAK_PORT`: default extension bridge port
- `BAK_RPC_WS_PORT`: default RPC WebSocket port
- `BAK_PAIR_TTL_DAYS`: default token TTL
- `BAK_HEARTBEAT_MS`: heartbeat interval
- `BAK_MEMORY_BACKEND`: `json` or `sqlite`
- `BAK_MEMORY_RECORD_INPUT_TEXT`: `1` to keep typed-input text in memory records (off by default)
- `BAK_MEMORY_RETRIEVE_MIN_SCORE`: retrieval threshold
