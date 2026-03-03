# Quickstart
<!-- BAK_BOOTSTRAP_SCRIPT_URL: https://raw.githubusercontent.com/Flrande/bak/refs/heads/master/scripts/bootstrap/agent-bootstrap.ps1 -->

This is the single source of truth for first-time setup.

Packages used in this guide:

- `@flrande/bak-cli`
- `@flrande/bak-extension`

## 0) One Sentence For Your Agent

Paste this sentence:

```text
Read and execute https://raw.githubusercontent.com/Flrande/bak/refs/heads/master/docs/user/quickstart.md, auto-run the bootstrap script referenced by BAK_BOOTSTRAP_SCRIPT_URL, verify with `bak doctor --port 17373 --rpc-ws-port 17374`, and if extension is not connected explicitly guide the user to complete extension setup in Chrome (`chrome://extensions`) or Edge (`edge://extensions`) with Load unpacked plus popup token/port connect, then wait for confirmation before continuing browser tasks via `bak` CLI.
```

## 1) Prerequisites

- Node.js 22.x
- npm
- Chromium browser (Chrome or Edge)
- Windows + PowerShell 7

## 2) Agent Bootstrap From This URL

Run this launcher command (or let your agent run it):

```powershell
$quickstartUrl = 'https://raw.githubusercontent.com/Flrande/bak/refs/heads/master/docs/user/quickstart.md'
$launcherUrl = 'https://raw.githubusercontent.com/Flrande/bak/refs/heads/master/scripts/bootstrap/from-guide-url.ps1'
$launcherPath = Join-Path $env:TEMP 'bak-bootstrap-from-guide.ps1'
Invoke-WebRequest -Uri $launcherUrl -OutFile $launcherPath
pwsh -NoLogo -NoProfile -File $launcherPath -GuideUrl $quickstartUrl
```

Expected bootstrap output:

- global npm install of CLI + extension packages
- pairing token (`bak setup` preferred, auto-fallback to `bak pair` when needed)
- daemon start status
- extension `dist` path
- result JSON at `.bak-data/bootstrap-result.json`

## 3) Load Extension And Pair

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Use extension path:

```powershell
Join-Path (npm root -g) '@flrande\bak-extension\dist'
```

5. Open extension popup.
6. Paste token from bootstrap output.
7. Keep port `17373`.
8. Save/connect.

## 4) Verify Runtime

```powershell
bak doctor --port 17373 --rpc-ws-port 17374
bak tabs list --rpc-ws-port 17374
```

Healthy runtime should show:

- `ok: true`
- `extensionConnected: true`

## 5) First Browser Actions

```powershell
bak tabs active --rpc-ws-port 17374
bak page goto "https://example.com" --rpc-ws-port 17374
bak page title --rpc-ws-port 17374
bak call --method page.snapshot --params "{}" --rpc-ws-port 17374
```

## 6) Compatibility Check (Important)

Check your installed CLI supports quickstart commands:

```powershell
bak --help
bak serve --help
```

You should see:

- `setup` command
- `serve --pair` option

If your installed version is older and lacks these features, use fallback:

```powershell
bak pair
bak serve --port 17373 --rpc-ws-port 17374
```

Then complete extension pairing from popup and rerun `bak doctor`.

## 7) PATH Fallback

If `bak` is not in PATH:

```powershell
npx bak doctor --port 17373 --rpc-ws-port 17374
```
