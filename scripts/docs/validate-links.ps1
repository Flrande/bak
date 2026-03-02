$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..' '..')
$docsRoot = Join-Path $repoRoot 'docs'

if (-not (Test-Path -LiteralPath $docsRoot)) {
  throw "Missing docs directory: $docsRoot"
}

$mdFiles = Get-ChildItem -LiteralPath $docsRoot -Recurse -File -Filter *.md
$linkPattern = [regex]'\[[^\]]+\]\(([^)]+)\)'
$problems = @()

foreach ($file in $mdFiles) {
  $content = Get-Content -LiteralPath $file.FullName -Raw
  $matches = $linkPattern.Matches($content)

  foreach ($match in $matches) {
    $rawTarget = [string]$match.Groups[1].Value.Trim()
    if ([string]::IsNullOrWhiteSpace($rawTarget)) {
      continue
    }

    # Ignore absolute URLs, mailto links, and in-page anchors.
    if (
      $rawTarget.StartsWith('http://') -or
      $rawTarget.StartsWith('https://') -or
      $rawTarget.StartsWith('mailto:') -or
      $rawTarget.StartsWith('#')
    ) {
      continue
    }

    # Ignore Windows absolute paths and repo-absolute targets.
    if ($rawTarget -match '^[A-Za-z]:\\' -or $rawTarget.StartsWith('/')) {
      continue
    }

    $targetNoFragment = $rawTarget.Split('#')[0]
    $targetNoQuery = $targetNoFragment.Split('?')[0]
    if ([string]::IsNullOrWhiteSpace($targetNoQuery)) {
      continue
    }

    $resolved = Join-Path $file.DirectoryName $targetNoQuery
    if (-not (Test-Path -LiteralPath $resolved)) {
      $problems += [pscustomobject]@{
        File = $file.FullName
        Target = $rawTarget
        Resolved = $resolved
      }
    }
  }
}

if ($problems.Count -gt 0) {
  Write-Host 'Broken documentation links found:'
  foreach ($problem in $problems) {
    Write-Host "- $($problem.File) -> $($problem.Target) (resolved: $($problem.Resolved))"
  }
  throw "Documentation link validation failed with $($problems.Count) issue(s)."
}

Write-Host "Documentation links validated: $($mdFiles.Count) markdown files scanned."
