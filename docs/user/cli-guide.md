# CLI Guide

`bak` is the agent-facing entrypoint to the paired browser extension.

This page assumes the runtime is already installed and healthy. If you still need install, upgrade, or extension reload steps, go back to [quickstart.md](./quickstart.md). In normal use, `bak` auto-starts the local runtime when needed.

## Command Map

- `bak session ...` is the default agent surface for creating, repairing, focusing, resetting, and closing session-owned browser state plus tracked tabs.
- `bak tabs ...` is the browser-wide inspection and recovery surface outside the session helpers.
- `bak page`, `bak context`, `bak element`, `bak debug`, `bak network`, `bak table`, `bak inspect`, `bak capture`, `bak keyboard`, `bak mouse`, and `bak file` target the current session tab unless you override with `--tab-id`.
- `bak session open-tab` opens a tab in the dedicated session window, but only `--active` or `bak session set-active-tab ...` changes which tab later session-scoped commands target by default.
- `bak call` covers protocol-only methods until they graduate into one of those noun groups.
- Older `workspace` wording is obsolete in the public CLI surface.

## Start Every Session

```powershell
bak doctor --port 17373 --rpc-ws-port 17374
bak status --port 17373 --rpc-ws-port 17374
```

`bak doctor` is the recommended first check and auto-starts the local runtime when needed unless you are intentionally running `bak serve` in the foreground for debugging. Use `bak status` when you want to inspect whether the runtime is already up without changing your session flow.

If you want a clean runtime restart:

```powershell
bak stop --port 17373 --rpc-ws-port 17374
bak doctor --port 17373 --rpc-ws-port 17374
```

Then create or repair the agent session window:

```powershell
$session = bak session create --client-name agent-a --rpc-ws-port 17374 | ConvertFrom-Json
$sessionId = $session.sessionId
bak session ensure --session-id $sessionId --rpc-ws-port 17374
bak session info --session-id $sessionId --rpc-ws-port 17374
```

Common maintenance commands for the dedicated session window:

```powershell
bak session list --rpc-ws-port 17374
bak session focus --session-id $sessionId --rpc-ws-port 17374
bak session reset --session-id $sessionId --focus --rpc-ws-port 17374
bak session close --session-id $sessionId --rpc-ws-port 17374
```

## Open And Target Pages

Use session helpers for agent-owned tabs:

```powershell
bak session open-tab --session-id $sessionId --url "https://example.com" --active --rpc-ws-port 17374
bak session list-tabs --session-id $sessionId --rpc-ws-port 17374
bak session get-active-tab --session-id $sessionId --rpc-ws-port 17374
bak session set-active-tab --session-id $sessionId --tab-id 123 --rpc-ws-port 17374
```

Without `--active`, `bak session open-tab` leaves the current session tab unchanged. That is useful for opening a background reference tab without unexpectedly redirecting later `bak page ...` or `bak element ...` commands.

## Direct Browser Tabs

Use `bak tabs ...` when you need browser-wide tab inspection or manual recovery outside the session-owned window. Most day-to-day agent work should stay on `bak session ensure` and `bak session open-tab`.

```powershell
bak tabs list --rpc-ws-port 17374
bak tabs active --rpc-ws-port 17374
bak tabs get 123 --rpc-ws-port 17374
bak tabs focus 123 --rpc-ws-port 17374
bak tabs new --url "https://example.com" --active --rpc-ws-port 17374
bak tabs close 123 --rpc-ws-port 17374
```

Navigate and wait:

```powershell
bak page goto "https://example.com" --session-id $sessionId --rpc-ws-port 17374
bak page wait --session-id $sessionId --mode text --value "Example Domain" --rpc-ws-port 17374
bak page title --session-id $sessionId --rpc-ws-port 17374
bak page url --session-id $sessionId --rpc-ws-port 17374
```

## Read And Debug

