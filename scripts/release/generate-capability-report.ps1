$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..' '..')
$capabilityPath = Join-Path $repoRoot 'docs' 'CAPABILITY_MATRIX.md'
$e2ePath = Join-Path $repoRoot 'docs' 'E2E_MATRIX.md'
$outputPath = Join-Path $repoRoot 'docs' 'RELEASE_CAPABILITY_REPORT.md'

if (-not (Test-Path -LiteralPath $capabilityPath)) {
  throw "Missing capability matrix: $capabilityPath"
}
if (-not (Test-Path -LiteralPath $e2ePath)) {
  throw "Missing e2e matrix: $e2ePath"
}

$capabilityLines = Get-Content -LiteralPath $capabilityPath
$e2eLines = Get-Content -LiteralPath $e2ePath

$capabilityRows = $capabilityLines | Where-Object { $_ -match '^\| [^ ]' -and $_ -notmatch '^\| ---' }
$e2eRows = $e2eLines | Where-Object { $_ -match '^\| [^ ]' -and $_ -notmatch '^\| ---' }

$stableCount = ($capabilityRows | Where-Object { $_ -match '\| stable \|' }).Count
$betaCount = ($capabilityRows | Where-Object { $_ -match '\| beta \|' }).Count
$experimentalCount = ($capabilityRows | Where-Object { $_ -match '\| experimental \|' }).Count
$mappedCount = ($e2eRows | Where-Object { $_ -match '\| true \|' }).Count
$notRunCount = ($e2eRows | Where-Object { $_ -match '\| NotRun \|' }).Count
$passCount = ($e2eRows | Where-Object { $_ -match '\| Pass(ed)? \|' }).Count
$runCount = $e2eRows.Count - $notRunCount
$failedCount = [Math]::Max(0, $runCount - $passCount)
$releaseReady = ($passCount -eq $e2eRows.Count) -and ($notRunCount -eq 0)

$now = Get-Date -Format "yyyy-MM-dd HH:mm:ss K"
$lines = @()
$lines += '# Release Capability Report'
$lines += ''
$lines += "- GeneratedAt: $now"
$lines += "- TotalCapabilities: $($capabilityRows.Count)"
$lines += "- StabilityBreakdown: stable=$stableCount beta=$betaCount experimental=$experimentalCount"
$lines += "- E2ECaseMapped: $mappedCount / $($e2eRows.Count)"
$lines += "- E2EExecutionStatus: passed=$passCount failed=$failedCount notRun=$notRunCount"
$lines += "- ReleaseGate: $(if ($releaseReady) { 'pass' } else { 'fail (real e2e not complete)' })"
$lines += ''
$lines += '## Sources'
$lines += ''
$lines += '- `docs/CAPABILITY_MATRIX.md`'
$lines += '- `docs/E2E_MATRIX.md`'
$lines += ''
$lines += '## Gate Summary'
$lines += ''
$lines += '- New methods must have matrix mapping and method-level e2e case IDs.'
$lines += '- Release requires regenerated capability/e2e matrices, this report, and all mapped e2e cases executed with `CI Status=Passed`.'

Set-Content -LiteralPath $outputPath -Value (($lines -join [Environment]::NewLine) + [Environment]::NewLine) -Encoding UTF8
