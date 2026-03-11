# Troubleshooting

## Start With Doctor

```powershell
bak doctor --port 17373 --rpc-ws-port 17374
```

Check:

- `summary.errorChecks` for blocking problems
- `summary.warningChecks` for advisory issues

## Extension Not Connected

Symptoms:

- `extensionConnected: false`
- `E_NOT_READY` or `E_NOT_PAIRED`

Actions:

1. Confirm `bak serve --port 17373 --rpc-ws-port 17374` is still running.
2. Open the extension popup and reconnect with the current token and port `17373`.
3. If needed, mint a fresh token with `bak setup`.
4. Run `bak doctor` again.

## RPC Not Reachable

Symptoms:

- commands fail to connect to `ws://127.0.0.1:<rpcPort>/rpc`

Actions:

1. Restart the daemon with explicit ports.
2. Pass the same `--rpc-ws-port` on every CLI command.
3. Re-run `bak doctor`.

## Wrong Tab Or Workspace Target

Symptoms:

- commands run against the wrong page
- page reads do not match what the agent expects

Actions:

1. Inspect the workspace with `bak workspace info --rpc-ws-port 17374`.
2. Check the current workspace tab with `bak workspace get-active-tab --rpc-ws-port 17374`.
3. Set the intended workspace tab with `bak workspace set-active-tab --tab-id <id> --rpc-ws-port 17374`.
4. If the workspace is missing or broken, run `bak workspace ensure --rpc-ws-port 17374`.

## Frame Or Shadow Context Confusion

Symptoms:

- `bak page title` or `bak page url` shows a child document
- an element lookup succeeds in one step and fails in the next

Actions:

1. Reset the context with `bak context reset --rpc-ws-port 17374`.
2. Re-enter the frame or shadow root intentionally.
3. Verify with `bak debug dump-state --include-snapshot --rpc-ws-port 17374`.

## Need Shareable Diagnostics

```powershell
$bakDataDir = Join-Path $env:LOCALAPPDATA 'bak'
bak export --out (Join-Path $bakDataDir 'diag.zip')
```

Include raw snapshots only when they are necessary:

```powershell
$bakDataDir = Join-Path $env:LOCALAPPDATA 'bak'
bak export --include-snapshots --out (Join-Path $bakDataDir 'diag-with-images.zip')
```
