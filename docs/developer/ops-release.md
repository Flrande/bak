# Ops And Release

## Local Operations

Build artifacts before using the packaged CLI directly:

```powershell
pnpm build
node packages/cli/dist/bin.js doctor --port 17373 --rpc-ws-port 17374
```

Useful runtime commands:

```powershell
node packages/cli/dist/bin.js pair status
$bakDataDir = Join-Path $env:LOCALAPPDATA 'bak'
node packages/cli/dist/bin.js export --out (Join-Path $bakDataDir 'diag.zip')
node packages/cli/dist/bin.js gc
```

## Pre-Release Gates

```powershell
pnpm -w typecheck
pnpm -w lint
pnpm -w test:unit
pnpm -w test:e2e:critical
pnpm -w e2e:matrix
pnpm -w release:report
```

Full regression run:

```powershell
pnpm -w test:e2e:full
```

## Generated Artifacts

- capability matrix: `docs/CAPABILITY_MATRIX.md`
- E2E matrix: `docs/E2E_MATRIX.md`
- release gate summary: `docs/RELEASE_CAPABILITY_REPORT.md`

Keep these output paths stable because scripts write to them directly:

- `scripts/e2e/generate-matrix.ps1`
- `scripts/release/generate-capability-report.ps1`
