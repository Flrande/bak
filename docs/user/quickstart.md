# Quickstart

## Prerequisites

- Node.js 22.x
- `pnpm`
- Chromium browser (Chrome or Edge) with extension developer mode
- Windows + PowerShell 7

## 1) Install And Build

```powershell
pnpm i
pnpm build
```

## 2) Start Daemon

```powershell
node packages/cli/dist/bin.js serve --port 17373 --rpc-ws-port 17374
```

## 3) Generate Pair Token

In another terminal:

```powershell
node packages/cli/dist/bin.js pair
```

Copy the `token` from output.

## 4) Load Extension

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable Developer mode.
3. Load unpacked extension from `packages/extension/dist`.
4. Open extension popup.
5. Paste the pair token, keep port `17373`, save and connect.

## 5) Verify Health

```powershell
node packages/cli/dist/bin.js doctor
```

Then run a simple command:

```powershell
node packages/cli/dist/bin.js tabs list
```

## 6) First Browser Actions

```powershell
node packages/cli/dist/bin.js page goto "https://example.com"
node packages/cli/dist/bin.js page title
node packages/cli/dist/bin.js call --method page.snapshot --params "{}"
```

`page.snapshot` is currently exposed through generic `call`.
