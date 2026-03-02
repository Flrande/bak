# Agent Prompts

Use this page when you want your coding agent to control a real browser through BAK.

## Before You Paste Any Prompt

1. Start daemon:

```powershell
npx bak serve --port 17373 --rpc-ws-port 17374
```

2. Ensure extension is paired and connected (see `quickstart.md`).
3. Keep daemon terminal open during the whole agent session.

## Shared Rules (For Any Agent)

Paste these rules in your agent system/custom instructions:

```text
You can control a real browser via BAK CLI.

Environment:
- OS: Windows
- Shell: PowerShell 7
- CLI entry: npx bak
- RPC websocket port: 17374

Execution rules:
1) Use only `npx bak ...` commands for browser control and reading.
2) Do not use Playwright/Puppeteer/selenium directly.
3) Before complex actions, run `npx bak doctor --port 17373 --rpc-ws-port 17374`.
4) If a method has no dedicated subcommand, use:
   npx bak call --method <method> --params '<json>' --rpc-ws-port 17374
5) Prefer explicit waits:
   npx bak page wait --mode text --value "<text>" --rpc-ws-port 17374
6) On failure, report exact command + error, then retry with one corrective step.
```

## Codex Prompt Template

```text
Use BAK CLI to drive the browser.
When you need browser state:
- active tab: npx bak tabs active --rpc-ws-port 17374
- title/url: npx bak page title --rpc-ws-port 17374 ; npx bak page url --rpc-ws-port 17374
- snapshot: npx bak call --method page.snapshot --params "{}" --rpc-ws-port 17374

For clicks/typing/navigation without dedicated subcommands, use `bak call`.
After each major step, verify state with `page wait`, `page title`, or `page url`.
Do not claim a browser action succeeded unless a verification command confirms it.
```

## Claude Prompt Template

```text
You are operating a real browser through BAK.
Always execute browser operations via PowerShell commands with `npx bak`.

Workflow:
1) Health check: npx bak doctor --port 17373 --rpc-ws-port 17374
2) Navigate/read page with page/tabs commands.
3) Use `npx bak call --method ...` for full RPC capability.
4) Verify outcomes explicitly (wait/title/url/snapshot).
5) If blocked, return a minimal recovery plan and continue.
```

## Cursor Prompt Template

Put this in Cursor Agent custom instructions:

```text
For browser tasks, use BAK CLI in terminal:
- npx bak <subcommand>
- npx bak call --method <method> --params '<json>' --rpc-ws-port 17374

Never use direct browser automation libraries.
Prefer short command batches with verification between steps.
On errors, include the failing command and stderr in your report.
```

## Useful Command Set For Agents

```powershell
npx bak doctor --port 17373 --rpc-ws-port 17374
npx bak tabs list --rpc-ws-port 17374
npx bak page goto "https://example.com" --rpc-ws-port 17374
npx bak page wait --mode text --value "Example Domain" --rpc-ws-port 17374
npx bak call --method page.snapshot --params "{}" --rpc-ws-port 17374
```

