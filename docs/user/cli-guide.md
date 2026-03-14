# CLI Guide

`bak` is the agent-facing entrypoint to the paired browser extension.

This page assumes the runtime is already installed and healthy. If you still need install, upgrade, or extension reload steps, go back to [quickstart.md](./quickstart.md). In normal use, `bak` auto-starts the local runtime when needed.

## Command Map

- `bak session ...` is the default agent surface for resolving, repairing, focusing, resetting, and closing session-owned browser state plus tracked tabs.
- `bak session resolve` is the normal entrypoint when you have a stable client identity and want `bak` to find or create the matching session.
- `bak session dashboard` is the fastest visibility command when you need runtime health plus per-session ownership, active tab, and context depth in one JSON payload.
- `bak tabs list`, `bak tabs get`, and `bak tabs active` are browser-wide diagnostics.
- `bak tabs new`, `bak tabs focus`, and `bak tabs close` are recovery-only compatibility commands. They first resolve a session and only operate on that session's tabs.
- `bak page`, `bak context`, `bak element`, `bak debug`, `bak network`, `bak table`, `bak inspect`, `bak capture`, `bak keyboard`, `bak mouse`, and `bak file` target the current resolved session tab unless you override with `--tab-id` inside that same session.
- `bak session open-tab` opens a tab in the session's group inside the current browser window, but only `--active` or `bak session set-active-tab ...` changes which tab later session-scoped commands target by default.
- `bak call` covers protocol-only methods until they graduate into one of those noun groups.
- Older `workspace` wording is obsolete in the public CLI surface.

## How Session Resolution Works

Browser-affecting commands resolve their session with this precedence:

1. `--session-id`
2. `BAK_SESSION_ID`
3. `--client-name`
4. `BAK_CLIENT_NAME`
5. `CODEX_THREAD_ID`

If none of those are present, browser-affecting commands fail instead of silently targeting the global active tab. For agent flows, the normal pattern is a stable `--client-name` or an existing `CODEX_THREAD_ID`. Keep explicit `sessionId` values for handoff, debugging, or cross-process reuse.

## Start Every Session

```powershell
bak doctor --port 17373 --rpc-ws-port 17374
bak doctor --fix --port 17373 --rpc-ws-port 17374
bak status --port 17373 --rpc-ws-port 17374
```

`bak doctor` is the recommended first check and auto-starts the local runtime when needed unless you are intentionally running `bak serve` in the foreground for debugging. Use `bak doctor --fix` when you want the CLI to repair safe local runtime/config state before reporting the final diagnosis. Use `bak status` when you want to inspect whether the runtime is already up without changing your session flow.

If you want a clean runtime restart:

```powershell
bak stop --port 17373 --rpc-ws-port 17374
bak doctor --port 17373 --rpc-ws-port 17374
```

Then resolve or inspect the agent session state:

```powershell
$clientName = 'agent-a'
$session = bak session resolve --client-name $clientName --rpc-ws-port 17374 | ConvertFrom-Json
$sessionId = $session.sessionId
bak session dashboard --rpc-ws-port 17374
bak session info --client-name $clientName --rpc-ws-port 17374
bak session ensure --client-name $clientName --rpc-ws-port 17374
```

Common maintenance commands for the current browser window plus per-session groups:

```powershell
bak session list --rpc-ws-port 17374
bak session dashboard --rpc-ws-port 17374
bak session resolve --client-name $clientName --rpc-ws-port 17374
bak session focus --client-name $clientName --rpc-ws-port 17374
bak session reset --client-name $clientName --focus --rpc-ws-port 17374
bak session close-tab --client-name $clientName --rpc-ws-port 17374
bak session close --session-id $sessionId --rpc-ws-port 17374
```

`bak session close-tab` closes a session-owned tab and auto-closes the session when that was the last one. When the managed background runtime sees the last live session disappear, it auto-stops. Foreground `bak serve` stays up until you stop it manually.

`bak session dashboard` aggregates `runtime.info`, `session.list`, `session.info`, and `session.list-tabs` into one response so you can see:

- whether the runtime is paired and connected
- which sessions are attached or detached
- the current active tab for each session
- the current frame/shadow context depth

## Open And Target Pages

Use session helpers for agent-owned tabs:

```powershell
bak session open-tab --client-name $clientName --url "https://example.com" --active --rpc-ws-port 17374
bak session list-tabs --client-name $clientName --rpc-ws-port 17374
bak session get-active-tab --client-name $clientName --rpc-ws-port 17374
bak session set-active-tab --client-name $clientName --tab-id 123 --rpc-ws-port 17374
```

Without `--active`, `bak session open-tab` leaves the current session tab unchanged. That is useful for opening a background reference tab in the current browser window without unexpectedly redirecting later `bak page ...` or `bak element ...` commands.

## Direct Browser Tabs

