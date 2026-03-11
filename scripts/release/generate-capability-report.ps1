$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..' '..')
$capabilityPath = Join-Path $repoRoot 'docs' 'CAPABILITY_MATRIX.md'
$e2ePath = Join-Path $repoRoot 'docs' 'E2E_MATRIX.md'
$scopePath = Join-Path $repoRoot 'tests' 'e2e' 'methods' 'release-scope.json'
$outputPath = Join-Path $repoRoot 'docs' 'RELEASE_CAPABILITY_REPORT.md'

if (-not (Test-Path -LiteralPath $capabilityPath)) {
  throw "Missing capability matrix: $capabilityPath"
}
if (-not (Test-Path -LiteralPath $e2ePath)) {
  throw "Missing e2e matrix: $e2ePath"
}
if (-not (Test-Path -LiteralPath $scopePath)) {
  throw "Missing release scope definition: $scopePath"
}

function ConvertFrom-MarkdownRow {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Line
  )

  $trimmed = $Line.Trim()
  if (-not $trimmed.StartsWith('|')) {
    return $null
  }

  return $trimmed.Trim('|').Split('|') | ForEach-Object { $_.Trim() }
}

$capabilityLines = Get-Content -LiteralPath $capabilityPath
$e2eLines = Get-Content -LiteralPath $e2ePath
$scope = Get-Content -LiteralPath $scopePath -Raw | ConvertFrom-Json

$capabilityRows = $capabilityLines | Where-Object {
  $_ -match '^\| [^ ]' -and
  $_ -notmatch '^\| ---' -and
  $_ -notmatch '^\| Domain \|'
}
$e2eRows = $e2eLines | Where-Object {
  $_ -match '^\| [^ ]' -and
  $_ -notmatch '^\| ---' -and
  $_ -notmatch '^\| Method \|'
}
$e2eEntries = @(
  foreach ($line in $e2eRows) {
    $columns = ConvertFrom-MarkdownRow -Line $line
    if ($null -eq $columns -or $columns.Count -lt 5) {
      continue
    }

    [pscustomobject]@{
      Method = [string]$columns[0]
      SuccessCase = [string]$columns[1]
      FailureCase = [string]$columns[2]
      CaseMapped = [string]$columns[3]
      Status = [string]$columns[4]
    }
  }
)
$scopeMethods = @($scope.methods | Where-Object { $_ })
$scopeEntries = @(
  foreach ($method in $scopeMethods) {
    $entry = $e2eEntries | Where-Object { $_.Method -eq $method } | Select-Object -First 1
    if ($null -ne $entry) {
      $entry
    }
  }
)
$scopeMissing = @($scopeMethods | Where-Object { $scopeEntries.Method -notcontains $_ })

$stableCount = ($capabilityRows | Where-Object { $_ -match '\| stable \|' }).Count
$betaCount = ($capabilityRows | Where-Object { $_ -match '\| beta \|' }).Count
$experimentalCount = ($capabilityRows | Where-Object { $_ -match '\| experimental \|' }).Count
$mappedCount = ($e2eEntries | Where-Object { $_.CaseMapped -eq 'true' }).Count
$notRunCount = ($e2eEntries | Where-Object { $_.Status -eq 'NotRun' }).Count
$passCount = ($e2eEntries | Where-Object { $_.Status -match '^Pass(ed)?$' }).Count
$runCount = $e2eEntries.Count - $notRunCount
$failedCount = [Math]::Max(0, $runCount - $passCount)
$releaseReady = ($passCount -eq $e2eRows.Count) -and ($notRunCount -eq 0)
$scopeMappedCount = ($scopeEntries | Where-Object { $_.CaseMapped -eq 'true' }).Count
$scopeNotRunCount = ($scopeEntries | Where-Object { $_.Status -eq 'NotRun' }).Count
$scopePassCount = ($scopeEntries | Where-Object { $_.Status -match '^Pass(ed)?$' }).Count
$scopeFailedCount = [Math]::Max(0, $scopeEntries.Count - $scopeNotRunCount - $scopePassCount)
$scopeReady = ($scopeMethods.Count -gt 0) -and ($scopeMissing.Count -eq 0) -and ($scopePassCount -eq $scopeMethods.Count) -and ($scopeNotRunCount -eq 0) -and ($scopeFailedCount -eq 0)

$now = Get-Date -Format "yyyy-MM-dd HH:mm:ss K"
$lines = @()
$lines += '# Release Capability Report'
$lines += ''
$lines += "- GeneratedAt: $now"
$lines += "- TotalCapabilities: $($capabilityRows.Count)"
$lines += "- StabilityBreakdown: stable=$stableCount beta=$betaCount experimental=$experimentalCount"
$lines += "- E2ECaseMapped: $mappedCount / $($e2eRows.Count)"
$lines += "- E2EExecutionStatus: passed=$passCount failed=$failedCount notRun=$notRunCount"
$lines += "- CurrentScope: $($scope.name)"
$lines += "- CurrentScopeCoverage: mapped=$scopeMappedCount / $($scopeMethods.Count) passed=$scopePassCount failed=$scopeFailedCount notRun=$scopeNotRunCount missing=$($scopeMissing.Count)"
$lines += "- CurrentScopeGate: $(if ($scopeReady) { 'pass' } else { 'fail' })"
$lines += "- ReleaseGate: $(if ($releaseReady) { 'pass' } else { 'fail (real e2e not complete)' })"
$lines += ''
$lines += '## Sources'
$lines += ''
$lines += '- `docs/CAPABILITY_MATRIX.md`'
$lines += '- `docs/E2E_MATRIX.md`'
$lines += '- `tests/e2e/methods/release-scope.json`'
$lines += ''
$lines += '## Gate Summary'
$lines += ''
$lines += '- New methods must have matrix mapping and method-level e2e case IDs.'
$lines += '- The current release scope passes only when every scoped method is mapped and has `CI Status=Passed` in the E2E matrix.'
$lines += '- Release requires regenerated capability/e2e matrices, this report, and all mapped e2e cases executed with `CI Status=Passed`.'

Set-Content -LiteralPath $outputPath -Value (($lines -join [Environment]::NewLine) + [Environment]::NewLine) -Encoding UTF8
