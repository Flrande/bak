# Troubleshooting

Use this page only after the install and upgrade flow in [quickstart.md](./quickstart.md). It is for recovery, not first-time setup.

## Start With Doctor

```powershell
bak doctor --port 17373 --rpc-ws-port 17374
bak status --port 17373 --rpc-ws-port 17374
```

`bak doctor` is still the recommended first check. It auto-starts the local runtime when needed unless you are intentionally running `bak serve` yourself for foreground debugging.

Check:

- `summary.errorChecks` for blocking problems
- `summary.warningChecks` for advisory issues

## Extension Not Connected

Symptoms:

- `extensionConnected: false`
- `E_NOT_READY` or `E_NOT_PAIRED`

Actions:

1. Run `bak status --port 17373 --rpc-ws-port 17374` to see whether the local runtime is already up on the expected ports.
2. If needed, re-run `bak doctor --port 17373 --rpc-ws-port 17374` to auto-start the local runtime again.
3. Open the extension popup and reconnect with the current token and port `17373`.
4. If needed, mint a fresh token with `bak setup`.
5. Run `bak doctor` again.

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

1. Check the current runtime state with `bak status --port 17373 --rpc-ws-port 17374`.
2. Stop the local runtime with `bak stop --port 17373 --rpc-ws-port 17374`.
3. Re-run `bak doctor --port 17373 --rpc-ws-port 17374` to auto-start a clean runtime.
4. Pass the same `--rpc-ws-port` on every CLI command.
5. Remember that a managed background runtime now auto-stops after the last session closes. If you just finished a task, rerun `bak doctor --port 17373 --rpc-ws-port 17374` or the next CLI command to auto-start it again.
6. If the RPC socket is still unreachable and you need foreground logs, run `bak serve --port 17373 --rpc-ws-port 17374` manually in a separate PowerShell 7 window and retry the failing command. Foreground `bak serve` does not auto-stop.

## Browser Command Fails Before It Reaches A Page

Symptoms:

- browser-affecting commands now fail before opening or reading a page
- the error asks for `--session-id` or `--client-name`

Actions:

1. Remember the session auto-resolution order: `--session-id` > `BAK_SESSION_ID` > `--client-name` > `BAK_CLIENT_NAME` > `CODEX_THREAD_ID`.
2. For normal agent work, pass a stable `--client-name` or ensure `CODEX_THREAD_ID` is already present in the environment.
3. If you need visibility into the exact session mapping, run `bak session resolve --client-name <name> --rpc-ws-port 17374`.
4. Use an explicit `--session-id` for handoff, debugging, or cross-process reuse.
5. Do not expect browser-affecting commands to silently fall back to the global active tab anymore.

## Wrong Tab Or Session Target

Symptoms:

- commands run against the wrong page
- page reads do not match what the agent expects

Actions:

1. Inspect browser-wide tabs with `bak tabs list --rpc-ws-port 17374` if you need to map a raw browser tab id to the current window.
2. Inspect the session with `bak session info --session-id <sessionId> --rpc-ws-port 17374` or resolve it first with `bak session resolve --client-name <name> --rpc-ws-port 17374`.
3. List tracked session tabs with `bak session list-tabs --session-id <sessionId> --rpc-ws-port 17374`.
4. Check the current session tab with `bak session get-active-tab --session-id <sessionId> --rpc-ws-port 17374`.
5. Remember that `bak session open-tab ...` does not change the session's default current tab unless you passed `--active`.
6. Set the intended session tab with `bak session set-active-tab --session-id <sessionId> --tab-id <id> --rpc-ws-port 17374`.
7. Use `bak tabs list`, `bak tabs get`, and `bak tabs active` for browser-wide diagnostics. Treat `bak tabs new`, `bak tabs focus`, and `bak tabs close` as recovery-only compatibility commands that still stay inside the resolved session.
8. If the correct browser tab exists outside the session-owned window, open a fresh session tab with `bak session open-tab --session-id <sessionId> --url <url> --active --rpc-ws-port 17374` instead of continuing on the unmanaged tab.
9. If the dedicated session window or tracked tabs are missing, run `bak session ensure --session-id <sessionId> --rpc-ws-port 17374` or simply retry the browser-affecting command with the same session identity so the runtime can auto-repair first.

## Session Or Runtime Disappeared After Closing Tabs

Symptoms:

- a session no longer appears in `bak session list`
- `bak status` shows the runtime stopped after browser tabs were closed

Actions:

1. This can be expected now. Closing the last tab in a session auto-closes that session.
2. When the managed background runtime sees that all sessions are closed, it auto-stops too.
3. Recreate or reopen work with `bak session resolve --client-name <name> --rpc-ws-port 17374` and then `bak session open-tab --client-name <name> --url <url> --active --rpc-ws-port 17374`.
4. If you need a runtime that stays up regardless of session count, switch intentionally to foreground `bak serve` for debugging. That foreground process does not auto-stop.

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
