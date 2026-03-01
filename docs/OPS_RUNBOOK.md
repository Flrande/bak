# OPS RUNBOOK (v1)

## Quick health check

```powershell
pnpm --filter @bak/cli exec bak doctor
```

Checks:
- dataDir writable
- memory backend availability (`requestedBackend/actual backend/fallback reason`)
- healing telemetry trend (`healingTelemetry`, warns when recent failure rate is elevated)
- pairing token presence
- bridge/rpc port availability
- `session.info` reachability
- extension connection health (`connected/disconnected`, `heartbeatStale`, `heartbeatAgeMs`)
- active tab telemetry availability (`activeTabTelemetry`, non-blocking warning)
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
pnpm --filter @bak/cli exec bak pair
pnpm --filter @bak/cli exec bak pair status
pnpm --filter @bak/cli exec bak pair revoke --reason "rotation"
```

## Retention cleanup

```powershell
# preview
pnpm --filter @bak/cli exec bak gc

# execute
pnpm --filter @bak/cli exec bak gc --trace-days 7 --snapshot-days 7 --force
```

## Diagnostic package export

```powershell
# all traces/snapshots
pnpm --filter @bak/cli exec bak export

# single trace package
pnpm --filter @bak/cli exec bak export --trace-id <traceId> --out ./.bak-data/diag.zip

# include redacted memory payload (opt-in)
pnpm --filter @bak/cli exec bak export --include-memory --memory-backend json
```

`bak export` produces a redacted zip package containing:
- `index.json` (content manifest and export timestamp)
- `healing-summary.json` (optional aggregate of `memory.healing` trace events)
- trace jsonl files (redacted)
- snapshot folders
- policy file (if present)
- `doctor.json` (runtime diagnostics snapshot)
- `memory.json` (optional, redacted, only when `--include-memory`)
- runtime version metadata

The command result and `index.json` both include `warnings` for non-blocking issues (for example version drift or memory export fallback).

## CI / nightly e2e notes

- `.github/workflows/e2e-nightly.yml` uploads `playwright-report` and `test-results` artifacts on every run (`if: always()`), so failures keep diagnostics.

## Memory backend operations

```powershell
# migrate json -> sqlite
pnpm --filter @bak/cli exec bak memory migrate

# export backend payload
pnpm --filter @bak/cli exec bak memory export --backend sqlite
```
