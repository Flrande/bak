# Command Recipes

## Workspace And Page

```powershell
bak workspace ensure --rpc-ws-port 17374
bak workspace open-tab --url "https://example.com" --rpc-ws-port 17374
bak workspace get-active-tab --rpc-ws-port 17374
bak page goto "https://example.com" --rpc-ws-port 17374
bak page wait --mode text --value "Example Domain" --rpc-ws-port 17374
bak page snapshot --include-base64 --rpc-ws-port 17374
```

## Element And Debug

```powershell
bak element click --css "#submit" --rpc-ws-port 17374
bak element type --css "#email" --value "me@example.com" --clear --rpc-ws-port 17374
bak debug dump-state --include-snapshot --rpc-ws-port 17374
bak network list --limit 20 --rpc-ws-port 17374
```

## Protocol-Only Methods

```powershell
bak call --method page.reload --params "{}" --rpc-ws-port 17374
bak call --method page.back --params "{}" --rpc-ws-port 17374
bak call --method page.scrollTo --params '{"x":0,"y":640}' --rpc-ws-port 17374
```

## Memory

```powershell
bak memory capture begin --goal "return to billing settings" --rpc-ws-port 17374
bak memory draft list --rpc-ws-port 17374
bak memory search --goal "return to billing settings" --kind route --rpc-ws-port 17374
bak memory plan create --memory-id <memoryId> --mode assist --rpc-ws-port 17374
bak memory execute <planId> --rpc-ws-port 17374
```