```powershell
bak page snapshot --session-id $sessionId --include-base64 --rpc-ws-port 17374
bak page text --session-id $sessionId --rpc-ws-port 17374
bak page dom --session-id $sessionId --rpc-ws-port 17374
bak page a11y --session-id $sessionId --rpc-ws-port 17374
bak page metrics --session-id $sessionId --rpc-ws-port 17374
bak page viewport --session-id $sessionId --rpc-ws-port 17374
bak inspect page-data --session-id $sessionId --rpc-ws-port 17374
bak page eval --session-id $sessionId --expr "typeof table_data !== 'undefined' ? table_data.length : null" --rpc-ws-port 17374
bak page extract --session-id $sessionId --path "market_data.QQQ.quotes.changePercent" --resolver auto --rpc-ws-port 17374
bak page fetch --session-id $sessionId --url "https://example.com/api/data" --mode json --rpc-ws-port 17374
bak page freshness --session-id $sessionId --rpc-ws-port 17374
bak debug console --session-id $sessionId --limit 20 --rpc-ws-port 17374
bak debug dump-state --session-id $sessionId --section dom visible-text network-summary --include-snapshot --rpc-ws-port 17374
bak network list --session-id $sessionId --limit 20 --rpc-ws-port 17374
bak network get req_123 --session-id $sessionId --include request response --rpc-ws-port 17374
bak network wait --session-id $sessionId --url-includes "/api/save" --rpc-ws-port 17374
bak network search --session-id $sessionId --pattern "table_data" --rpc-ws-port 17374
bak network replay --session-id $sessionId --request-id req_123 --mode json --with-schema auto --rpc-ws-port 17374
bak network clear --session-id $sessionId --rpc-ws-port 17374
```

Mutating `bak page fetch` calls and replays of mutating requests require explicit `--requires-confirm`.

## Interact With Elements

`bak` accepts either `--locator <json>` or individual locator fields such as `--css`, `--role`, `--name`, and `--text`.

```powershell
bak element click --session-id $sessionId --css "#submit" --rpc-ws-port 17374
bak element get --session-id $sessionId --xpath "//button[@aria-label='Refresh']" --rpc-ws-port 17374
bak element type --session-id $sessionId --css "#email" --value "me@example.com" --clear --rpc-ws-port 17374
bak element select --session-id $sessionId --css "#role-select" --value admin --rpc-ws-port 17374
bak element scroll --session-id $sessionId --css "#list" --dy 320 --rpc-ws-port 17374
bak element drag-drop --session-id $sessionId --from-css "#drag-source" --to-css "#drop-target" --rpc-ws-port 17374
```

The same surface also exposes `get`, `hover`, `double-click`, `right-click`, `check`, `uncheck`, `scroll-into-view`, `focus`, and `blur`.

Keyboard, mouse, and file upload stay on the same target tab:

```powershell
bak keyboard hotkey --session-id $sessionId Control L --rpc-ws-port 17374
bak mouse click --session-id $sessionId --x 200 --y 120 --rpc-ws-port 17374
bak file upload --session-id $sessionId --css "#file-input" --file-path .\report.pdf --rpc-ws-port 17374
```

## Frames And Shadow DOM

```powershell
bak context get --session-id $sessionId --rpc-ws-port 17374
bak context enter-frame --session-id $sessionId --frame-path "#demo-frame" --rpc-ws-port 17374
bak context enter-shadow --session-id $sessionId --host-selectors "#shadow-host" --rpc-ws-port 17374
bak page title --session-id $sessionId --rpc-ws-port 17374
bak context exit-shadow --session-id $sessionId --levels 1 --rpc-ws-port 17374
bak context exit-frame --session-id $sessionId --levels 1 --rpc-ws-port 17374
bak context reset --session-id $sessionId --rpc-ws-port 17374
```

## Tables And Dynamic Data

Use `bak table ...` when a page renders only part of a table or grid:

```powershell
bak table list --session-id $sessionId --rpc-ws-port 17374
bak table schema --session-id $sessionId --table table-1 --rpc-ws-port 17374
bak table rows --session-id $sessionId --table table-1 --limit 100 --rpc-ws-port 17374
bak table rows --session-id $sessionId --table table-1 --all --max-rows 10000 --rpc-ws-port 17374
bak table export --session-id $sessionId --table table-1 --out .\table.json --rpc-ws-port 17374
```

