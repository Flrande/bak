# OPS RUNBOOK (v1)

This legacy page is kept for compatibility. Prefer [docs/developer/ops-release.md](../developer/ops-release.md).

## Quick health check

Build artifacts once before running CLI commands:

```powershell
pnpm build
```

```powershell
node packages/cli/dist/bin.js doctor
```

Checks:
- dataDir writable
- pairing token presence
- bridge/rpc port availability
- `session.info` reachability
- extension connection health (`connected/disconnected`, `heartbeatStale`, `heartbeatAgeMs`)
- active tab telemetry availability (`activeTabTelemetry`, non-blocking warning)
- protocol compatibility between daemon and rpc payload (`protocolCompatibility`, non-blocking warning)
- extension runtime version reported by bridge handshake (`extensionVersion`)
- cli/extension version compatibility drift check (`versionCompatibility`, `severity=warn` and non-blocking)

Doctor output also includes:
- `summary.errorChecks` (blocking failures)
- `summary.warningChecks` (non-blocking warnings)

Extension popup state (`bak.getState`) also exposes reconnect diagnostics:
- `lastError` / `lastErrorContext` / `lastErrorAt`
- `reconnectAttempt`
- `nextReconnectInMs`

## Pair token lifecycle

```powershell
node packages/cli/dist/bin.js pair
node packages/cli/dist/bin.js pair status
node packages/cli/dist/bin.js pair revoke --reason "rotation"
```

## Retention cleanup

```powershell
# preview
node packages/cli/dist/bin.js gc

# execute
node packages/cli/dist/bin.js gc --trace-days 7 --snapshot-days 7 --force
```

## Diagnostic package export

```powershell
# all traces (snapshot images excluded by default)
node packages/cli/dist/bin.js export

$bakDataDir = Join-Path $env:LOCALAPPDATA 'bak'

# single trace package
node packages/cli/dist/bin.js export --trace-id <traceId> --out (Join-Path $bakDataDir 'diag.zip')

# include raw snapshot image folders explicitly
node packages/cli/dist/bin.js export --trace-id <traceId> --include-snapshots --out (Join-Path $bakDataDir 'diag-with-images.zip')
```

`bak export` produces a redacted zip package containing:
- `index.json` (content manifest and export timestamp)
- trace jsonl files (redacted)
- snapshot folders (optional, only when `--include-snapshots`)
- policy file (if present)
- `doctor.json` (runtime diagnostics snapshot)
- runtime version metadata

The command result and `index.json` both include `warnings` for non-blocking issues (for example protocol/version drift).

## CI notes

- `.github/workflows/ci.yml` runs full quality checks on `push`/`pull_request` and uploads `test-results` artifacts on every run (`if: always()`), so failures keep diagnostics.
