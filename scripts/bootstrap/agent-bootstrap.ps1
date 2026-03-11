param(
  [int]$Port = 17373,
  [int]$RpcWsPort = 17374,
  [string]$DataDir = "",
  [switch]$SkipDaemonStart,
  [switch]$OpenExtensionsPage
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Command,
    [Parameter(Mandatory = $true)][string]$Description
  )

  & $Command
  $exitCode = $LASTEXITCODE
  if ($null -ne $exitCode -and $exitCode -ne 0) {
    throw "$Description failed with exit code $exitCode"
  }
}

function Invoke-NativeCapture {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Command,
    [Parameter(Mandatory = $true)][string]$Description
  )

  $output = & $Command
  $exitCode = $LASTEXITCODE
  if ($null -ne $exitCode -and $exitCode -ne 0) {
    throw "$Description failed with exit code $exitCode"
  }
  return ,$output
}

function Test-TcpPort {
  param(
    [Parameter(Mandatory = $true)][string]$HostName,
    [Parameter(Mandatory = $true)][int]$Port,
    [int]$TimeoutMs = 500
  )

  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $connectTask = $client.ConnectAsync($HostName, $Port)
    $completed = $connectTask.Wait($TimeoutMs)
    return $completed -and $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Wait-TcpPort {
  param(
    [Parameter(Mandatory = $true)][string]$HostName,
    [Parameter(Mandatory = $true)][int]$Port,
    [int]$TimeoutSeconds = 25
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-TcpPort -HostName $HostName -Port $Port -TimeoutMs 400) {
      return $true
    }
    Start-Sleep -Milliseconds 300
  }
  return $false
}

function Get-DefaultDataDir {
  $localAppData = [Environment]::GetFolderPath([System.Environment+SpecialFolder]::LocalApplicationData)
  if (-not [string]::IsNullOrWhiteSpace($localAppData)) {
    return (Join-Path $localAppData 'bak')
  }

  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    return (Join-Path $env:LOCALAPPDATA 'bak')
  }

  if (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) {
    return (Join-Path $env:APPDATA 'bak')
  }

  return (Join-Path (Get-Location) '.bak-data')
}

Write-Host "[bak-bootstrap] Installing global npm packages..."
Invoke-Native -Description 'npm global install' -Command {
  npm install -g @flrande/bak-cli @flrande/bak-extension
}

$npmPrefix = (Invoke-NativeCapture -Description 'npm prefix -g' -Command { npm prefix -g } | Select-Object -Last 1).Trim()
$npmRoot = (Invoke-NativeCapture -Description 'npm root -g' -Command { npm root -g } | Select-Object -Last 1).Trim()
$bakCmd = Join-Path $npmPrefix 'bak.cmd'
if (-not (Test-Path -LiteralPath $bakCmd)) {
  $bakCmd = 'bak'
}

$resolvedDataDir = if ($DataDir) {
  $DataDir
} else {
  Get-DefaultDataDir
}
New-Item -ItemType Directory -Force -Path $resolvedDataDir | Out-Null

$previousDataDir = $env:BAK_DATA_DIR
$env:BAK_DATA_DIR = $resolvedDataDir

