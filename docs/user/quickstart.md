# Quickstart
<!-- BAK_BOOTSTRAP_SCRIPT_URL: https://raw.githubusercontent.com/Flrande/bak/refs/heads/master/scripts/bootstrap/agent-bootstrap.ps1 -->

This quickstart uses published npm packages and defaults to global install:

- `@flrande/bak-cli`
- `@flrande/bak-extension`

## 0) Agent Self-Bootstrap (Link-Driven)

If your coding agent only receives this quickstart URL, it can resolve and run the bootstrap script automatically:

```powershell
$quickstartUrl = 'https://raw.githubusercontent.com/Flrande/bak/refs/heads/master/docs/user/quickstart.md'
$quickstart = (Invoke-WebRequest -Uri $quickstartUrl).Content
$markerPattern = '(?im)<!--\s*BAK_BOOTSTRAP_SCRIPT_URL:\s*(?<url>https?://[^\s>]+)\s*-->'
if ($quickstart -notmatch $markerPattern) {
  throw "Cannot find BAK_BOOTSTRAP_SCRIPT_URL marker in $quickstartUrl"
}
$scriptUrl = $Matches.url
$scriptPath = Join-Path $env:TEMP 'bak-agent-bootstrap.ps1'
Invoke-WebRequest -Uri $scriptUrl -OutFile $scriptPath
pwsh -NoLogo -NoProfile -File $scriptPath
```

The script will:

- install global npm packages
- generate pairing token
- start daemon
- output extension path + result json

Browser security still requires extension loading/popup configuration.
If your agent can operate desktop UI, it can also finish those steps.

You can also use the helper launcher script:

```powershell
$quickstartUrl = 'https://raw.githubusercontent.com/Flrande/bak/refs/heads/master/docs/user/quickstart.md'
$launcherUrl = 'https://raw.githubusercontent.com/Flrande/bak/refs/heads/master/scripts/bootstrap/from-guide-url.ps1'
$launcherPath = Join-Path $env:TEMP 'bak-bootstrap-from-guide.ps1'
Invoke-WebRequest -Uri $launcherUrl -OutFile $launcherPath
pwsh -NoLogo -NoProfile -File $launcherPath -GuideUrl $quickstartUrl
```

## Prerequisites

- Node.js 22.x
- npm
- Chromium browser (Chrome or Edge)
- Windows + PowerShell 7

## 1) Install Globally (Recommended)

```powershell
npm install -g @flrande/bak-cli @flrande/bak-extension
```

## 2) One-Command Setup (Token + Paths)

```powershell
bak setup
```

This prints:

- pair token
- extension `dist` path
- recommended `serve`/`doctor` commands

## 3) Start The CLI Daemon

```powershell
bak serve --port 17373 --rpc-ws-port 17374
```

Keep this terminal running.

You can also merge step 2 + 3 with one command:

```powershell
bak serve --pair --port 17373 --rpc-ws-port 17374
```

## 4) Load Browser Extension

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Resolve global extension path:

```powershell
$extDist = Join-Path (npm root -g) '@flrande\bak-extension\dist'
$extDist
```

5. Select the printed `$extDist` path.
6. Open extension popup.
7. Paste pair token from `bak setup` (or `bak serve --pair` output).
8. Set port to `17373`.
9. Save/connect.

## 5) Verify Health

```powershell
bak doctor --port 17373 --rpc-ws-port 17374
bak tabs list --rpc-ws-port 17374
```

When connected, `doctor` should show `ok: true` and `extensionConnected: true`.

## 6) First Browser Control Commands

```powershell
bak page goto "https://example.com" --rpc-ws-port 17374
bak page title --rpc-ws-port 17374
bak call --method page.snapshot --params "{}" --rpc-ws-port 17374
```

`page.snapshot` is currently available through generic `call`.

## 7) Let Your Agent Use It

Give your coding agent these constraints:

1. All browser actions go through `bak` commands.
2. Do not start/stop `bak serve` for every action; keep one daemon session.
3. Use `--rpc-ws-port 17374` consistently.

A minimal action sequence an agent can run:

```powershell
bak tabs active --rpc-ws-port 17374
bak page goto "https://news.ycombinator.com" --rpc-ws-port 17374
bak page wait --mode text --value "Hacker News" --rpc-ws-port 17374
bak call --method page.snapshot --params "{}" --rpc-ws-port 17374
```

## 8) If `bak` Is Not In PATH

Use `npx` as fallback:

```powershell
npx bak setup
npx bak serve --pair --port 17373 --rpc-ws-port 17374
```
