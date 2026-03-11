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

## Wrong Tab Or Session Target

Symptoms:

- commands run against the wrong page
- page reads do not match what the agent expects

Actions:

1. Inspect the session with `bak session info --session-id <sessionId> --rpc-ws-port 17374`.
2. List tracked session tabs with `bak session list-tabs --session-id <sessionId> --rpc-ws-port 17374`.
3. Check the current session tab with `bak session get-active-tab --session-id <sessionId> --rpc-ws-port 17374`.
4. Set the intended session tab with `bak session set-active-tab --session-id <sessionId> --tab-id <id> --rpc-ws-port 17374`.
5. If the session binding is missing or broken, run `bak session ensure --session-id <sessionId> --rpc-ws-port 17374`.

## Frame Or Shadow Context Confusion

Symptoms:

- `bak page title` or `bak page url` shows a child document
- an element lookup succeeds in one step and fails in the next

Actions:

1. Inspect the saved snapshot with `bak context get --session-id <sessionId> --rpc-ws-port 17374`.
2. Reset the context with `bak context reset --session-id <sessionId> --rpc-ws-port 17374`.
3. Re-enter the frame or shadow root intentionally.
4. If needed, restore an explicit snapshot with `bak context set --session-id <sessionId> --frame-path <selector...> --host-selectors <selector...> --rpc-ws-port 17374`.
5. Verify with `bak debug dump-state --session-id <sessionId> --include-snapshot --rpc-ws-port 17374`.

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