Use `bak tabs list`, `bak tabs get`, and `bak tabs active` when you need browser-wide diagnostics. Use `bak tabs new`, `bak tabs focus`, and `bak tabs close` only for recovery-oriented compatibility work inside the currently resolved session. Most day-to-day agent work should stay on `bak session resolve`, `bak session ensure`, and `bak session open-tab`.

```powershell
bak tabs list --rpc-ws-port 17374
bak tabs active --rpc-ws-port 17374
bak tabs get 123 --rpc-ws-port 17374
bak tabs focus 123 --client-name $clientName --rpc-ws-port 17374
bak tabs new --url "https://example.com" --active --client-name $clientName --rpc-ws-port 17374
bak tabs close 123 --client-name $clientName --rpc-ws-port 17374
```

`bak tabs focus` and `bak tabs close` now fail if the referenced tab does not belong to the resolved session.

Navigate and wait:

```powershell
bak page goto "https://example.com" --client-name $clientName --rpc-ws-port 17374
bak page wait --client-name $clientName --mode text --value "Example Domain" --rpc-ws-port 17374
bak page title --client-name $clientName --rpc-ws-port 17374
bak page url --client-name $clientName --rpc-ws-port 17374
```

## Read And Debug

```powershell
bak page snapshot --client-name $clientName --include-base64 --annotate --rpc-ws-port 17374
bak page text --client-name $clientName --rpc-ws-port 17374
bak page dom --client-name $clientName --rpc-ws-port 17374
bak page a11y --client-name $clientName --rpc-ws-port 17374
bak page metrics --client-name $clientName --rpc-ws-port 17374
bak page viewport --client-name $clientName --rpc-ws-port 17374
bak inspect page-data --client-name $clientName --rpc-ws-port 17374
bak page eval --client-name $clientName --expr "typeof table_data !== 'undefined' ? table_data.length : null" --rpc-ws-port 17374
bak page extract --client-name $clientName --path "market_data.QQQ.quotes.changePercent" --resolver auto --rpc-ws-port 17374
bak page fetch --client-name $clientName --url "https://example.com/api/data" --mode json --rpc-ws-port 17374
bak page freshness --client-name $clientName --rpc-ws-port 17374
bak debug console --client-name $clientName --limit 20 --rpc-ws-port 17374
bak debug dump-state --client-name $clientName --section dom visible-text network-summary --include-snapshot --annotate-snapshot --rpc-ws-port 17374
bak network list --client-name $clientName --limit 20 --rpc-ws-port 17374
bak network get req_123 --client-name $clientName --include request response --rpc-ws-port 17374
bak network wait --client-name $clientName --url-includes "/api/save" --rpc-ws-port 17374
bak network search --client-name $clientName --pattern "table_data" --rpc-ws-port 17374
bak network replay --client-name $clientName --request-id req_123 --mode json --with-schema auto --rpc-ws-port 17374
bak network clear --client-name $clientName --rpc-ws-port 17374
```

Use `bak page snapshot --annotate` when you want numbered `@eN` refs that line up with the returned `refs[]` payload and the annotated image. Use `--diff-with` against an older elements JSON, page snapshot JSON, or debug dump JSON when you need a structured before/after interaction diff instead of a raw screenshot.

Mutating `bak page fetch` calls and replays of mutating requests require explicit `--requires-confirm`.

## Interact With Elements

`bak` accepts either `--locator <json>` or individual locator fields such as `--css`, `--role`, `--name`, and `--text`.

```powershell
bak element click --client-name $clientName --css "#submit" --rpc-ws-port 17374
bak element get --client-name $clientName --xpath "//button[@aria-label='Refresh']" --rpc-ws-port 17374
bak element type --client-name $clientName --css "#email" --value "me@example.com" --clear --rpc-ws-port 17374
bak element select --client-name $clientName --css "#role-select" --value admin --rpc-ws-port 17374
bak element scroll --client-name $clientName --css "#list" --dy 320 --rpc-ws-port 17374
bak element drag-drop --client-name $clientName --from-css "#drag-source" --to-css "#drop-target" --rpc-ws-port 17374
```

The same surface also exposes `get`, `hover`, `double-click`, `right-click`, `check`, `uncheck`, `scroll-into-view`, `focus`, and `blur`.

Keyboard, mouse, and file upload stay on the same target tab:

```powershell
bak keyboard hotkey --client-name $clientName Control L --rpc-ws-port 17374
bak mouse click --client-name $clientName --x 200 --y 120 --rpc-ws-port 17374
bak file upload --client-name $clientName --css "#file-input" --file-path .\report.pdf --rpc-ws-port 17374
```

## Frames And Shadow DOM

