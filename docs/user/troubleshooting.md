# Troubleshooting

## First Check: `doctor`

```powershell
npx bak doctor
```

`doctor` separates:

- blocking checks (`summary.errorChecks`)
- non-blocking checks (`summary.warningChecks`)

## Common Problems

### Extension Not Connected

Symptoms:
- `extensionConnected=false`
- `E_NOT_READY` / `E_NOT_PAIRED`

Actions:
1. Run `npx bak pair status`.
2. Re-generate token with `npx bak pair`.
3. Reconnect from extension popup with matching port.
4. Confirm daemon is running on that port.

### RPC Not Reachable

Symptoms:
- CLI `call` fails to connect `ws://127.0.0.1:<rpcPort>/rpc`

Actions:
1. Restart daemon with explicit `--rpc-ws-port`.
2. Pass the same port to all commands with `--rpc-ws-port`.

### Heartbeat Stale / Session Looks Disconnected

Symptoms:
- `heartbeatStale=true`
- stale connection warnings

Actions:
1. Refresh active tab and retry a simple read command (`page url`).
2. Restart extension and daemon if stale state persists.

### Memory Backend Fallback

Symptoms:
- `requestedBackend=sqlite`, actual backend is `json`

Actions:
1. Check Node runtime is 22.x.
2. Run `npx bak memory export --backend sqlite` and inspect fallback reason.
3. Continue with JSON backend until SQLite prerequisites are fixed.

### Need Shareable Diagnostics

```powershell
npx bak export --out ./.bak-data/diag.zip
```

Optional snapshot images:

```powershell
npx bak export --include-snapshots --out ./.bak-data/diag-with-images.zip
```
