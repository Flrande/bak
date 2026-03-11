$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..' '..')
$statusPath = Join-Path $repoRoot 'test-results' 'method-status.json'

if (Test-Path -LiteralPath $statusPath) {
  Remove-Item -LiteralPath $statusPath -Force
}
