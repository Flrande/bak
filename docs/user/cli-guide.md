# CLI Guide

`bak` is the agent-facing entrypoint to the paired browser extension.

## Start Every Session

```powershell
bak doctor --port 17373 --rpc-ws-port 17374
```

Then create or repair the agent workspace:

```powershell
bak workspace ensure --rpc-ws-port 17374
bak workspace info --rpc-ws-port 17374
```

## Open And Target Pages

Use workspace commands for agent-owned tabs:

```powershell
bak workspace open-tab --url "https://example.com" --rpc-ws-port 17374
bak workspace get-active-tab --rpc-ws-port 17374
bak workspace set-active-tab --tab-id 123 --rpc-ws-port 17374
```

Navigate and wait:

```powershell
bak page goto "https://example.com" --rpc-ws-port 17374
bak page wait --mode text --value "Example Domain" --rpc-ws-port 17374
bak page title --rpc-ws-port 17374
bak page url --rpc-ws-port 17374
```

## Read And Debug

```powershell
bak page snapshot --include-base64 --rpc-ws-port 17374
bak page text --rpc-ws-port 17374
bak page dom --rpc-ws-port 17374
bak page a11y --rpc-ws-port 17374
bak debug console --limit 20 --rpc-ws-port 17374
bak debug dump-state --include-snapshot --rpc-ws-port 17374
bak network list --limit 20 --rpc-ws-port 17374
```

## Interact With Elements

`bak` accepts either `--locator <json>` or individual locator fields such as `--css`, `--role`, `--name`, and `--text`.

```powershell
bak element click --css "#submit" --rpc-ws-port 17374
bak element type --css "#email" --value "me@example.com" --clear --rpc-ws-port 17374
bak element select --css "#role-select" --value admin --rpc-ws-port 17374
bak element scroll --css "#list" --dy 320 --rpc-ws-port 17374
bak element drag-drop --from-css "#drag-source" --to-css "#drop-target" --rpc-ws-port 17374
```

Keyboard, mouse, and file upload stay on the same target tab:

```powershell
bak keyboard hotkey Control L --rpc-ws-port 17374
bak mouse click --x 200 --y 120 --rpc-ws-port 17374
bak file upload --css "#file-input" --file-path .\report.pdf --rpc-ws-port 17374
```

## Frames And Shadow DOM

```powershell
bak context enter-frame --frame-path "#demo-frame" --rpc-ws-port 17374
bak context enter-shadow --host-selectors "#shadow-host" --rpc-ws-port 17374
bak page title --rpc-ws-port 17374
bak context reset --rpc-ws-port 17374
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
bak workspace ensure --rpc-ws-port 17374
bak workspace open-tab --url "https://example.com" --rpc-ws-port 17374
bak page wait --mode text --value "Example Domain" --rpc-ws-port 17374
bak element click --css "a" --rpc-ws-port 17374
bak debug dump-state --include-snapshot --rpc-ws-port 17374
```
