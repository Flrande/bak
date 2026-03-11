# Browser Agent Kit (`bak`)

`bak` gives an agent a safe, scriptable path into your real Chromium browser through:

- a local CLI daemon
- a Chromium extension
- an explicit browser workspace for agent-owned tabs
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

## First Browser Commands

```powershell
bak workspace ensure --rpc-ws-port 17374
bak workspace open-tab --url "https://example.com" --rpc-ws-port 17374
bak page title --rpc-ws-port 17374
bak page snapshot --include-base64 --rpc-ws-port 17374
```

## For Agents

- Load the repo skill: [skills/bak-browser-control/SKILL.md](./skills/bak-browser-control/SKILL.md)
- For URL-based bootstrap, hand the agent: [docs/user/quickstart.md](./docs/user/quickstart.md)

## Docs By Task

- Fast start: [docs/user/quickstart.md](./docs/user/quickstart.md)
- Daily CLI usage: [docs/user/cli-guide.md](./docs/user/cli-guide.md)
- Troubleshooting: [docs/user/troubleshooting.md](./docs/user/troubleshooting.md)
- Contributor docs: [docs/developer/README.md](./docs/developer/README.md)
- Protocol and reference: [docs/PROTOCOL.md](./docs/PROTOCOL.md), [docs/reference/README.md](./docs/reference/README.md)
