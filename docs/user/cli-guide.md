# CLI Guide

`bak` is the command interface between your coding agent and the browser extension runtime.

For first-time setup, use [quickstart.md](./quickstart.md). This guide only covers command usage after setup.

## Core Runtime Commands

Runtime:

- `bak setup`
- `bak serve`
- `bak doctor`
- `bak export`
- `bak gc`

Pairing:

- `bak pair`
- `bak pair status`
- `bak pair revoke`

Browser:

- `bak tabs list|new|focus|get|close|active`
- `bak page goto|wait|url|title`
- `bak debug console`

Memory:

- `bak record start|stop`
- `bak skills list|show|retrieve|run|delete`
- `bak memory migrate|export`

## Minimal Daily Flow

In daemon terminal:

```powershell
bak serve --port 17373 --rpc-ws-port 17374
```

In agent terminal:

```powershell
bak doctor --port 17373 --rpc-ws-port 17374
bak tabs active --rpc-ws-port 17374
bak page goto "https://example.com" --rpc-ws-port 17374
bak page wait --mode text --value "Example Domain" --rpc-ws-port 17374
```

## Full RPC Access Through `call`

Use `call` for methods that do not have dedicated subcommands:

```powershell
bak call --method page.snapshot --params "{}" --rpc-ws-port 17374
bak call --method element.click --params '{"locator":{"css":"button[type=submit]"}}' --rpc-ws-port 17374
bak call --method network.list --params '{}' --rpc-ws-port 17374
```

## Ports, Data Directory, And Env

Common options:

- `--port`: extension bridge port (default `17373`)
- `--rpc-ws-port`: RPC WebSocket port (default `17374`)
- `--data-dir`: override `.bak-data` on supported commands

Environment variables:

- `BAK_DATA_DIR`
- `BAK_PORT`
- `BAK_RPC_WS_PORT`
- `BAK_PAIR_TTL_DAYS`
- `BAK_HEARTBEAT_MS`
- `BAK_MEMORY_BACKEND`
- `BAK_MEMORY_RECORD_INPUT_TEXT`
- `BAK_MEMORY_RETRIEVE_MIN_SCORE`

## Notes

- Keep one long-running `bak serve` process per session.
- Use explicit waits (`bak page wait`) before read/write operations.
- If `bak` is missing from PATH, use `npx bak <command>`.
