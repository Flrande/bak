# Quickstart
<!-- BAK_BOOTSTRAP_SCRIPT_URL: https://raw.githubusercontent.com/Flrande/bak/refs/heads/master/scripts/bootstrap/agent-bootstrap.ps1 -->

This is the single source of truth for installing, upgrading, and verifying `bak`.

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

The launcher installs the CLI and extension packages, generates a pairing token, and writes `bootstrap-result.json` under the bak data directory. On Windows, the default location is `Join-Path $env:LOCALAPPDATA 'bak'`. Pass `-DataDir` to the bootstrap script if you want a different location. `bak` auto-starts the local runtime later when `bak doctor` or other CLI commands need it, unless you are intentionally running `bak serve` in the foreground for debugging.

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

Prime the local runtime and confirm the expected ports:

```powershell
bak doctor --port 17373 --rpc-ws-port 17374
bak status --port 17373 --rpc-ws-port 17374
```

`bak doctor` is the recommended first check. It auto-starts the local runtime when needed unless you are already running `bak serve` manually for debugging. Use `bak status` when you want to confirm whether the runtime is already up before continuing.
At this stage, `bak doctor` can still show `extensionConnected: false` until you finish the extension load and popup connect steps below.

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

If you later reinstall or upgrade `@flrande/bak-extension`, reload that unpacked extension from the extensions page before expecting the running browser to report the new version.

## 4. Verify The Runtime

```powershell
bak doctor --port 17373 --rpc-ws-port 17374
bak status --port 17373 --rpc-ws-port 17374
bak tabs list --rpc-ws-port 17374
```

A healthy runtime reports:

- `ok: true`
- `extensionConnected: true`
- no `versionCompatibility` warning in `summary.warningChecks`

If `bak doctor` warns about `versionCompatibility`, update both packages and reload the unpacked extension:

```powershell
npm install -g @flrande/bak-cli @flrande/bak-extension
bak doctor --port 17373 --rpc-ws-port 17374
bak status --port 17373 --rpc-ws-port 17374
```

## 5. Runtime Lifecycle

Use these commands when you need to inspect or reset the local runtime:

```powershell
bak status --port 17373 --rpc-ws-port 17374
bak stop --port 17373 --rpc-ws-port 17374
bak doctor --port 17373 --rpc-ws-port 17374
```

`bak stop` is useful when you want a clean restart or need to free the local ports. For normal use, do not keep `bak serve` running in a separate terminal. Let `bak doctor` or the next CLI command auto-start the runtime again.

## 6. Advanced: Foreground Runtime Logs

Run `bak serve` only when you need foreground logs or manual debugging:

```powershell
bak serve --port 17373 --rpc-ws-port 17374
```

This is an advanced path, not the normal setup flow.

## 7. First Browser Action

```powershell
$session = bak session create --client-name agent-a --rpc-ws-port 17374 | ConvertFrom-Json
$sessionId = $session.sessionId
bak session ensure --session-id $sessionId --rpc-ws-port 17374
bak session open-tab --session-id $sessionId --url "https://example.com" --active --rpc-ws-port 17374
bak page title --session-id $sessionId --rpc-ws-port 17374
bak page snapshot --session-id $sessionId --include-base64 --rpc-ws-port 17374
```

Use `bak session ...` for agent-owned tabs. Reach for `bak tabs ...` only when you need browser-wide inspection or manual recovery outside the session helpers. `bak session open-tab` keeps the current default session tab unchanged unless you pass `--active` or later call `bak session set-active-tab`. `bak call` remains the escape hatch for protocol-only methods, and any future first-class helpers follow the existing noun-based surface instead of a `workspace` namespace.

If you are done with install and only need day-to-day commands, continue with [cli-guide.md](./cli-guide.md). If you are handing `bak` to an agent, continue with [agent-prompts.md](./agent-prompts.md).

## 8. Dynamic Page Basics

When important data is not visible in the DOM, use the runtime, network, table, and freshness helpers in a fixed escalation order:

```powershell
bak inspect page-data --session-id $sessionId --rpc-ws-port 17374
bak page extract --session-id $sessionId --path "table_data" --resolver auto --rpc-ws-port 17374
bak page eval --session-id $sessionId --expr "typeof market_data !== 'undefined' ? market_data.QQQ : null" --rpc-ws-port 17374
bak network search --session-id $sessionId --pattern "table_data" --rpc-ws-port 17374
bak network get req_123 --session-id $sessionId --include request response --rpc-ws-port 17374
bak network replay --session-id $sessionId --request-id req_123 --mode json --with-schema auto --rpc-ws-port 17374
bak table list --session-id $sessionId --rpc-ws-port 17374
bak table rows --session-id $sessionId --table table-1 --all --rpc-ws-port 17374
bak page freshness --session-id $sessionId --rpc-ws-port 17374
bak inspect live-updates --session-id $sessionId --rpc-ws-port 17374
```

`bak inspect page-data` returns likely globals, tables, recent requests, and `recommendedNextSteps`. `bak page extract --resolver auto` safely checks `globalThis` first and then lexical page-world bindings. `bak inspect live-updates` emphasizes recent network cadence, not only explicit timers.

Add `--requires-confirm` to `bak page fetch` or non-readonly `bak network replay` when the request can change remote state.

## 9. Minimal Fallback

If `bak` is not on `PATH` yet, use:

```powershell
npx @flrande/bak-cli@latest doctor --port 17373 --rpc-ws-port 17374
```
