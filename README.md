# Browser Agent Kit (`bak`)

`bak` lets a coding agent control your real browser through:

- a local CLI daemon
- a Chromium extension

Use it when you want the agent to click, type, read pages, inspect DOM/text/a11y, work with frame or shadow DOM, and reuse remembered browser paths.

## Install

Prerequisites:

- Windows + PowerShell 7
- Node.js 22+
- Chrome or Edge

Install the CLI and extension package:

```powershell
npm install -g @flrande/bak-cli @flrande/bak-extension
```

If `bak` is not in PATH yet, use `npx @flrande/bak-cli@latest ...` for the same commands.

## Start `bak`

Create a pairing token:

```powershell
bak setup
```

Start the daemon:

```powershell
bak serve --port 17373 --rpc-ws-port 17374
```

Leave this process running.

## Load The Extension

1. Open `chrome://extensions` or `edge://extensions`
2. Turn on `Developer mode`
3. Click `Load unpacked`
4. Load this folder:

```powershell
Join-Path (npm root -g) '@flrande\bak-extension\dist'
```

5. Open the extension popup
6. Paste the token from `bak setup`
7. Keep port `17373`
8. Click connect

## Verify

```powershell
bak doctor --port 17373 --rpc-ws-port 17374
bak tabs list --rpc-ws-port 17374
```

You want to see:

- `ok: true`
- `extensionConnected: true`

## Let Your Agent Use It

Give your agent a short instruction like this:

```text
Use `bak` for browser tasks. If the browser is not connected, tell me to complete extension setup first. Always verify with `bak doctor --port 17373 --rpc-ws-port 17374` before doing browser work.
```

Common commands the agent can use:

```powershell
bak page goto "https://example.com" --rpc-ws-port 17374
bak page title --rpc-ws-port 17374
bak page snapshot --include-base64 --rpc-ws-port 17374
bak debug dump-state --include-snapshot --rpc-ws-port 17374
bak element click --css "#submit" --rpc-ws-port 17374
bak element type --css "#email" --value "me@example.com" --clear --rpc-ws-port 17374
bak memory capture begin --goal "return to billing settings" --rpc-ws-port 17374
bak memory search --goal "return to billing settings" --kind route --rpc-ws-port 17374
```

## What `bak` Supports

- browser control: click, type, select, upload, keyboard, mouse
- browser reading: snapshot, text, DOM, accessibility tree
- context handling: frame, shadow DOM, frame + shadow
- debug: console, network, structured dump-state
- explicit memory: capture, review, promote, search, explain, plan, execute, patch

Notes:

- console and network are useful agent context, but still best-effort rather than full DevTools parity
- memory is explicit and advisory, not automatic

## More Docs

- [Quickstart](./docs/user/quickstart.md)
- [CLI Guide](./docs/user/cli-guide.md)
- [Memory Guide](./docs/user/memory-guide.md)
- [Protocol](./docs/PROTOCOL.md)
- [Developer Docs](./docs/developer/README.md)
