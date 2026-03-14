# Troubleshooting

Use this page only after the install and upgrade flow in [quickstart.md](./quickstart.md). It is for recovery, not first-time setup.

## Start With Doctor

```powershell
bak doctor --port 17373 --rpc-ws-port 17374
bak doctor --fix --port 17373 --rpc-ws-port 17374
bak status --port 17373 --rpc-ws-port 17374
bak session dashboard --rpc-ws-port 17374
```

`bak doctor` is still the recommended first check. It auto-starts the local runtime when needed unless you are intentionally running `bak serve` yourself for foreground debugging.

Start with these fields instead of guessing from raw state:

- `diagnosis[]` for the concrete issue code, severity, and root cause
- `fixesApplied[]` for safe local repairs already attempted by `bak doctor --fix`
- `nextActions[]` for the exact command, path, or manual recovery step
- `summary.errorChecks` for blocking check names
- `summary.warningChecks` for advisory check names

Use `bak session dashboard` when the runtime is up but you still need to understand which sessions are attached, detached, or pointing at the wrong active tab/context.

## Policy Workflow

If a browser action looks risky or gets blocked, use the policy workflow before editing `.bak-policy.json` by hand:

```powershell
bak policy status
bak policy preview --action element.click --client-name <name> --css "#submit" --rpc-ws-port 17374
bak policy audit --action element.click --limit 20
bak policy recommend --decision requireConfirm --min-occurrences 2
```

Use these commands in order:

1. `bak policy status` to confirm which local policy file is active and what the default safety posture is.
2. `bak policy preview` to answer "would this action be allowed?" without executing the action or mutating the page.
3. `bak policy audit` to read recent `policy.decision` events as structured JSON instead of raw trace lines.
4. `bak policy recommend` to generate conservative, trace-derived suggestions for repeated default `deny` or `requireConfirm` outcomes. It does not rewrite `.bak-policy.json`.

## PAIRING_MISSING / PAIRING_EXPIRED / PAIRING_REVOKED

Symptoms:

- `diagnosis[].code` is `PAIRING_MISSING`, `PAIRING_EXPIRED`, or `PAIRING_REVOKED`
- `nextActions[]` points at `bak setup`
- the popup shows `token required` or keeps failing after reconnects

Actions:

1. Run `bak setup`.
2. Open the extension popup and paste the fresh token.
3. Keep port `17373`.
4. Click `Save settings`.
5. If needed, click `Reconnect bridge`.
6. Re-run `bak doctor`.

## PAIRING_TOKEN_MISMATCH

Symptoms:

- `diagnosis[].code` is `PAIRING_TOKEN_MISMATCH`
- the popup has a token saved, but the runtime still rejects the bridge
- `nextActions[]` points at `bak pair status`

Actions:

1. Run `bak pair status`.
2. Open the popup and compare the saved token with the active CLI token.
3. Paste the active token into the popup and click `Save settings`.
4. If needed, click `Reconnect bridge`.
5. Re-run `bak doctor`.

## EXTENSION_VERSION_DRIFT

Symptoms:

- `diagnosis[].code` is `EXTENSION_VERSION_DRIFT`
- `summary.warningChecks` contains `versionCompatibility`
- `cliVersion` is newer than `extensionVersion`
- you upgraded `@flrande/bak-extension`, but `bak doctor` still reports the older extension version

Actions:

1. Confirm the unpacked extension path is still `Join-Path (npm root -g) '@flrande\bak-extension\dist'`.
2. Open `edge://extensions` or `chrome://extensions`.
3. Click `Reload` on `Browser Agent Kit`, or restart the browser if you prefer.
4. Open the popup again if needed, confirm the same token and port, and click `Save settings` if you changed either value.
5. If the popup still does not show a connected state, open `Advanced bridge controls` and click `Reconnect bridge`.
6. Re-run `bak doctor` and confirm the `versionCompatibility` warning is gone.

## RUNTIME_STOPPED / RUNTIME_STALE_METADATA

Symptoms:

- `diagnosis[].code` is `RUNTIME_STOPPED` or `RUNTIME_STALE_METADATA`
- `nextActions[]` points at `bak doctor --fix`
- `bak status` shows the managed runtime is not up or the stored pid is stale

