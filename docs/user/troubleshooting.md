# Troubleshooting

## First Check

```powershell
bak doctor --port 17373 --rpc-ws-port 17374
```

`doctor` reports:

- blocking checks in `summary.errorChecks`
- non-blocking checks in `summary.warningChecks`

## Common Problems

### Extension Not Connected

Symptoms:

- `extensionConnected=false`
- `E_NOT_READY` or `E_NOT_PAIRED`

Actions:

1. Run `bak pair status`.
2. Rotate token with `bak pair`.
3. Reconnect in extension popup with port `17373`.
4. Confirm daemon is running.

### RPC Not Reachable

Symptoms:

- RPC connection errors on `ws://127.0.0.1:<rpcPort>/rpc`

Actions:

1. Restart daemon with explicit ports.
2. Use the same `--rpc-ws-port` on all commands.

### Old CLI Version Missing `setup` Or `serve --pair`

Symptoms:

- `unknown command 'setup'`
- `error: unknown option '--pair'`

Actions:

1. Update package to latest release.
2. Temporary fallback:

```powershell
bak pair
bak serve --port 17373 --rpc-ws-port 17374
```

### Heartbeat Stale / Session Disconnected

Symptoms:

- `heartbeatStale=true`
- stale connection warnings

Actions:

1. Refresh active tab and retry `bak page url`.
2. Restart extension and daemon if state remains stale.

### Memory Backend Fallback

Symptoms:

- requested backend is `sqlite`, runtime backend is `json`

Actions:

1. Check Node runtime is 22.x.
2. Run `bak memory export --backend sqlite` and inspect fallback details.
3. Continue with JSON backend until prerequisites are fixed.

### Need Shareable Diagnostics

```powershell
bak export --out ./.bak-data/diag.zip
```

Include snapshot images only when required:

```powershell
bak export --include-snapshots --out ./.bak-data/diag-with-images.zip
```
