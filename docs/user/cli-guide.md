# CLI Guide

`bak` is the runtime bridge between your coding agent and a real browser extension.

Install from npm:

```powershell
npm install @flrande/bak-cli @flrande/bak-extension
```

Run commands with:

```powershell
npx bak <command>
```

## Core Runtime Commands

Runtime:

- `bak setup`: generate token + print extension path + next commands.
- `bak serve`: start daemon and RPC endpoints.
- `bak doctor`: runtime diagnostics.
- `bak export`: export redacted diagnostics zip.
- `bak gc`: retention cleanup (dry-run unless `--force`).

Pairing:

- `bak pair`
- `bak pair status`
- `bak pair revoke`

Browser basics:

- `bak tabs list|new|focus|get|close|active`
- `bak page goto|wait|url|title`
- `bak debug console`

Memory:

- `bak record start|stop`
- `bak skills list|show|retrieve|run|delete`
- `bak memory migrate|export`

## Agent Integration Pattern

Keep one long-running daemon:

```powershell
npx bak serve --port 17373 --rpc-ws-port 17374
```

Faster first-time startup:

```powershell
npx bak serve --pair --port 17373 --rpc-ws-port 17374
```

Or pre-generate setup instructions:

```powershell
npx bak setup
```

Then let the agent issue commands in another shell:

```powershell
npx bak doctor --port 17373 --rpc-ws-port 17374
npx bak tabs active --rpc-ws-port 17374
npx bak page goto "https://example.com" --rpc-ws-port 17374
npx bak page title --rpc-ws-port 17374
```

For methods without dedicated subcommands, use `call`:

```powershell
npx bak call --method page.snapshot --params "{}" --rpc-ws-port 17374
npx bak call --method element.click --params '{"locator":{"css":"button[type=submit]"}}' --rpc-ws-port 17374
npx bak call --method network.list --params '{}' --rpc-ws-port 17374
```

## Ports And Data Directory

- `--port`: extension bridge port (default `17373`)
- `--rpc-ws-port`: JSON-RPC WebSocket port (default `17374`)
- `--data-dir`: override `.bak-data` location on supported commands

## Environment Variables

- `BAK_DATA_DIR`: data root (`.bak-data` by default)
- `BAK_PORT`: default extension bridge port
- `BAK_RPC_WS_PORT`: default RPC WebSocket port
- `BAK_PAIR_TTL_DAYS`: default token TTL
- `BAK_HEARTBEAT_MS`: heartbeat interval
- `BAK_MEMORY_BACKEND`: `json` or `sqlite`
- `BAK_MEMORY_RECORD_INPUT_TEXT`: `1` to keep typed-input text in memory records
- `BAK_MEMORY_RETRIEVE_MIN_SCORE`: retrieval threshold
