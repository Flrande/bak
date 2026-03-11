# CLI Guide

`bak` is the agent-facing entrypoint to the paired browser extension.

## Start Every Session

```powershell
bak doctor --port 17373 --rpc-ws-port 17374
```

Then create or repair the agent session binding:

```powershell
$session = bak session create --client-name agent-a --rpc-ws-port 17374 | ConvertFrom-Json
$sessionId = $session.sessionId
bak session ensure --session-id $sessionId --rpc-ws-port 17374
bak session info --session-id $sessionId --rpc-ws-port 17374
```

## Open And Target Pages

Use session helpers for agent-owned tabs:

```powershell
bak session open-tab --session-id $sessionId --url "https://example.com" --rpc-ws-port 17374
bak session list-tabs --session-id $sessionId --rpc-ws-port 17374
bak session get-active-tab --session-id $sessionId --rpc-ws-port 17374
bak session set-active-tab --session-id $sessionId --tab-id 123 --rpc-ws-port 17374
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
bak debug console --session-id $sessionId --limit 20 --rpc-ws-port 17374
bak debug dump-state --session-id $sessionId --include-snapshot --rpc-ws-port 17374
bak network list --session-id $sessionId --limit 20 --rpc-ws-port 17374
```

## Interact With Elements

`bak` accepts either `--locator <json>` or individual locator fields such as `--css`, `--role`, `--name`, and `--text`.

```powershell
bak element click --session-id $sessionId --css "#submit" --rpc-ws-port 17374
bak element type --session-id $sessionId --css "#email" --value "me@example.com" --clear --rpc-ws-port 17374
bak element select --session-id $sessionId --css "#role-select" --value admin --rpc-ws-port 17374
bak element scroll --session-id $sessionId --css "#list" --dy 320 --rpc-ws-port 17374
bak element drag-drop --session-id $sessionId --from-css "#drag-source" --to-css "#drop-target" --rpc-ws-port 17374
```

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
bak context reset --session-id $sessionId --rpc-ws-port 17374
```

## Protocol-Only Methods

Use `bak call` when the protocol exposes a method without a first-class CLI command.

Examples:

```powershell
bak call --method page.reload --params "{}" --rpc-ws-port 17374
bak call --method page.back --params "{}" --rpc-ws-port 17374
bak call --method page.scrollTo --params '{"x":0,"y":640}' --rpc-ws-port 17374
```

## Daily Flow

```powershell
bak doctor --port 17373 --rpc-ws-port 17374
$session = bak session create --client-name agent-a --rpc-ws-port 17374 | ConvertFrom-Json
$sessionId = $session.sessionId
bak session ensure --session-id $sessionId --rpc-ws-port 17374
bak session open-tab --session-id $sessionId --url "https://example.com" --rpc-ws-port 17374
bak page wait --session-id $sessionId --mode text --value "Example Domain" --rpc-ws-port 17374
bak element click --session-id $sessionId --css "a" --rpc-ws-port 17374
bak debug dump-state --session-id $sessionId --include-snapshot --rpc-ws-port 17374
```