Actions:

1. Run `bak doctor --fix --port 17373 --rpc-ws-port 17374`.
2. Check `fixesApplied[]` to confirm whether the CLI rewrote config, cleared stale metadata, or restarted the managed runtime.
3. If the runtime still does not come back, run `bak status --port 17373 --rpc-ws-port 17374`.
4. If needed, run `bak stop --port 17373 --rpc-ws-port 17374` and then `bak doctor --port 17373 --rpc-ws-port 17374`.

## RPC_UNREACHABLE

Symptoms:

- `diagnosis[].code` is `RPC_UNREACHABLE`
- commands fail to connect to `ws://127.0.0.1:<rpcPort>/rpc`

Actions:

1. Check the current runtime state with `bak status --port 17373 --rpc-ws-port 17374`.
2. Stop the local runtime with `bak stop --port 17373 --rpc-ws-port 17374`.
3. Re-run `bak doctor --port 17373 --rpc-ws-port 17374` to auto-start a clean runtime.
4. Pass the same `--rpc-ws-port` on every CLI command.
5. Remember that a managed background runtime now auto-stops after the last session closes. If you just finished a task, rerun `bak doctor --port 17373 --rpc-ws-port 17374` or the next CLI command to auto-start it again.
6. If the RPC socket is still unreachable and you need foreground logs, run `bak serve --port 17373 --rpc-ws-port 17374` manually in a separate PowerShell 7 window and retry the failing command. Foreground `bak serve` does not auto-stop.

## PORT_CONFLICT

Symptoms:

- `diagnosis[].code` is `PORT_CONFLICT`
- `nextActions[]` says another process is already bound to the bridge or rpc port

Actions:

1. Stop the conflicting process or choose a different port pair.
2. Re-run `bak doctor --port <port> --rpc-ws-port <rpcPort>`.
3. If you changed ports, update the popup to use the same bridge port before reconnecting.

## EXTENSION_NOT_CONNECTED / EXTENSION_HEARTBEAT_STALE

Symptoms:

- `diagnosis[].code` is `EXTENSION_NOT_CONNECTED` or `EXTENSION_HEARTBEAT_STALE`
- the runtime is up, but the popup still shows a disconnected or retrying bridge
- `bak session dashboard` shows runtime up with no attached browser work

Actions:

1. Open the popup and confirm the token and port.
2. Click `Save settings` if you changed either value.
3. Click `Reconnect bridge`.
4. If the heartbeat stays stale after reconnecting, reload the unpacked extension.
5. Re-run `bak doctor`.

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

1. Start with `bak session dashboard --rpc-ws-port 17374` to see attached/detached sessions, the current active tab, and current context depth in one place.
2. Inspect browser-wide tabs with `bak tabs list --rpc-ws-port 17374` if you need to map a raw browser tab id to the current window.
3. Inspect the session with `bak session info --session-id <sessionId> --rpc-ws-port 17374` or resolve it first with `bak session resolve --client-name <name> --rpc-ws-port 17374`.
4. List tracked session tabs with `bak session list-tabs --session-id <sessionId> --rpc-ws-port 17374`.
5. Check the current session tab with `bak session get-active-tab --session-id <sessionId> --rpc-ws-port 17374`.
6. Remember that `bak session open-tab ...` does not change the session's default current tab unless you passed `--active`.
7. Set the intended session tab with `bak session set-active-tab --session-id <sessionId> --tab-id <id> --rpc-ws-port 17374`.
8. Use `bak tabs list`, `bak tabs get`, and `bak tabs active` for browser-wide diagnostics. Treat `bak tabs new`, `bak tabs focus`, and `bak tabs close` as recovery-only compatibility commands that still stay inside the resolved session.
9. If the correct browser tab exists outside the current session group, open a fresh session tab with `bak session open-tab --session-id <sessionId> --url <url> --active --rpc-ws-port 17374` instead of continuing on the unmanaged tab.
10. If the current browser window, a session group, or tracked tabs are missing from the session state, run `bak session ensure --session-id <sessionId> --rpc-ws-port 17374` or simply retry the browser-affecting command with the same session identity so the runtime can auto-repair first.

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
