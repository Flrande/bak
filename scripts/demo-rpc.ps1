param(
  [int]$RpcWsPort = 17374,
  [string]$BaseUrl = 'http://127.0.0.1:4173/form.html'
)

$ErrorActionPreference = 'Stop'

function Invoke-BakRpc {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][hashtable]$Params
  )

  $json = $Params | ConvertTo-Json -Compress -Depth 10
  $raw = pnpm --filter @bak/cli exec bak call --method $Method --params $json --rpc-ws-port $RpcWsPort
  return $raw | ConvertFrom-Json
}

Write-Host 'Creating session...'
Invoke-BakRpc -Method 'session.create' -Params @{ clientName = 'demo-script' } | Out-Null

Write-Host 'Start record...'
Invoke-BakRpc -Method 'memory.recordStart' -Params @{ intent = 'fill and submit form in test site' } | Out-Null

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

Write-Host 'Stop record and auto-extract skill...'
$stop = Invoke-BakRpc -Method 'memory.recordStop' -Params @{ outcome = 'success' }
$stop

if ($stop.skillId) {
  Write-Host "Run extracted skill: $($stop.skillId)"
  Invoke-BakRpc -Method 'memory.skills.run' -Params @{ id = $stop.skillId; params = @{ param_1 = 'Bak Demo 2'; param_2 = 'demo2@example.com'; param_3 = 'rerun note' } }
}

Write-Host 'Done.'
