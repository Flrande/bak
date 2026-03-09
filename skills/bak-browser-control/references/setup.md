# Setup Reference

Use this when the browser runtime is not paired or the user is starting from scratch.

## Fastest Bootstrap

Guide URL:

```text
https://raw.githubusercontent.com/Flrande/bak/refs/heads/master/docs/user/quickstart.md
```

Launcher:

```powershell
$quickstartUrl = 'https://raw.githubusercontent.com/Flrande/bak/refs/heads/master/docs/user/quickstart.md'
$launcherUrl = 'https://raw.githubusercontent.com/Flrande/bak/refs/heads/master/scripts/bootstrap/from-guide-url.ps1'
$launcherPath = Join-Path $env:TEMP 'bak-bootstrap-from-guide.ps1'
Invoke-WebRequest -Uri $launcherUrl -OutFile $launcherPath
pwsh -NoLogo -NoProfile -File $launcherPath -GuideUrl $quickstartUrl
```

## Manual Setup

```powershell
npm install -g @flrande/bak-cli @flrande/bak-extension
bak setup
bak serve --port 17373 --rpc-ws-port 17374
```

Extension path:

```powershell
Join-Path (npm root -g) '@flrande\bak-extension\dist'
```

Verification:

```powershell
bak doctor --port 17373 --rpc-ws-port 17374
bak tabs list --rpc-ws-port 17374
```
