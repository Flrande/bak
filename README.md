# Browser Agent Kit (`bak`)

`bak` gives an agent a safe, scriptable path into your real Chromium browser through:

- a local CLI daemon
- a Chromium extension
- an explicit agent session with dedicated tabs
- explicit page, element, and context control

## Install

Requirements:

- Windows + PowerShell 7
- Node.js 22+
- Chrome or Edge

```powershell
npm install -g @flrande/bak-cli @flrande/bak-extension
```

If `bak` is not in `PATH` yet, use `npx @flrande/bak-cli@latest ...` for the CLI commands below.

## Start The Runtime

Create a pairing token:

```powershell
bak setup
```

Start the daemon and keep it running:

```powershell
bak serve --port 17373 --rpc-ws-port 17374
```

## Load The Extension

1. Open `chrome://extensions` or `edge://extensions`.
2. Turn on `Developer mode`.
3. Click `Load unpacked`.
4. Load this folder:

```powershell
Join-Path (npm root -g) '@flrande\bak-extension\dist'
```

5. Open the extension popup.
6. Paste the token from `bak setup`.
7. Keep port `17373`.
8. Click connect.

## Verify

```powershell
bak doctor --port 17373 --rpc-ws-port 17374
bak tabs list --rpc-ws-port 17374
```

You want:

- `ok: true`
- `extensionConnected: true`

## Command Model

- `bak session ...` creates, repairs, and targets agent sessions plus their dedicated tabs.
- `bak tabs ...` inspects or repairs browser tabs directly outside the session helpers.
- `bak page`, `bak context`, `bak element`, `bak debug`, `bak network`, `bak table`, `bak inspect`, `bak capture`, `bak keyboard`, `bak mouse`, and `bak file` act on the current session tab by default.
- `bak call` is the fallback for protocol-only methods. When new first-class commands land, they follow the same noun-based surface instead of a `workspace` namespace.

## First Browser Commands

```powershell
$session = bak session create --client-name agent-a --rpc-ws-port 17374 | ConvertFrom-Json
$sessionId = $session.sessionId
bak session ensure --session-id $sessionId --rpc-ws-port 17374
bak session open-tab --session-id $sessionId --url "https://example.com" --rpc-ws-port 17374
bak page title --session-id $sessionId --rpc-ws-port 17374
bak page snapshot --session-id $sessionId --include-base64 --rpc-ws-port 17374
```

## Dynamic Data Workflows

Use the dynamic page helpers when data lives in runtime state, virtual tables, or XHR/fetch responses instead of visible DOM:

```powershell
bak page extract --session-id $sessionId --path "table_data" --rpc-ws-port 17374
bak page eval --session-id $sessionId --expr "window.market_data?.QQQ" --rpc-ws-port 17374
bak network search --session-id $sessionId --pattern "table_data" --rpc-ws-port 17374
bak network replay --session-id $sessionId --request-id req_123 --mode json --rpc-ws-port 17374
bak table rows --session-id $sessionId --table table-1 --all --rpc-ws-port 17374
bak page freshness --session-id $sessionId --rpc-ws-port 17374
```

Mutating `bak page fetch` calls and non-readonly `bak network replay` calls now require explicit `--requires-confirm`.

## For Agents

- Load the repo skill: [skills/bak-browser-control/SKILL.md](./skills/bak-browser-control/SKILL.md)
- For URL-based bootstrap, hand the agent: [docs/user/quickstart.md](./docs/user/quickstart.md)

## Docs By Task

- Fast start: [docs/user/quickstart.md](./docs/user/quickstart.md)
- Daily CLI usage: [docs/user/cli-guide.md](./docs/user/cli-guide.md)
- Troubleshooting: [docs/user/troubleshooting.md](./docs/user/troubleshooting.md)
- Contributor docs: [docs/developer/README.md](./docs/developer/README.md)
- Protocol and reference: [docs/PROTOCOL.md](./docs/PROTOCOL.md), [docs/reference/README.md](./docs/reference/README.md)