try {
  Write-Host "[bak-bootstrap] Generating pairing token and setup payload..."
  $setupSource = 'setup'
  $setupError = $null
  $setup = $null

  try {
    $setupRaw = Invoke-NativeCapture -Description 'bak setup --json' -Command {
      & $bakCmd setup --port $Port --rpc-ws-port $RpcWsPort --json
    }
    $setupJson = ($setupRaw -join "`n").Trim()
    if (-not $setupJson) {
      throw 'bak setup --json returned empty output'
    }
    $setup = $setupJson | ConvertFrom-Json
  } catch {
    $setupSource = 'pair-fallback'
    $setupError = $_.Exception.Message
    Write-Warning "[bak-bootstrap] bak setup failed. Falling back to bak pair + manual setup payload. Detail: $setupError"

    $pairRaw = Invoke-NativeCapture -Description 'bak pair' -Command {
      & $bakCmd pair
    }
    $pairJson = ($pairRaw -join "`n").Trim()
    if (-not $pairJson) {
      throw 'bak pair returned empty output during setup fallback'
    }
    $pair = $pairJson | ConvertFrom-Json
    $setup = [PSCustomObject]@{
      token = [string]$pair.token
      createdAt = [string]$pair.createdAt
      expiresAt = [string]$pair.expiresAt
      port = $Port
      rpcWsPort = $RpcWsPort
      extensionDistPath = $null
      serveCommand = "$bakCmd serve --port $Port --rpc-ws-port $RpcWsPort"
      doctorCommand = "$bakCmd doctor --port $Port --rpc-ws-port $RpcWsPort"
    }
  }

  $extensionDistPath = if ($setup.extensionDistPath) {
    [string]$setup.extensionDistPath
  } else {
    Join-Path $npmRoot '@flrande\bak-extension\dist'
  }

  $daemonPid = $null
  $daemonStarted = $false
  $logDir = Join-Path $resolvedDataDir 'bootstrap-logs'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $stdoutLog = Join-Path $logDir 'daemon-stdout.log'
  $stderrLog = Join-Path $logDir 'daemon-stderr.log'

  if (-not $SkipDaemonStart) {
    if (Test-TcpPort -HostName '127.0.0.1' -Port $RpcWsPort -TimeoutMs 400) {
      Write-Host "[bak-bootstrap] Daemon already running on rpc port $RpcWsPort."
      $daemonStarted = $true
    } else {
      Write-Host "[bak-bootstrap] Starting daemon..."
      $daemon = Start-Process -FilePath $bakCmd -ArgumentList @(
        'serve',
        '--port', "$Port",
        '--rpc-ws-port', "$RpcWsPort"
      ) -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
      $daemonPid = $daemon.Id
      $daemonStarted = Wait-TcpPort -HostName '127.0.0.1' -Port $RpcWsPort -TimeoutSeconds 25
      if (-not $daemonStarted) {
        throw "Daemon failed to open rpc port $RpcWsPort. Check logs: $stderrLog"
      }
    }
  }

  try {
    Set-Clipboard -Value $setup.token
    $copiedToClipboard = $true
  } catch {
    $copiedToClipboard = $false
  }

  if ($OpenExtensionsPage) {
    try {
      Start-Process 'chrome://extensions'
    } catch {
      # non-fatal
    }
  }

  $result = [PSCustomObject]@{
    ok = $true
    setupSource = $setupSource
    setupError = $setupError
    port = $Port
    rpcWsPort = $RpcWsPort
    token = [string]$setup.token
    tokenExpiresAt = [string]$setup.expiresAt
    extensionDistPath = $extensionDistPath
    daemonPid = $daemonPid
    daemonStarted = $daemonStarted
    daemonStdoutLog = $stdoutLog
    daemonStderrLog = $stderrLog
    copiedTokenToClipboard = $copiedToClipboard
    nextSteps = @(
      "Load unpacked extension path: $extensionDistPath",
      "Open extension popup and set token + port $Port",
      "Run health check: $bakCmd doctor --port $Port --rpc-ws-port $RpcWsPort"
    )
  }

  $outFile = Join-Path $resolvedDataDir 'bootstrap-result.json'
  $resultJson = $result | ConvertTo-Json -Depth 6
  Set-Content -LiteralPath $outFile -Value $resultJson -Encoding UTF8

  Write-Host "[bak-bootstrap] Completed."
  Write-Host "[bak-bootstrap] Result file: $outFile"
  Write-Output $resultJson
} finally {
  if ($null -eq $previousDataDir) {
    Remove-Item Env:BAK_DATA_DIR -ErrorAction SilentlyContinue
  } else {
    $env:BAK_DATA_DIR = $previousDataDir
  }
}
