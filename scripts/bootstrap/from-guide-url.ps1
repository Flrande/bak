param(
  [Parameter(Mandatory = $true)][string]$GuideUrl,
  [int]$Port = 17373,
  [int]$RpcWsPort = 17374,
  [string]$DataDir = "",
  [switch]$SkipDaemonStart,
  [switch]$OpenExtensionsPage
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

function Resolve-BootstrapScriptUrl {
  param([Parameter(Mandatory = $true)][string]$GuideMarkdown)

  $markerPattern = '(?im)<!--\s*BAK_BOOTSTRAP_SCRIPT_URL:\s*(?<url>https?://[^\s>]+)\s*-->'
  $markerMatch = [regex]::Match($GuideMarkdown, $markerPattern)
  if ($markerMatch.Success) {
    return [string]$markerMatch.Groups['url'].Value
  }

  $legacyPattern = '(?im)https://raw\.githubusercontent\.com/[^\s"''`)]*/scripts/bootstrap/agent-bootstrap\.ps1'
  $legacyMatch = [regex]::Match($GuideMarkdown, $legacyPattern)
  if ($legacyMatch.Success) {
    return [string]$legacyMatch.Value
  }

  throw 'Cannot find bootstrap script URL marker in guide. Expected <!-- BAK_BOOTSTRAP_SCRIPT_URL: ... -->.'
}

Write-Host "[bak-bootstrap] Fetching guide: $GuideUrl"
$guideResponse = Invoke-WebRequest -Uri $GuideUrl
$guideMarkdown = [string]$guideResponse.Content
$bootstrapScriptUrl = Resolve-BootstrapScriptUrl -GuideMarkdown $guideMarkdown

$scriptPath = Join-Path $env:TEMP 'bak-agent-bootstrap.ps1'
Write-Host "[bak-bootstrap] Resolved bootstrap script: $bootstrapScriptUrl"
Invoke-WebRequest -Uri $bootstrapScriptUrl -OutFile $scriptPath

$scriptArgs = @{
  Port = $Port
  RpcWsPort = $RpcWsPort
}
if ($DataDir) {
  $scriptArgs['DataDir'] = $DataDir
}
if ($SkipDaemonStart) {
  $scriptArgs['SkipDaemonStart'] = $true
}
if ($OpenExtensionsPage) {
  $scriptArgs['OpenExtensionsPage'] = $true
}

Write-Host '[bak-bootstrap] Running bootstrap script...'
& $scriptPath @scriptArgs
