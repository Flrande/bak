$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..' '..')
$schemaPath = Join-Path $repoRoot 'packages' 'protocol' 'schemas' 'protocol.schema.json'
$indexPath = Join-Path $repoRoot 'tests' 'e2e' 'methods' 'method-case-index.json'
$outputPath = Join-Path $repoRoot 'docs' 'E2E_MATRIX.md'
$statusPath = Join-Path $repoRoot 'test-results' 'method-status.json'

if (-not (Test-Path -LiteralPath $schemaPath)) {
  throw "Missing protocol schema: $schemaPath"
}
if (-not (Test-Path -LiteralPath $indexPath)) {
  throw "Missing method-case index: $indexPath"
}

$schema = Get-Content -LiteralPath $schemaPath -Raw | ConvertFrom-Json
$enumMethods = @($schema.definitions.jsonRpcRequest.properties.method.enum)
$index = Get-Content -LiteralPath $indexPath -Raw | ConvertFrom-Json -AsHashtable
$statusByMethod = @{}

if (Test-Path -LiteralPath $statusPath) {
  $statusRaw = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json -AsHashtable
  foreach ($item in $statusRaw.GetEnumerator()) {
    $statusByMethod[$item.Key] = [string]$item.Value
  }
}

$now = Get-Date -Format "yyyy-MM-dd HH:mm:ss K"
$lines = @()
$lines += '# E2E Matrix'
$lines += ''
$lines += "- GeneratedAt: $now"
$lines += '- ProtocolSchema: `packages/protocol/schemas/protocol.schema.json`'
$lines += ''
$lines += '| Method | Success Case | Failure Case | Covered | CI Status |'
$lines += '| --- | --- | --- | --- | --- |'

$missing = @()
foreach ($method in ($enumMethods | Sort-Object)) {
  if (-not $index.ContainsKey($method)) {
    $missing += $method
    $lines += "| $method | - | - | false | MissingCaseId |"
    continue
  }

  $item = $index[$method]
  $successCase = [string]$item.successCaseId
  $failureCase = [string]$item.failureCaseId
  $covered = ([string][bool]($successCase -and $failureCase)).ToLowerInvariant()
  $status = if ($statusByMethod.ContainsKey($method)) { $statusByMethod[$method] } else { 'NotRun' }
  $lines += "| $method | $successCase | $failureCase | $covered | $status |"
}

$lines += ''
$lines += "Total methods: $($enumMethods.Count)"
$lines += "Missing mappings: $($missing.Count)"

$content = ($lines -join [Environment]::NewLine) + [Environment]::NewLine
Set-Content -LiteralPath $outputPath -Value $content -Encoding UTF8

if ($env:BAK_ENFORCE_E2E_COVERAGE -eq '1' -and $missing.Count -gt 0) {
  throw "E2E matrix has uncovered methods: $($missing -join ', ')"
}