Use `bak inspect ...` first when you do not yet know whether the page data lives in globals, tables, or recent requests. `inspect page-data` surfaces candidate globals, tables, recent requests, and recommended next steps. `inspect live-updates` reports network cadence even when the page is not using an obvious interval timer. `page freshness` and `inspect freshness` help separate data timestamps from stale inline or UI hints.

Use `bak inspect ...` for discovery and `bak capture ...` for offline artifacts:

```powershell
bak inspect page-data --session-id $sessionId --rpc-ws-port 17374
bak inspect live-updates --session-id $sessionId --rpc-ws-port 17374
bak inspect freshness --session-id $sessionId --patterns "20\d{2}-\d{2}-\d{2}" --rpc-ws-port 17374
bak capture snapshot --session-id $sessionId --out .\session.json --rpc-ws-port 17374
bak capture har --session-id $sessionId --out .\session.har --rpc-ws-port 17374
```

## Protocol-Only Methods

Use `bak call` when the protocol exposes a method without a first-class CLI command. These navigation helpers currently live there; if they become first-class later, expect them under `bak page ...` to match the existing noun-based CLI surface.

Examples:

```powershell
bak call --method page.reload --params "{}" --rpc-ws-port 17374
bak call --method page.back --params "{}" --rpc-ws-port 17374
bak call --method page.forward --params "{}" --rpc-ws-port 17374
bak call --method page.scrollTo --params '{"x":0,"y":640}' --rpc-ws-port 17374
```

## Advanced: Foreground Runtime Logs

If you need manual debugging or foreground runtime logs, you can still run:

```powershell
bak serve --port 17373 --rpc-ws-port 17374
```

That is an advanced troubleshooting path, not the normal way to keep `bak` available.

## Daily Flow

```powershell
bak doctor --port 17373 --rpc-ws-port 17374
$session = bak session create --client-name agent-a --rpc-ws-port 17374 | ConvertFrom-Json
$sessionId = $session.sessionId
bak session ensure --session-id $sessionId --rpc-ws-port 17374
bak session open-tab --session-id $sessionId --url "https://example.com" --active --rpc-ws-port 17374
bak page wait --session-id $sessionId --mode text --value "Example Domain" --rpc-ws-port 17374
bak element click --session-id $sessionId --css "a" --rpc-ws-port 17374
bak debug dump-state --session-id $sessionId --include-snapshot --rpc-ws-port 17374
```

## Dynamic Financial Or Data-Dense Flow

When the visible page is incomplete, use the workflow below:

```powershell
bak inspect page-data --session-id $sessionId --rpc-ws-port 17374
bak page extract --session-id $sessionId --path "market_data.QQQ.quotes.changePercent" --resolver auto --rpc-ws-port 17374
bak page eval --session-id $sessionId --expr "typeof market_data !== 'undefined' ? market_data.QQQ : null" --rpc-ws-port 17374
bak network search --session-id $sessionId --pattern "table_data" --rpc-ws-port 17374
bak network get req_123 --session-id $sessionId --include request response --rpc-ws-port 17374
bak page fetch --session-id $sessionId --url "https://example.com/api/data" --mode json --rpc-ws-port 17374
bak network replay --session-id $sessionId --request-id req_123 --mode json --with-schema auto --rpc-ws-port 17374
bak table rows --session-id $sessionId --table table-1 --all --rpc-ws-port 17374
bak inspect live-updates --session-id $sessionId --rpc-ws-port 17374
bak page freshness --session-id $sessionId --patterns "20\d{2}-\d{2}-\d{2}" "Today" "yesterday" --rpc-ws-port 17374
bak capture snapshot --session-id $sessionId --out .\tradytics-session.json --rpc-ws-port 17374
```

If the request mutates server state, add `--requires-confirm` to `bak page fetch` or `bak network replay`.
