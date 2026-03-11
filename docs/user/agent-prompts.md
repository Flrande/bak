# Agent Prompts

## Preferred Path

If your agent supports Agent Skills, load:

- [../../skills/bak-browser-control/SKILL.md](../../skills/bak-browser-control/SKILL.md)

That skill tells the agent when to use `bak`, how to verify the runtime, how to create and maintain a session-owned browser binding, and when to stop for user action during extension setup.

## URL-Based Bootstrap

If your agent only accepts a guide URL, give it:

```text
https://raw.githubusercontent.com/Flrande/bak/refs/heads/master/docs/user/quickstart.md
```

## Plain Prompt Fallback

```text
Use BAK CLI for browser work.

Environment:
- OS: Windows
- Shell: PowerShell 7
- CLI command: bak
- RPC WebSocket port: 17374

Rules:
1. Run `bak doctor --port 17373 --rpc-ws-port 17374` before browser work.
2. If the runtime is not healthy, guide the user through extension setup and wait for confirmation.
3. Create a session with `bak session create --client-name <name> --rpc-ws-port 17374`, keep the returned `sessionId`, and use `bak session ensure --session-id <sessionId> --rpc-ws-port 17374` before opening agent-owned tabs.
4. Verify major actions with page wait/url/title/snapshot or debug dump-state.
5. Use `bak call --method ... --params ...` for protocol methods without first-class CLI commands.
6. Do not claim success until a verification command confirms the state.
```

## Minimal Command Set

```powershell
bak doctor --port 17373 --rpc-ws-port 17374
$session = bak session create --client-name agent-a --rpc-ws-port 17374 | ConvertFrom-Json
$sessionId = $session.sessionId
bak session ensure --session-id $sessionId --rpc-ws-port 17374
bak session open-tab --session-id $sessionId --url "https://example.com" --rpc-ws-port 17374
bak page wait --session-id $sessionId --mode text --value "Example Domain" --rpc-ws-port 17374
bak page snapshot --session-id $sessionId --include-base64 --rpc-ws-port 17374
```
