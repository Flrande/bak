param(
  [int]$RpcWsPort = 17374,
  [string]$BaseUrl = 'http://127.0.0.1:4173/form.html',
  [string]$CliBin
)

$ErrorActionPreference = 'Stop'

if (-not $CliBin) {
  $repoRoot = Split-Path -LiteralPath $PSScriptRoot -Parent
  $CliBin = Join-Path -Path $repoRoot -ChildPath 'packages/cli/dist/bin.js'
}

if (-not (Test-Path -LiteralPath $CliBin)) {
  throw "CLI binary not found at '$CliBin'. Run 'pnpm build' first."
}

function Invoke-BakRpc {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][hashtable]$Params
  )

  $json = $Params | ConvertTo-Json -Compress -Depth 10
  $raw = & node $CliBin call --method $Method --params $json --rpc-ws-port $RpcWsPort
  return $raw | ConvertFrom-Json
}

Write-Host 'Creating session...'
Invoke-BakRpc -Method 'session.create' -Params @{ clientName = 'demo-script' } | Out-Null

Write-Host 'Navigate to form page...'
Invoke-BakRpc -Method 'page.goto' -Params @{ url = $BaseUrl } | Out-Null
Start-Sleep -Milliseconds 600

Write-Host 'Type fields...'
Invoke-BakRpc -Method 'element.type' -Params @{ locator = @{ css = '#name-input' }; text = 'Bak Demo' } | Out-Null
Invoke-BakRpc -Method 'element.type' -Params @{ locator = @{ css = '#email-input' }; text = 'demo@example.com' } | Out-Null
Invoke-BakRpc -Method 'element.type' -Params @{ locator = @{ css = '#note-input' }; text = 'hello from demo' } | Out-Null

Write-Host 'Click save (high-risk action, overlay confirmation expected)...'
Invoke-BakRpc -Method 'element.click' -Params @{ locator = @{ css = '#save-btn' } } | Out-Null

Write-Host 'Capture snapshot...'
$snapshot = Invoke-BakRpc -Method 'page.snapshot' -Params @{}
$snapshot

Write-Host 'Done.'
