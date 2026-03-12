# Command Recipes

## Session And Targeting

```powershell
$session = bak session create --client-name agent-a --rpc-ws-port 17374 | ConvertFrom-Json
$sessionId = $session.sessionId
bak session ensure --session-id $sessionId --rpc-ws-port 17374
bak session open-tab --session-id $sessionId --url "https://example.com" --active --rpc-ws-port 17374
bak session get-active-tab --session-id $sessionId --rpc-ws-port 17374
bak session open-tab --session-id $sessionId --url "https://docs.example.com" --rpc-ws-port 17374
bak session set-active-tab --session-id $sessionId --tab-id 123 --rpc-ws-port 17374
bak page goto "https://example.com" --session-id $sessionId --rpc-ws-port 17374
bak page wait --session-id $sessionId --mode text --value "Example Domain" --rpc-ws-port 17374
bak page snapshot --session-id $sessionId --include-base64 --rpc-ws-port 17374
bak page title --session-id $sessionId --rpc-ws-port 17374
bak page url --session-id $sessionId --rpc-ws-port 17374
```

`bak session open-tab` without `--active` is the background-tab form. It keeps the current session tab unchanged until you switch with `bak session set-active-tab ...` or pass `--tab-id` on later commands.

## Discovery, Runtime Data, And Network

```powershell
bak inspect page-data --session-id $sessionId --rpc-ws-port 17374
bak page extract --session-id $sessionId --path "table_data" --resolver auto --rpc-ws-port 17374
bak page extract --session-id $sessionId --path "market_data.QQQ" --resolver lexical --scope main --rpc-ws-port 17374
bak page eval --session-id $sessionId --expr "typeof market_data !== 'undefined' ? market_data.QQQ : null" --rpc-ws-port 17374
bak network list --session-id $sessionId --limit 20 --rpc-ws-port 17374
bak network search --session-id $sessionId --pattern "table_data" --rpc-ws-port 17374
bak network get req_123 --session-id $sessionId --include request response --body-bytes 4096 --rpc-ws-port 17374
bak page fetch --session-id $sessionId --url "https://example.com/api/data" --mode json --rpc-ws-port 17374
bak network replay --session-id $sessionId --request-id req_123 --mode json --with-schema auto --rpc-ws-port 17374
```

Mutating `bak page fetch` calls and replays of mutating requests require explicit `--requires-confirm`.

## Element, Context, And Debug

```powershell
bak element click --session-id $sessionId --css "#submit" --rpc-ws-port 17374
bak element type --session-id $sessionId --css "#email" --value "me@example.com" --clear --rpc-ws-port 17374
bak element get --session-id $sessionId --xpath "//button[contains(@class, 'delete-btn')]" --rpc-ws-port 17374
bak context get --session-id $sessionId --rpc-ws-port 17374
bak debug dump-state --session-id $sessionId --section dom visible-text network-summary --include-snapshot --rpc-ws-port 17374
```

## Table, Freshness, Inspect, And Capture

```powershell
bak table list --session-id $sessionId --rpc-ws-port 17374
bak table schema --session-id $sessionId --table table-1 --rpc-ws-port 17374
bak table rows --session-id $sessionId --table table-1 --all --max-rows 10000 --rpc-ws-port 17374
bak page freshness --session-id $sessionId --patterns "20\d{2}-\d{2}-\d{2}" "Today" "yesterday" --rpc-ws-port 17374
bak inspect page-data --session-id $sessionId --rpc-ws-port 17374
bak inspect live-updates --session-id $sessionId --rpc-ws-port 17374
bak inspect freshness --session-id $sessionId --rpc-ws-port 17374
bak capture snapshot --session-id $sessionId --out .\session.json --rpc-ws-port 17374
bak capture har --session-id $sessionId --out .\session.har --rpc-ws-port 17374
```

## Protocol-Only Methods

```powershell
bak call --method page.reload --params "{}" --rpc-ws-port 17374
bak call --method page.back --params "{}" --rpc-ws-port 17374
bak call --method page.scrollTo --params '{"x":0,"y":640}' --rpc-ws-port 17374
```
