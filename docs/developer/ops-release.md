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
pnpm -w release:gate
```

`release:gate` is the blocking ship decision. It regenerates `docs/RELEASE_CAPABILITY_REPORT.md` and fails only when the tracked release scope is not fully mapped and passing in the current E2E matrix snapshot.

## Full Regression Visibility

Run this when you want a refreshed whole-surface coverage snapshot:

```powershell
pnpm -w test:e2e:full
pnpm -w e2e:matrix
pnpm -w release:report
```

`release:report` is informational. It keeps the report up to date and shows both:

- `ReleaseGate`: the blocking ship gate for the tracked release scope
- `FullCoverageGate`: the non-blocking method-level real e2e completion signal across the whole protocol surface

## Generated Artifacts

- capability matrix: `docs/CAPABILITY_MATRIX.md`
- E2E matrix: `docs/E2E_MATRIX.md`
- release gate summary: `docs/RELEASE_CAPABILITY_REPORT.md`
- local method execution status input: `test-results/method-status.json`
- tracked current release scope input: `tests/e2e/methods/release-scope.json`

Keep these output paths stable because scripts write to them directly:

- `scripts/e2e/generate-matrix.ps1`
- `scripts/release/generate-capability-report.ps1`

The E2E matrix and release report always reflect the latest `test-results/method-status.json` snapshot. In practice, that means the last e2e suite you ran determines which methods appear as `Passed` versus `NotRun`.
