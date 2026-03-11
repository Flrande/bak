# Quickstart
<!-- BAK_BOOTSTRAP_SCRIPT_URL: https://raw.githubusercontent.com/Flrande/bak/refs/heads/master/scripts/bootstrap/agent-bootstrap.ps1 -->

This is the fastest current setup path for `bak`.

## 1. Agent Bootstrap From This Guide

If your agent can bootstrap from a guide URL, give it:

```text
https://raw.githubusercontent.com/Flrande/bak/refs/heads/master/docs/user/quickstart.md
```

If you want to run the launcher yourself:

```powershell
$quickstartUrl = 'https://raw.githubusercontent.com/Flrande/bak/refs/heads/master/docs/user/quickstart.md'
$launcherUrl = 'https://raw.githubusercontent.com/Flrande/bak/refs/heads/master/scripts/bootstrap/from-guide-url.ps1'
$launcherPath = Join-Path $env:TEMP 'bak-bootstrap-from-guide.ps1'
Invoke-WebRequest -Uri $launcherUrl -OutFile $launcherPath
pwsh -NoLogo -NoProfile -File $launcherPath -GuideUrl $quickstartUrl
```

The launcher installs the CLI and extension packages, generates a pairing token, starts the daemon when needed, and writes `bootstrap-result.json` under the bak data directory. On Windows, the default location is `Join-Path $env:LOCALAPPDATA 'bak'`. Pass `-DataDir` to the bootstrap script if you want a different location.

## 2. Manual Setup

Requirements:

- Windows + PowerShell 7
- Node.js 22+
- Chrome or Edge

Install:

```powershell
npm install -g @flrande/bak-cli @flrande/bak-extension
```

Create a pairing token:

```powershell
bak setup
```

Start the daemon and keep it running:

```powershell
bak serve --port 17373 --rpc-ws-port 17374
```

## 3. Load The Extension

1. Open `chrome://extensions` or `edge://extensions`.
2. Turn on `Developer mode`.
3. Click `Load unpacked`.
4. Load this folder:

```powershell
Join-Path (npm root -g) '@flrande\bak-extension\dist'
```

5. Open the extension popup.
6. Paste the token from `bak setup` or the bootstrap result.
7. Keep port `17373`.
8. Click connect.

## 4. Verify The Runtime

```powershell
bak doctor --port 17373 --rpc-ws-port 17374
bak tabs list --rpc-ws-port 17374
```

A healthy runtime reports:

- `ok: true`
- `extensionConnected: true`

## 5. First Browser Action

```powershell
$session = bak session create --client-name agent-a --rpc-ws-port 17374 | ConvertFrom-Json
$sessionId = $session.sessionId
bak session ensure --session-id $sessionId --rpc-ws-port 17374
bak session open-tab --session-id $sessionId --url "https://example.com" --rpc-ws-port 17374
bak page title --session-id $sessionId --rpc-ws-port 17374
bak page snapshot --session-id $sessionId --include-base64 --rpc-ws-port 17374
```

Use `bak session ...` for agent-owned tabs. Reach for `bak tabs ...` only when you need browser-wide inspection or manual recovery outside the session helpers. `bak call` remains the escape hatch for protocol-only methods, and any future first-class helpers follow the existing noun-based surface instead of a `workspace` namespace.

## 6. Dynamic Page Basics

When important data is not visible in the DOM, use the runtime, network, table, and freshness helpers:

```powershell
bak page extract --session-id $sessionId --path "table_data" --rpc-ws-port 17374
bak page eval --session-id $sessionId --expr "window.market_data?.QQQ" --rpc-ws-port 17374
bak network get req_123 --session-id $sessionId --include request response --rpc-ws-port 17374
bak page fetch --session-id $sessionId --url "https://example.com/api/data" --mode json --rpc-ws-port 17374
bak table list --session-id $sessionId --rpc-ws-port 17374
bak page freshness --session-id $sessionId --rpc-ws-port 17374
```

Add `--requires-confirm` to `bak page fetch` when the request can change remote state.

## 7. Minimal Fallback

If `bak` is not on `PATH` yet, use:

```powershell
npx @flrande/bak-cli@latest doctor --port 17373 --rpc-ws-port 17374
```
