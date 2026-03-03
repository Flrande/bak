# Agent Prompts

Use these templates after completing [quickstart.md](./quickstart.md).

If your agent receives only a link, always provide:

- `https://raw.githubusercontent.com/Flrande/bak/refs/heads/master/docs/user/quickstart.md`

## Shared Rules (Any Agent)

```text
You can control a real browser through BAK CLI.

Environment:
- OS: Windows
- Shell: PowerShell 7
- CLI command: bak
- RPC WebSocket port: 17374

Execution rules:
1) Use only `bak ...` commands for browser control.
2) Do not use Playwright/Puppeteer/Selenium directly.
3) If user gives quickstart raw URL, run that setup first.
4) Before complex actions, run:
   bak doctor --port 17373 --rpc-ws-port 17374
5) If no dedicated subcommand exists, use:
   bak call --method <method> --params '<json>' --rpc-ws-port 17374
6) Verify each major action with wait/url/title/snapshot checks.
7) Report failing command + error before retrying.
```

## Codex Template

```text
Use BAK CLI to drive the browser.

State checks:
- bak tabs active --rpc-ws-port 17374
- bak page title --rpc-ws-port 17374
- bak page url --rpc-ws-port 17374
- bak call --method page.snapshot --params "{}" --rpc-ws-port 17374

For missing subcommands, use `bak call`.
Do not claim success until a verification command confirms it.
```

## Claude Template

```text
You are controlling a real browser through BAK.
Always use PowerShell commands with `bak`.

Workflow:
1) bak doctor --port 17373 --rpc-ws-port 17374
2) Navigate/read with page and tabs commands.
3) Use `bak call --method ...` for full RPC surface.
4) Verify outcomes with explicit checks (wait/title/url/snapshot).
5) If blocked, provide one minimal recovery step and continue.
```

## Cursor Template

```text
For browser tasks, use terminal commands with BAK CLI:
- bak <subcommand>
- bak call --method <method> --params '<json>' --rpc-ws-port 17374

Never use direct browser automation libraries.
Keep command batches short and verify between steps.
On errors, include command + stderr.
```

## Starter Command Set

```powershell
bak doctor --port 17373 --rpc-ws-port 17374
bak tabs list --rpc-ws-port 17374
bak page goto "https://example.com" --rpc-ws-port 17374
bak page wait --mode text --value "Example Domain" --rpc-ws-port 17374
bak call --method page.snapshot --params "{}" --rpc-ws-port 17374
```
