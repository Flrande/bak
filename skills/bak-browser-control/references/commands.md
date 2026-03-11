# Command Recipes

## Session And Page

```powershell
$session = bak session create --client-name agent-a --rpc-ws-port 17374 | ConvertFrom-Json
$sessionId = $session.sessionId
bak session ensure --session-id $sessionId --rpc-ws-port 17374
bak session open-tab --session-id $sessionId --url "https://example.com" --rpc-ws-port 17374
bak session get-active-tab --session-id $sessionId --rpc-ws-port 17374
bak page goto "https://example.com" --session-id $sessionId --rpc-ws-port 17374
bak page wait --session-id $sessionId --mode text --value "Example Domain" --rpc-ws-port 17374
bak page snapshot --session-id $sessionId --include-base64 --rpc-ws-port 17374
```

## Element And Debug

```powershell
bak element click --session-id $sessionId --css "#submit" --rpc-ws-port 17374
bak element type --session-id $sessionId --css "#email" --value "me@example.com" --clear --rpc-ws-port 17374
bak context get --session-id $sessionId --rpc-ws-port 17374
bak debug dump-state --session-id $sessionId --include-snapshot --rpc-ws-port 17374
bak network list --session-id $sessionId --limit 20 --rpc-ws-port 17374
```

## Protocol-Only Methods

```powershell
bak call --method page.reload --params "{}" --rpc-ws-port 17374
bak call --method page.back --params "{}" --rpc-ws-port 17374
bak call --method page.scrollTo --params '{"x":0,"y":640}' --rpc-ws-port 17374
```
