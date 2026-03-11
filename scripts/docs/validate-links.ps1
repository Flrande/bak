$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..' '..')
$docsRoot = Join-Path $repoRoot 'docs'
$archiveRoot = Join-Path $docsRoot 'archive'
$quickstartPath = Join-Path $docsRoot 'user' 'quickstart.md'
$readmePath = Join-Path $repoRoot 'README.md'
$skillsRoot = Join-Path $repoRoot 'skills'

if (-not (Test-Path -LiteralPath $docsRoot)) {
  throw "Missing docs directory: $docsRoot"
}

if (-not (Test-Path -LiteralPath $quickstartPath)) {
  throw "Missing quickstart guide: $quickstartPath"
}

$currentDocFiles = Get-ChildItem -LiteralPath $docsRoot -Recurse -File -Filter *.md | Where-Object {
  -not $_.FullName.StartsWith($archiveRoot, [System.StringComparison]::OrdinalIgnoreCase)
}

$scanFiles = @(
  (Get-Item -LiteralPath $readmePath)
  $currentDocFiles
)

if (Test-Path -LiteralPath $skillsRoot) {
  $scanFiles += Get-ChildItem -LiteralPath $skillsRoot -Recurse -File -Filter *.md
}

$linkPattern = [regex]'\[[^\]]+\]\(([^)]+)\)'
$brokenLinks = @()
$stalePatterns = @(
  @{ Pattern = '(?i)\blegacy\b'; Label = 'legacy wording' }
  @{ Pattern = '(?i)\bProtocol v2\b'; Label = 'older protocol branding' }
  @{ Pattern = '(?i)PROTOCOL_V2'; Label = 'archived protocol reference' }
  @{ Pattern = '(?i)\bold CLI version\b'; Label = 'old-version troubleshooting' }
  @{ Pattern = '(?i)\bjson backend\b'; Label = 'non-current backend wording' }
  @{ Pattern = '(?i)\bbackend is `json`\b'; Label = 'non-current backend statement' }
  @{ Pattern = '(?i)\bremoved `v2`\b'; Label = 'older implementation narrative' }
)
$staleMatches = @()

foreach ($file in $scanFiles) {
  $content = Get-Content -LiteralPath $file.FullName -Raw
  $matches = $linkPattern.Matches($content)

  foreach ($match in $matches) {
    $rawTarget = [string]$match.Groups[1].Value.Trim()
    if ([string]::IsNullOrWhiteSpace($rawTarget)) {
      continue
    }

    if (
      $rawTarget.StartsWith('http://') -or
      $rawTarget.StartsWith('https://') -or
      $rawTarget.StartsWith('mailto:') -or
      $rawTarget.StartsWith('#')
    ) {
      continue
    }

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
      $brokenLinks += [pscustomobject]@{
        File = $file.FullName
        Target = $rawTarget
        Resolved = $resolved
      }
    }
  }

  foreach ($pattern in $stalePatterns) {
    foreach ($hit in [regex]::Matches($content, [string]$pattern.Pattern)) {
      $lineNumber = ($content.Substring(0, $hit.Index) -split "`r?`n").Count
      $lineText = (Get-Content -LiteralPath $file.FullName)[$lineNumber - 1].Trim()
      $staleMatches += [pscustomobject]@{
        File = $file.FullName
        LineNumber = $lineNumber
        Label = $pattern.Label
        Line = $lineText
      }
    }
  }
}

$quickstartContent = Get-Content -LiteralPath $quickstartPath -Raw
$bootstrapMarkerPattern = '(?im)<!--\s*BAK_BOOTSTRAP_SCRIPT_URL:\s*https?://[^\s>]+\s*-->'
if (-not [regex]::IsMatch($quickstartContent, $bootstrapMarkerPattern)) {
  throw "Missing BAK_BOOTSTRAP_SCRIPT_URL marker in $quickstartPath"
}

if ($brokenLinks.Count -gt 0) {
  Write-Host 'Broken documentation links found:'
  foreach ($problem in $brokenLinks) {
    Write-Host "- $($problem.File) -> $($problem.Target) (resolved: $($problem.Resolved))"
  }
  throw "Documentation link validation failed with $($brokenLinks.Count) issue(s)."
}

if ($staleMatches.Count -gt 0) {
  Write-Host 'Current docs contain stale wording or removed command references:'
  foreach ($match in $staleMatches) {
    Write-Host "- $($match.File):$($match.LineNumber) [$($match.Label)] $($match.Line)"
  }
  throw "Documentation hygiene validation failed with $($staleMatches.Count) issue(s)."
}

Write-Host "Documentation validated: $($scanFiles.Count) markdown files scanned."
