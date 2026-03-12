# Troubleshooting

Use this page only after the install and upgrade flow in [quickstart.md](./quickstart.md). It is for recovery, not first-time setup.

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

## CLI / Extension Version Drift After Upgrade

Symptoms:

- `summary.warningChecks` contains `versionCompatibility`
- `cliVersion` is newer than `extensionVersion`
- you upgraded `@flrande/bak-extension`, but `bak doctor` still reports the older extension version

Actions:

1. Confirm the unpacked extension path is still `Join-Path (npm root -g) '@flrande\bak-extension\dist'`.
2. Open `edge://extensions` or `chrome://extensions`.
3. Click `Reload` on `Browser Agent Kit`, or restart the browser if you prefer.
4. Open the popup again if needed and reconnect with the same token and port.
5. Re-run `bak doctor` and confirm the `versionCompatibility` warning is gone.

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

1. Inspect browser-wide tabs with `bak tabs list --rpc-ws-port 17374` if you need to map a raw browser tab id to the current window.
2. Inspect the session with `bak session info --session-id <sessionId> --rpc-ws-port 17374`.
3. List tracked session tabs with `bak session list-tabs --session-id <sessionId> --rpc-ws-port 17374`.
4. Check the current session tab with `bak session get-active-tab --session-id <sessionId> --rpc-ws-port 17374`.
5. Remember that `bak session open-tab ...` does not change the session's default current tab unless you passed `--active`.
6. Set the intended session tab with `bak session set-active-tab --session-id <sessionId> --tab-id <id> --rpc-ws-port 17374`.
7. If the correct browser tab exists outside the session-owned window, open a fresh session tab with `bak session open-tab --session-id <sessionId> --url <url> --active --rpc-ws-port 17374` instead of continuing on the unmanaged tab.
8. If you only need to inspect the unmanaged tab, use `bak tabs ...` directly rather than rebinding the session onto it.
9. If the dedicated session window or tracked tabs are missing, run `bak session ensure --session-id <sessionId> --rpc-ws-port 17374`.

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

## Dynamic Page Shows Partial Or Stale Data

Symptoms:

- `bak page text` shows only a few visible rows
- a site looks live but inline data is older than expected
- important data is present in requests or scripts, not in visible DOM

Actions:

1. Start with `bak inspect page-data --session-id <sessionId> --rpc-ws-port 17374` to discover candidate globals, tables, recent requests, and recommended next steps.
2. Read page-world state with `bak page extract --session-id <sessionId> --path <global.path> --resolver auto --rpc-ws-port 17374` or `bak page eval --session-id <sessionId> --expr <expr> --rpc-ws-port 17374`.
3. If `page extract` returns `E_NOT_FOUND`, retry with `--resolver lexical` or confirm that the variable exists through `page eval`.
4. Inspect recent requests with `bak network list --session-id <sessionId> --rpc-ws-port 17374`, `bak network search --session-id <sessionId> --pattern <text> --rpc-ws-port 17374`, and `bak network get <id> --session-id <sessionId> --include request response --rpc-ws-port 17374`.
5. Retry the request from page context with `bak page fetch --session-id <sessionId> --url <url> --mode json --rpc-ws-port 17374` or replay a captured request with `bak network replay --session-id <sessionId> --request-id <id> --mode json --with-schema auto --rpc-ws-port 17374`. Add `--requires-confirm` when the request can mutate remote state.
6. If the data lives in a table or virtual grid, use `bak table list`, `bak table schema`, and `bak table rows --all`.
7. Confirm time freshness with `bak page freshness --session-id <sessionId> --rpc-ws-port 17374` and inspect update cadence with `bak inspect live-updates --session-id <sessionId> --rpc-ws-port 17374`.
8. Use `bak capture snapshot` or `bak capture har` if you need an artifact for offline analysis or a bug report.

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
