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

The launcher installs the CLI and extension packages, generates a pairing token, and writes `bootstrap-result.json` under the bak data directory. On Windows, the default location is `Join-Path $env:LOCALAPPDATA 'bak'`. Pass `-DataDir` to the bootstrap script if you want a different location. `bak` auto-starts the local runtime later when `bak doctor` or other CLI commands need it, and the managed background runtime auto-stops again after the last live session closes. If you are intentionally running `bak serve` in the foreground for debugging, that foreground process does not auto-stop.

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
If the runtime metadata or managed runtime state looks stale, rerun:

```powershell
bak doctor --fix --port 17373 --rpc-ws-port 17374
```

`--fix` only repairs safe local runtime/config state. It does not rotate the pairing token, reload the unpacked extension, or change any session tabs for you.
At this stage, `bak doctor` can still show `extensionConnected: false` until you finish the extension load and popup setup steps below.

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
8. Click `Save settings`.
9. If the popup still does not show a connected state, open `Advanced bridge controls` and click `Reconnect bridge`.

If you later reinstall or upgrade `@flrande/bak-extension`, reload that unpacked extension from the extensions page before expecting the running browser to report the new version.

## 4. Verify The Runtime

```powershell
bak doctor --port 17373 --rpc-ws-port 17374
bak status --port 17373 --rpc-ws-port 17374
bak session dashboard --rpc-ws-port 17374
bak tabs list --rpc-ws-port 17374
```

A healthy runtime reports:

- `ok: true`
- `extensionConnected: true`
- no `versionCompatibility` warning in `summary.warningChecks`

`bak doctor` now also reports:

- `diagnosis[]` for the concrete issue code and root cause
- `fixesApplied[]` for safe local repairs already attempted
- `nextActions[]` for the exact command, path, or manual step to try next

`bak session dashboard` is the fastest way to confirm which sessions are attached, which ones are detached, which tab is active, and what frame/shadow context depth the session is carrying.

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
bak doctor --fix --port 17373 --rpc-ws-port 17374
```

`bak stop` is useful when you want a clean restart or need to free the local ports. `bak doctor --fix` is the safe repair path when the stored runtime metadata no longer matches reality. For normal use, do not keep `bak serve` running in a separate terminal. Let `bak doctor` or the next CLI command auto-start the runtime again, and let the managed runtime auto-stop once all sessions are gone.

## 6. Advanced: Foreground Runtime Logs

Run `bak serve` only when you need foreground logs or manual debugging:

```powershell
bak serve --port 17373 --rpc-ws-port 17374
```

This is an advanced path, not the normal setup flow. Foreground `bak serve` does not auto-stop when sessions close.

## 7. First Browser Action

```powershell
$clientName = 'agent-a'
$session = bak session resolve --client-name $clientName --rpc-ws-port 17374 | ConvertFrom-Json
$sessionId = $session.sessionId
bak session open-tab --client-name $clientName --url "https://example.com" --active --rpc-ws-port 17374
bak session dashboard --rpc-ws-port 17374
bak page title --client-name $clientName --rpc-ws-port 17374
bak page snapshot --client-name $clientName --include-base64 --annotate --rpc-ws-port 17374
bak session close-tab --client-name $clientName --rpc-ws-port 17374
```

Use `bak session ...` for agent-owned tabs. The normal agent workflow is to pass a stable `--client-name` and let `bak` auto-resolve the session on browser-affecting commands. The resolution order is `--session-id` > `BAK_SESSION_ID` > `--client-name` > `BAK_CLIENT_NAME` > `CODEX_THREAD_ID`. Use an explicit `sessionId` when you are handing work off, debugging, or reusing a session across processes.

`bak tabs list`, `bak tabs get`, and `bak tabs active` remain browser-wide diagnostics. Reach for `bak tabs new`, `bak tabs focus`, and `bak tabs close` only when you need recovery-oriented compatibility commands that still stay inside the resolved session instead of acting on arbitrary browser tabs.

For page understanding, `bak page snapshot --annotate` adds a numbered visual overlay plus `refs[]`/`actionSummary` in JSON. When you need to compare page states, add `--diff-with <older-elements-or-snapshot.json>` to get structured `addedRefs`, `removedRefs`, and `changedRefs` output.

`bak session open-tab` keeps the current default session tab unchanged unless you pass `--active` or later call `bak session set-active-tab`. `bak session close-tab` closes a tab in the current session; closing the last session tab auto-closes that session, and when all sessions are gone the managed background runtime auto-stops. `bak call` remains the escape hatch for protocol-only methods, and any future first-class helpers follow the existing noun-based surface instead of a `workspace` namespace.

If you are done with install and only need day-to-day commands, continue with [cli-guide.md](./cli-guide.md). If you are handing `bak` to an agent, continue with [agent-prompts.md](./agent-prompts.md).

## 8. Dynamic Page Basics

When important data is not visible in the DOM, use the runtime, network, table, and freshness helpers in a fixed escalation order:

```powershell
bak inspect page-data --client-name $clientName --rpc-ws-port 17374
bak page extract --client-name $clientName --path "table_data" --resolver auto --rpc-ws-port 17374
bak page eval --client-name $clientName --expr "typeof market_data !== 'undefined' ? market_data.QQQ : null" --rpc-ws-port 17374
bak network search --client-name $clientName --pattern "table_data" --rpc-ws-port 17374
bak network get req_123 --client-name $clientName --include request response --rpc-ws-port 17374
bak network replay --client-name $clientName --request-id req_123 --mode json --with-schema auto --rpc-ws-port 17374
bak table list --client-name $clientName --rpc-ws-port 17374
bak table rows --client-name $clientName --table table-1 --all --max-rows 10000 --rpc-ws-port 17374
bak table export --client-name $clientName --table table-1 --all --max-rows 10000 --out .\table.json --rpc-ws-port 17374
bak page freshness --client-name $clientName --rpc-ws-port 17374
bak inspect live-updates --client-name $clientName --rpc-ws-port 17374
```

`bak inspect page-data` now returns structured `dataSources`, `sourceMappings`, and `recommendedNextActions` alongside the existing discovery fields. `bak table list/schema/rows/export` also include `intelligence` or `extraction` metadata so you can tell whether a table is virtualized and whether the current read is complete or partial. `bak page extract --resolver auto` safely checks `globalThis` first and then lexical page-world bindings. `bak inspect live-updates` emphasizes recent network cadence, not only explicit timers.

Add `--requires-confirm` to `bak page fetch` or non-readonly `bak network replay` when the request can change remote state.

## 9. Minimal Fallback

If `bak` is not on `PATH` yet, use:

```powershell
npx @flrande/bak-cli@latest doctor --port 17373 --rpc-ws-port 17374
```
