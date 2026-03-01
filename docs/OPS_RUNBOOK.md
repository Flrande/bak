# OPS RUNBOOK (v1)

## Quick health check

```powershell
pnpm --filter @bak/cli exec bak doctor
```

Checks:
- dataDir writable
- pairing token presence
- bridge/rpc port availability
- `session.info` reachability
- extension connection health (`connected/disconnected`, `heartbeatStale`, `heartbeatAgeMs`)
- extension runtime version reported by bridge handshake (`extensionVersion`)

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
```

`bak export` produces a redacted zip package containing:
- trace jsonl files (redacted)
- snapshot folders
- policy file (if present)
- `doctor.json` (runtime diagnostics snapshot)
- runtime version metadata

## Memory backend operations

```powershell
# migrate json -> sqlite
pnpm --filter @bak/cli exec bak memory migrate

# export backend payload
pnpm --filter @bak/cli exec bak memory export --backend sqlite
```