```powershell
bak context get --client-name $clientName --rpc-ws-port 17374
bak context enter-frame --client-name $clientName --frame-path "#demo-frame" --rpc-ws-port 17374
bak context enter-shadow --client-name $clientName --host-selectors "#shadow-host" --rpc-ws-port 17374
bak page title --client-name $clientName --rpc-ws-port 17374
bak context exit-shadow --client-name $clientName --levels 1 --rpc-ws-port 17374
bak context exit-frame --client-name $clientName --levels 1 --rpc-ws-port 17374
bak context reset --client-name $clientName --rpc-ws-port 17374
```

## Tables And Dynamic Data

Use `bak table ...` when a page renders only part of a table or grid:

```powershell
bak table list --client-name $clientName --rpc-ws-port 17374
bak table schema --client-name $clientName --table table-1 --rpc-ws-port 17374
bak table rows --client-name $clientName --table table-1 --limit 100 --rpc-ws-port 17374
bak table rows --client-name $clientName --table table-1 --all --max-rows 10000 --rpc-ws-port 17374
bak table export --client-name $clientName --table table-1 --out .\table.json --rpc-ws-port 17374
```

Use `bak inspect ...` first when you do not yet know whether the page data lives in globals, tables, or recent requests. `inspect page-data` surfaces candidate globals, tables, recent requests, and recommended next steps. `inspect live-updates` reports network cadence even when the page is not using an obvious interval timer. `page freshness` and `inspect freshness` help separate data timestamps from stale inline or UI hints.

Use `bak inspect ...` for discovery and `bak capture ...` for offline artifacts:

```powershell
bak inspect page-data --client-name $clientName --rpc-ws-port 17374
bak inspect live-updates --client-name $clientName --rpc-ws-port 17374
bak inspect freshness --client-name $clientName --patterns "20\d{2}-\d{2}-\d{2}" --rpc-ws-port 17374
bak capture snapshot --client-name $clientName --out .\session.json --rpc-ws-port 17374
bak capture har --client-name $clientName --out .\session.har --rpc-ws-port 17374
```

## Protocol-Only Methods

Use `bak call` when the protocol exposes a method without a first-class CLI command. Session-scoped `bak call` methods follow the same auto-resolution order as the rest of the browser-affecting CLI. These navigation helpers currently live there; if they become first-class later, expect them under `bak page ...` to match the existing noun-based CLI surface.

Examples:

```powershell
bak call --method page.reload --client-name $clientName --params "{}" --rpc-ws-port 17374
bak call --method page.back --client-name $clientName --params "{}" --rpc-ws-port 17374
bak call --method page.forward --client-name $clientName --params "{}" --rpc-ws-port 17374
bak call --method page.scrollTo --client-name $clientName --params '{"x":0,"y":640}' --rpc-ws-port 17374
```

## Advanced: Foreground Runtime Logs

If you need manual debugging or foreground runtime logs, you can still run:

```powershell
bak serve --port 17373 --rpc-ws-port 17374
```

That is an advanced troubleshooting path, not the normal way to keep `bak` available. Foreground `bak serve` does not auto-stop when sessions close.

## Daily Flow

```powershell
bak doctor --port 17373 --rpc-ws-port 17374
$clientName = 'agent-a'
$null = bak session resolve --client-name $clientName --rpc-ws-port 17374
bak session ensure --client-name $clientName --rpc-ws-port 17374
bak session open-tab --client-name $clientName --url "https://example.com" --active --rpc-ws-port 17374
bak page wait --client-name $clientName --mode text --value "Example Domain" --rpc-ws-port 17374
bak element click --client-name $clientName --css "a" --rpc-ws-port 17374
bak debug dump-state --client-name $clientName --include-snapshot --rpc-ws-port 17374
```

## Dynamic Financial Or Data-Dense Flow

When the visible page is incomplete, use the workflow below:

```powershell
bak inspect page-data --client-name $clientName --rpc-ws-port 17374
bak page extract --client-name $clientName --path "market_data.QQQ.quotes.changePercent" --resolver auto --rpc-ws-port 17374
bak page eval --client-name $clientName --expr "typeof market_data !== 'undefined' ? market_data.QQQ : null" --rpc-ws-port 17374
bak network search --client-name $clientName --pattern "table_data" --rpc-ws-port 17374
bak network get req_123 --client-name $clientName --include request response --rpc-ws-port 17374
bak page fetch --client-name $clientName --url "https://example.com/api/data" --mode json --rpc-ws-port 17374
bak network replay --client-name $clientName --request-id req_123 --mode json --with-schema auto --rpc-ws-port 17374
bak table rows --client-name $clientName --table table-1 --all --rpc-ws-port 17374
bak inspect live-updates --client-name $clientName --rpc-ws-port 17374
bak page freshness --client-name $clientName --patterns "20\d{2}-\d{2}-\d{2}" "Today" "yesterday" --rpc-ws-port 17374
bak capture snapshot --client-name $clientName --out .\tradytics-session.json --rpc-ws-port 17374
```

If the request mutates server state, add `--requires-confirm` to `bak page fetch` or `bak network replay`.
