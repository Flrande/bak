# Quickstart

This quickstart uses published npm packages:

- `@flrande/bak-cli`
- `@flrande/bak-extension`

## Prerequisites

- Node.js 22.x
- npm
- Chromium browser (Chrome or Edge)
- Windows + PowerShell 7

## 1) Prepare A Runtime Folder

```powershell
New-Item -ItemType Directory -Force -Path "$HOME\bak-runtime" | Out-Null
Set-Location -LiteralPath "$HOME\bak-runtime"
npm init -y
npm install @flrande/bak-cli @flrande/bak-extension
```

## 2) Start The CLI Daemon

```powershell
npx bak serve --port 17373 --rpc-ws-port 17374
```

Keep this terminal running.

## 3) Generate Pair Token

Open a second terminal in the same folder:

```powershell
Set-Location -LiteralPath "$HOME\bak-runtime"
npx bak pair
```

Copy the `token` from output.

## 4) Load Browser Extension

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select:
   `C:\Users\<your-user>\bak-runtime\node_modules\@flrande\bak-extension\dist`
5. Open extension popup.
6. Paste pair token.
7. Set port to `17373`.
8. Save/connect.

## 5) Verify Health

```powershell
npx bak doctor --port 17373 --rpc-ws-port 17374
npx bak tabs list --rpc-ws-port 17374
```

When connected, `doctor` should show `ok: true` and `extensionConnected: true`.

## 6) First Browser Control Commands

```powershell
npx bak page goto "https://example.com" --rpc-ws-port 17374
npx bak page title --rpc-ws-port 17374
npx bak call --method page.snapshot --params "{}" --rpc-ws-port 17374
```

`page.snapshot` is currently available through generic `call`.

## 7) Let Your Agent Use It

Give your coding agent these constraints:

1. All browser actions go through `bak` commands.
2. Do not start/stop `bak serve` for every action; keep one daemon session.
3. Use `--rpc-ws-port 17374` consistently.

A minimal action sequence an agent can run:

```powershell
npx bak tabs active --rpc-ws-port 17374
npx bak page goto "https://news.ycombinator.com" --rpc-ws-port 17374
npx bak page wait --mode text --value "Hacker News" --rpc-ws-port 17374
npx bak call --method page.snapshot --params "{}" --rpc-ws-port 17374
```
